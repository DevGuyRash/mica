import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { Gzip, gzipSync, strToU8 } from "fflate";

// Like smoke.mjs, this fixture requires this candidate's freshly built core.
// Storage paths, identities and hashes must come from Rust rather than a mock policy.
const bundle = await build({
	stdin: {
		contents: `
			export * from "./src/storage/sidecar.ts";
			export { bindNoteStore, storeRoot } from "./src/storage/store.ts";
			export { coreVersion, hashContent, initCore, setNoteId } from "./src/wasm/bridge.ts";
		`,
		resolveDir: path.resolve("."),
		loader: "ts",
	},
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22.12",
	loader: { ".wasm": "binary" },
	write: false,
	plugins: [
		{
			name: "sidecar-test-boundaries",
			setup(buildApi) {
				buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "mica-test" }));
				buildApi.onLoad({ filter: /^obsidian$/, namespace: "mica-test" }, () => ({
					loader: "js",
					contents: `
						export function normalizePath(value) { return value.replaceAll("\\\\", "/"); }
						export class TFile {
							constructor(path, size = 0) {
								this.path = path;
								this.extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
								this.stat = { size, mtime: 0 };
							}
						}
						export class TFolder {
							constructor(path) { this.path = path; this.children = []; }
						}
						globalThis.__micaTestTFile = TFile;
						globalThis.__micaTestTFolder = TFolder;
					`,
				}));
			},
		},
	],
});

const source = bundle.outputFiles[0]?.text;
assert.ok(source, "sidecar fallback test bundle must be generated");
const sidecar = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const TFile = globalThis.__micaTestTFile;
const TFolder = globalThis.__micaTestTFolder;
assert.equal(typeof TFile, "function", "test boundary must expose the mocked TFile class");
assert.equal(typeof TFolder, "function", "test boundary must expose the mocked TFolder class");
await sidecar.initCore();
const candidate = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(sidecar.coreVersion(), candidate.version, "fallback fixture must use this candidate's generated WASM");

class MockVault {
	#files = new Map();
	#clock = 0;
	processCalls = 0;

	getAllLoadedFiles() {
		return [...this.#files.values()];
	}

	getMarkdownFiles() {
		return this.getAllLoadedFiles().filter((file) => file instanceof TFile && file.extension === "md");
	}

	#add(file) {
		if (this.#files.has(file.path)) throw new Error(`fixture path already exists: ${file.path}`);
		file.vault = this;
		const parentPath = file.path.slice(0, file.path.lastIndexOf("/") + 1).replace(/\/$/, "");
		if (parentPath) {
			const parent = this.#files.get(parentPath);
			assert.ok(parent instanceof TFolder, `fixture parent must exist: ${parentPath}`);
			parent.children.push(file);
		}
		if (file instanceof TFile) file.stat.mtime = ++this.#clock;
		this.#files.set(file.path, file);
		return file;
	}

	async createFolder(filePath) {
		return this.#add(new TFolder(filePath));
	}

	getAbstractFileByPath(filePath) {
		return this.#files.get(filePath) ?? null;
	}

	async create(filePath, content) {
		const file = new TFile(filePath, Buffer.byteLength(content));
		file.text = content;
		return this.#add(file);
	}

	async createBinary(filePath, content) {
		return this.putBinary(filePath, new Uint8Array(content));
	}

	putBinary(filePath, content) {
		const bytes = new Uint8Array(content);
		const file = new TFile(filePath, bytes.byteLength);
		file.bytes = bytes;
		return this.#add(file);
	}

	async read(file) {
		return file.text;
	}

	async process(file, update) {
		this.processCalls += 1;
		file.text = update(file.text);
		file.stat.size = Buffer.byteLength(file.text);
		file.stat.mtime = ++this.#clock;
		return file.text;
	}

	async readBinary(file) {
		return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
	}
}

async function fixtureStore() {
	const vault = new MockVault();
	const text = sidecar.setNoteId("fallback fixture\n", null, "note-id");
	const file = await vault.create("Fallback.md", text);
	const store = await sidecar.bindNoteStore(sidecar.storeRoot(vault), file, text, { write: true });
	assert.ok(store, "anchored fixture must bind a central note store");
	return { vault, store };
}

function gzipZeroes(mebibytes) {
	const chunks = [];
	const gzip = new Gzip({ level: 9 }, (chunk) => chunks.push(chunk));
	const zeroes = new Uint8Array(1024 * 1024);
	for (let index = 0; index < mebibytes; index += 1) gzip.push(zeroes, index === mebibytes - 1);
	const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const output = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CompressionStream");
const decompressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream");
Object.defineProperty(globalThis, "CompressionStream", { configurable: true, value: undefined });
Object.defineProperty(globalThis, "DecompressionStream", { configurable: true, value: undefined });

try {
	const content = "portable gzip fallback\n".repeat(256);
	const hash = sidecar.hashContent(content);

	const { vault: roundTripVault, store: roundTripStore } = await fixtureStore();
	await sidecar.writeObject(roundTripStore, hash, content);
	assert.ok(
		roundTripVault.getAbstractFileByPath(sidecar.objectPathGz(roundTripStore.root, hash)) instanceof TFile,
		"portable fallback must write large shared objects in the same gzip format as the native host",
	);
	assert.equal(await sidecar.readObject(roundTripStore, hash), content);

	const { vault: corruptVault, store: corruptStore } = await fixtureStore();
	const validGzip = gzipSync(strToU8(content));
	await sidecar.ensureSidecar(corruptStore);
	corruptVault.putBinary(sidecar.objectPathGz(corruptStore.root, hash), validGzip.subarray(0, 6));
	await assert.rejects(() => sidecar.readObject(corruptStore, hash), /invalid|unexpected|corrupt|hash/i);

	const { vault: oversizedVault, store: oversizedStore } = await fixtureStore();
	await sidecar.ensureSidecar(oversizedStore);
	oversizedVault.putBinary(sidecar.objectPathGz(oversizedStore.root, hash), gzipZeroes(129));
	await assert.rejects(
		() => sidecar.readObject(oversizedStore, hash),
		/decompressed history object exceeds 134217728 bytes/,
	);

	const { vault: manifestVault, store: manifestStore } = await fixtureStore();
	manifestVault.processCalls = 0; // Count manifest refreshes independently of locator initialization.
	const firstManifest = { noteId: "note-id", path: "Fallback.md", blocks: { block: "Before" }, updated: 1 };
	assert.equal(await sidecar.writeManifest(manifestStore, firstManifest), true);
	assert.equal(
		await sidecar.writeManifest(manifestStore, { ...firstManifest, updated: 2 }),
		false,
		"a timestamp-only refresh must not rewrite an unchanged manifest",
	);
	assert.equal(manifestVault.processCalls, 0);
	assert.equal(
		await sidecar.writeManifest(manifestStore, {
			...firstManifest,
			blocks: { block: "After" },
			updated: 3,
		}),
		true,
	);
	assert.equal(manifestVault.processCalls, 1, "a block-name change must refresh the manifest");
	assert.equal(
		await sidecar.writeManifest(manifestStore, {
			...firstManifest,
			blocks: { first: "One", second: "Two" },
			updated: 4,
		}),
		true,
	);
	assert.equal(
		await sidecar.writeManifest(manifestStore, {
			...firstManifest,
			blocks: { second: "Two", first: "One" },
			updated: 5,
		}),
		true,
		"block order is semantic and must still trigger a manifest refresh",
	);
} finally {
	if (compressionDescriptor) Object.defineProperty(globalThis, "CompressionStream", compressionDescriptor);
	else delete globalThis.CompressionStream;
	if (decompressionDescriptor) Object.defineProperty(globalThis, "DecompressionStream", decompressionDescriptor);
	else delete globalThis.DecompressionStream;
	delete globalThis.__micaTestTFile;
	delete globalThis.__micaTestTFolder;
}

console.log("SIDECAR FALLBACK OK — portable gzip safety and idempotent manifest refresh verified");
