import assert from "node:assert/strict";
import path from "node:path";
import { build } from "esbuild";
import { Gzip, gzipSync, strToU8 } from "fflate";

const HASH = "b3:0000000000000000";
const sidecarEntry = path.resolve("src/storage/sidecar.ts");

const bundle = await build({
	entryPoints: [sidecarEntry],
	bundle: true,
	format: "esm",
	platform: "node",
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
								this.stat = { size };
							}
						}
						export class TFolder {}
						globalThis.__micaTestTFile = TFile;
					`,
				}));
				buildApi.onResolve({ filter: /^\.\.\/wasm\/bridge$/ }, () => ({
					path: "bridge",
					namespace: "mica-test",
				}));
				buildApi.onLoad({ filter: /^bridge$/, namespace: "mica-test" }, () => ({
					loader: "js",
					contents: `
						export function hashContent(content) {
							return content === globalThis.__micaExpectedContent
								? "${HASH}"
								: "b3:ffffffffffffffff";
						}
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
assert.equal(typeof TFile, "function", "test boundary must expose the mocked TFile class");

class MockVault {
	#files = new Map();
	processCalls = 0;

	getAbstractFileByPath(filePath) {
		return this.#files.get(filePath) ?? null;
	}

	async create(filePath, content) {
		const file = new TFile(filePath, Buffer.byteLength(content));
		file.text = content;
		this.#files.set(filePath, file);
		return file;
	}

	async createBinary(filePath, content) {
		return this.putBinary(filePath, new Uint8Array(content));
	}

	putBinary(filePath, content) {
		const bytes = new Uint8Array(content);
		const file = new TFile(filePath, bytes.byteLength);
		file.bytes = bytes;
		this.#files.set(filePath, file);
		return file;
	}

	async read(file) {
		return file.text;
	}

	async process(file, update) {
		this.processCalls += 1;
		file.text = update(file.text);
		file.stat.size = Buffer.byteLength(file.text);
		return file.text;
	}

	async readBinary(file) {
		return file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
	}
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
	const note = new TFile("Fallback.md");
	const content = "portable gzip fallback\n".repeat(256);
	globalThis.__micaExpectedContent = content;

	const roundTripVault = new MockVault();
	await sidecar.writeObject(roundTripVault, note, HASH, content);
	assert.ok(
		roundTripVault.getAbstractFileByPath(sidecar.objectPath(note, HASH)) instanceof TFile,
		"fallback must avoid synchronous main-thread compression and write portable plaintext",
	);
	assert.equal(await sidecar.readObject(roundTripVault, note, HASH), content);

	const corruptVault = new MockVault();
	const validGzip = gzipSync(strToU8(content));
	corruptVault.putBinary(sidecar.objectPathGz(note, HASH), validGzip.subarray(0, 6));
	await assert.rejects(() => sidecar.readObject(corruptVault, note, HASH), /invalid|unexpected|corrupt|hash/i);

	const oversizedVault = new MockVault();
	oversizedVault.putBinary(sidecar.objectPathGz(note, HASH), gzipZeroes(129));
	await assert.rejects(
		() => sidecar.readObject(oversizedVault, note, HASH),
		/decompressed history object exceeds 134217728 bytes/,
	);

	const manifestVault = new MockVault();
	const firstManifest = { noteId: "note-id", path: "Fallback.md", blocks: { block: "Before" }, updated: 1 };
	assert.equal(await sidecar.writeManifest(manifestVault, note, firstManifest), true);
	assert.equal(
		await sidecar.writeManifest(manifestVault, note, { ...firstManifest, updated: 2 }),
		false,
		"a timestamp-only refresh must not rewrite an unchanged manifest",
	);
	assert.equal(manifestVault.processCalls, 0);
	assert.equal(
		await sidecar.writeManifest(manifestVault, note, {
			...firstManifest,
			blocks: { block: "After" },
			updated: 3,
		}),
		true,
	);
	assert.equal(manifestVault.processCalls, 1, "a block-name change must refresh the manifest");
} finally {
	if (compressionDescriptor) Object.defineProperty(globalThis, "CompressionStream", compressionDescriptor);
	else delete globalThis.CompressionStream;
	if (decompressionDescriptor) Object.defineProperty(globalThis, "DecompressionStream", decompressionDescriptor);
	else delete globalThis.DecompressionStream;
	delete globalThis.__micaExpectedContent;
	delete globalThis.__micaTestTFile;
}

console.log("SIDECAR FALLBACK OK — plaintext/gzip safety and idempotent manifest refresh verified");
