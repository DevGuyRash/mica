import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import type { TFile as ObsidianFile, Vault } from "obsidian";
import type MicaPlugin from "../src/main.ts";
import type * as Core from "../src/wasm/bridge.ts";
import type * as Host from "./fixtures/startup-host.mts";

type Runtime = typeof Core & typeof Host & { MicaPlugin: new (app: unknown) => MicaPlugin & Host.Plugin };
const fixturePath = path.resolve("tests/fixtures/startup-host.mts");
const bundle = await build({
	stdin: {
		contents: `export { default as MicaPlugin } from "./src/main.ts";
			export * from "./src/wasm/bridge.ts";
			export * from "./tests/fixtures/startup-host.mts";`,
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
			name: "startup-host-boundaries",
			setup(buildApi) {
				buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: fixturePath }));
				buildApi.onResolve(
					{
						filter: /\/(?:ui\/(?:quickEdit|mdEditor|toolSpec|toolbarView|actionMenu|responsiveActionStrip|versionsModal)|cm\/(?:micaLivePreview|micaSourceHighlight)|render\/readingRenderer|api\/mica)$/,
					},
					() => ({ path: fixturePath }),
				);
			},
		},
	],
});
const source = bundle.outputFiles[0]?.text;
assert.ok(source, "startup fixture bundle must be generated");
// A temporary module keeps failures readable instead of printing a multi-megabyte data URL.
const temporary = await mkdtemp(path.join(tmpdir(), "mica-startup-"));
let runtime: Runtime;
try {
	const modulePath = path.join(temporary, "startup.mjs");
	await writeFile(modulePath, source);
	runtime = (await import(pathToFileURL(modulePath).href)) as Runtime;
} finally {
	await rm(temporary, { recursive: true, force: true });
}
await runtime.initCore();
const candidate = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
	version: string;
};
assert.equal(runtime.coreVersion(), candidate.version, "startup fixture requires this candidate's generated WASM");

type Entry = Host.TFile | Host.TFolder;
class MockVault {
	entries = new Map<string, Entry>();
	indexed = false;
	writes: string[] = [];
	readHook: (file: Host.TFile) => Promise<void> = async () => undefined;
	createHook: (filePath: string) => Promise<void> = async () => undefined;
	afterCreateHook: (filePath: string) => Promise<void> = async () => undefined;
	afterRenameHook: () => Promise<void> = async () => undefined;
	processHook: (file: Host.TFile) => Promise<void> = async () => undefined;
	reads: string[] = [];
	indexScans = 0;
	listeners = new Map<object, string>();
	add(entry: Entry, text = ""): Entry {
		if (entry instanceof runtime.TFile) {
			entry.text = text;
			entry.stat.size = Buffer.byteLength(text);
			entry.vault = this;
		}
		this.entries.set(entry.path, entry);
		const parent = this.entries.get(entry.path.slice(0, entry.path.lastIndexOf("/")));
		if (parent instanceof runtime.TFolder) parent.children.push(entry);
		return entry;
	}
	getAbstractFileByPath(filePath: string): Entry | null {
		return this.indexed ? (this.entries.get(filePath) ?? null) : null;
	}
	getAllLoadedFiles(): Entry[] {
		this.indexScans += 1;
		return this.indexed ? [...this.entries.values()] : [];
	}
	getMarkdownFiles(): Host.TFile[] {
		return this.getAllLoadedFiles().filter(
			(file): file is Host.TFile => file instanceof runtime.TFile && file.extension === "md",
		);
	}
	async read(file: Host.TFile): Promise<string> {
		this.reads.push(file.path);
		await this.readHook(file);
		return file.text;
	}
	async create(filePath: string, text: string): Promise<Entry> {
		await this.createHook(filePath);
		assert.ok(!this.entries.has(filePath), "Vault.create must not replace an existing file");
		this.writes.push(`create:${filePath}`);
		const file = this.add(new runtime.TFile(filePath), text);
		await this.afterCreateHook(filePath);
		return file;
	}
	async createFolder(filePath: string): Promise<Entry> {
		assert.ok(!this.entries.has(filePath));
		this.writes.push(`mkdir:${filePath}`);
		return this.add(new runtime.TFolder(filePath));
	}
	async process(file: Host.TFile, update: (text: string) => string): Promise<string> {
		await this.processHook(file);
		const text = update(file.text);
		this.writes.push(`process:${file.path}`);
		file.text = text;
		file.stat.size = Buffer.byteLength(text);
		file.stat.mtime += 1;
		return text;
	}
	async rename(entry: Entry, next: string): Promise<void> {
		this.writes.push(`rename:${entry.path}:${next}`);
		const previous = entry.path;
		const moved = [...this.entries.values()].filter(
			(candidate) => candidate === entry || candidate.path.startsWith(previous + "/"),
		);
		for (const candidate of moved) this.entries.delete(candidate.path);
		for (const candidate of moved) {
			candidate.path = next + candidate.path.slice(previous.length);
			this.entries.set(candidate.path, candidate);
		}
		await this.afterRenameHook();
	}
	on(name: string, _callback: (...args: unknown[]) => void): object {
		const ref = {};
		this.listeners.set(ref, name);
		return ref;
	}
	offref(ref: object): void {
		this.listeners.delete(ref);
	}
}

function installDom(): void {
	const classes = new Set<string>();
	const body = {
		classList: classes,
		addClass: (name: string): void => {
			classes.add(name);
		},
		removeClass: (name: string): void => {
			classes.delete(name);
		},
		toggleClass: (name: string, on: boolean): void => {
			if (on) classes.add(name);
			else classes.delete(name);
		},
		setAttribute(): void {},
		removeAttribute(): void {},
		style: { setProperty(): void {}, removeProperty(): void {} },
	};
	Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
	Object.defineProperty(globalThis, "document", { configurable: true, value: { body, dispatchEvent(): void {} } });
}

function fixture(hot = false): {
	vault: MockVault;
	plugin: MicaPlugin & Host.Plugin;
	note: Host.TFile;
	ready(): void;
	views: Host.MarkdownView[];
} {
	installDom();
	runtime.observations.events.length = 0;
	runtime.observations.notices.length = 0;
	const vault = new MockVault();
	vault.indexed = hot;
	const storeId = "0192a110-4545-7111-8111-111111111111";
	vault.add(new runtime.TFolder("mica-data"));
	vault.add(new runtime.TFile("mica-data/root.json"), JSON.stringify({ format: 1, storeId }));
	vault.add(
		new runtime.TFile("mica.json"),
		JSON.stringify({ format: 1, folder: "mica-data", storeId, previousFolder: null, initializing: false }),
	);
	const note = new runtime.TFile("Existing.md");
	vault.add(note, runtime.setNoteId("Existing history\n", null, "existing-note"));
	const callbacks: (() => void)[] = [];
	const views = [new runtime.MarkdownView(), new runtime.MarkdownView()];
	const workspace = {
		onLayoutReady(callback: () => void): void {
			if (vault.indexed) callback();
			else callbacks.push(callback);
		},
		getLeavesOfType: () => views.map((view) => ({ view })),
	};
	const plugin = new runtime.MicaPlugin({ vault: vault as unknown as Vault, workspace });
	return {
		vault,
		plugin,
		note,
		views,
		ready(): void {
			vault.indexed = true;
			for (const callback of callbacks.splice(0)) callback();
		},
	};
}

// All mocked I/O resolves through promises, so one event-loop turn drains startup.
async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, description: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 2000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

type Fixture = ReturnType<typeof fixture>;
async function unload(test: Fixture): Promise<void> {
	test.plugin.unload();
	await flush();
}

function assertInactive(test: Fixture): void {
	assert.equal(test.plugin.engine, undefined, "cancelled startup must not create an engine");
	assert.equal(test.plugin.api, undefined, "cancelled startup must not create an API");
	assert.equal((globalThis.window as unknown as { mica?: unknown }).mica, undefined);
	assert.equal(
		test.vault.listeners.size,
		0,
		"cancelled startup must not install a storage lifecycle or event handlers",
	);
	assert.deepEqual(test.plugin.commands, [], "cancelled startup must not register commands");
	assert.ok(!runtime.observations.events.includes("register-reading"));
	assert.ok(!runtime.observations.events.includes("register-editor"));
	assert.deepEqual(runtime.observations.notices, [], "ordinary unload cancellation must be silent");
}

function assertActive(test: Fixture): void {
	assert.ok(test.plugin.engine, "ready startup must create the real version engine");
	assert.ok(test.plugin.api, "ready startup must create the API");
	assert.equal(
		test.plugin.commands.filter((command) => command.id === "run-instruction").length,
		1,
		"the essential clipboard instruction command must remain registered exactly once",
	);
	assert.equal(runtime.observations.events.filter((event) => event === "register-reading").length, 1);
	assert.equal(runtime.observations.events.filter((event) => event === "register-editor").length, 2);
	assert.equal(runtime.observations.events.filter((event) => event === "refresh-views").length, 1);
	assert.ok(
		runtime.observations.events.lastIndexOf("register-editor") <
			runtime.observations.events.indexOf("refresh-views"),
		"existing views must refresh after renderer/extension registration",
	);
	for (const view of test.views) {
		assert.equal(view.refreshes, 1, "startup must rerender an already-open Reading view");
		assert.equal(view.dispatches.length, 1, "startup must refresh an already-open Live Preview editor");
	}
	assert.deepEqual(runtime.observations.notices, []);
}

function fileAt(test: Fixture, filePath: string): Host.TFile {
	const file = test.vault.entries.get(filePath);
	assert.ok(file instanceof runtime.TFile, `fixture must contain ${filePath}`);
	return file;
}

function writeFixtureLocation(test: Fixture, update: Record<string, unknown>): void {
	const file = fileAt(test, "mica.json");
	file.text = JSON.stringify({ ...(JSON.parse(file.text) as Record<string, unknown>), ...update });
	file.stat.size = Buffer.byteLength(file.text);
}

let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> {
	await run();
	passed += 1;
	console.log(`startup-lifecycle: ${name}`);
}

await check("cold startup binds unchanged history first revealed at layout readiness", async () => {
	const cold = fixture();
	await bounded(Promise.resolve(cold.plugin.onload()), "onload must return without waiting for layout readiness");
	assert.equal(Boolean(cold.plugin.engine), false);
	assert.deepEqual(cold.vault.reads, [], "cold startup must not inspect storage before the vault index is ready");
	assert.equal(cold.vault.indexScans, 0, "cold startup must not build an incomplete identity index");
	assert.equal(cold.vault.listeners.size, 0);
	assert.deepEqual(cold.vault.writes, []);
	cold.ready();
	await flush();
	assertActive(cold);
	const store = await cold.plugin.engine.historyStore(cold.note as unknown as ObsidianFile);
	assert.equal(store?.noteId, "existing-note");
	assert.equal(store?.storeId, "0192a110-4545-7111-8111-111111111111");
	assert.deepEqual(cold.vault.writes, [], "binding existing history must remain read-only");
	await unload(cold);
});

await check("hot enable initializes once and refreshes already-open views", async () => {
	const hot = fixture(true);
	await hot.plugin.onload();
	await flush();
	assertActive(hot);
	assert.ok(await hot.plugin.engine.historyStore(hot.note as unknown as ObsidianFile));
	assert.deepEqual(hot.vault.writes, []);
	await unload(hot);
});

for (const authority of ["mica.json", "mica-data/root.json"]) {
	for (const change of ["identity", "mtime", "size", "path"] as const) {
		await check(`${authority} ${change} change still rejects history after successful startup`, async () => {
			const test = fixture(true);
			await test.plugin.onload();
			await flush();
			assert.ok(await test.plugin.engine.historyStore(test.note as unknown as ObsidianFile));
			const file = fileAt(test, authority);
			if (change === "identity") {
				const replacement = new runtime.TFile(authority);
				replacement.text = file.text;
				replacement.stat = { ...file.stat };
				replacement.vault = test.vault;
				test.vault.entries.set(authority, replacement);
			} else if (change === "mtime") file.stat.mtime += 1;
			else if (change === "size") file.stat.size += 1;
			else file.path += ".moved";
			await assert.rejects(
				test.plugin.engine.historyStore(test.note as unknown as ObsidianFile),
				/storage authority changed after validation/,
			);
			assert.deepEqual(test.vault.writes, []);
			await unload(test);
		});
	}
}

await check("unload before layout readiness prevents delayed startup", async () => {
	const test = fixture();
	await test.plugin.onload();
	await unload(test);
	test.ready();
	await flush();
	assertInactive(test);
	assert.deepEqual(test.vault.reads, []);
	assert.deepEqual(test.vault.writes, []);
	assert.deepEqual(test.plugin.saves, []);
});

await check("unload during loadData prevents delayed startup", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	test.plugin.loadDataHook = async () => {
		entered.resolve();
		await release.promise;
		return { reconcileOnLoad: false };
	};
	await test.plugin.onload();
	await bounded(entered.promise, "settings read");
	await unload(test);
	release.resolve();
	await flush();
	assertInactive(test);
	assert.deepEqual(test.vault.reads, []);
	assert.deepEqual(test.vault.writes, []);
	assert.deepEqual(test.plugin.saves, []);
});

for (const authority of ["mica.json", "mica-data/root.json"]) {
	await check(`unload during ${authority} read prevents lifecycle registration`, async () => {
		const test = fixture(true);
		const entered = deferred();
		const release = deferred();
		test.vault.readHook = async (file) => {
			if (file.path === authority) {
				entered.resolve();
				await release.promise;
			}
		};
		await test.plugin.onload();
		await bounded(entered.promise, authority);
		await unload(test);
		release.resolve();
		await flush();
		assertInactive(test);
		assert.deepEqual(test.vault.writes, []);
		assert.deepEqual(test.plugin.saves, []);
	});
}

await check("unload while normalized settings save drains prevents partial registration", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	test.plugin.loadDataHook = async () => ({ reconcileOnLoad: false, hiddenSectionActions: ["obsolete-action"] });
	test.plugin.saveDataHook = async () => {
		entered.resolve();
		await release.promise;
	};
	await test.plugin.onload();
	await bounded(entered.promise, "normalized settings save");
	assert.equal(test.vault.listeners.size, 0, "lifecycle ownership must wait for the last startup await");
	await unload(test);
	release.resolve();
	await flush();
	assertInactive(test);
	assert.deepEqual(test.vault.writes, []);
	assert.equal(test.plugin.saves.length, 1);
});

await check("unload inside pending relocation publication preserves the old route", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	const original = fileAt(test, "mica.json").text;
	test.plugin.loadDataHook = async () => ({ reconcileOnLoad: false, pendingStorageFolder: "archive/history" });
	test.vault.processHook = async (file) => {
		if (file.path === "mica.json") {
			entered.resolve();
			await release.promise;
		}
	};
	await test.plugin.onload();
	await bounded(entered.promise, "pending relocation publication");
	await unload(test);
	release.resolve();
	await flush();
	assertInactive(test);
	assert.equal(fileAt(test, "mica.json").text, original);
	assert.deepEqual(test.vault.writes, [], "publication callback must recheck cancellation before its first write");
	assert.deepEqual(test.plugin.saves, []);
});

await check("unload inside initialization completion preserves its recoverable intent", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	writeFixtureLocation(test, { initializing: true });
	const original = fileAt(test, "mica.json").text;
	test.vault.processHook = async (file) => {
		if (file.path === "mica.json") {
			entered.resolve();
			await release.promise;
		}
	};
	await test.plugin.onload();
	await bounded(entered.promise, "initialization completion publication");
	await unload(test);
	release.resolve();
	await flush();
	assertInactive(test);
	assert.equal(fileAt(test, "mica.json").text, original);
	assert.deepEqual(
		test.vault.writes,
		[],
		"initialization publication must recheck cancellation inside Vault.process",
	);
	assert.deepEqual(test.plugin.saves, []);
});

await check("unload after initialization directory creation prevents marker publication", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	writeFixtureLocation(test, { initializing: true });
	test.vault.entries.delete("mica-data/root.json");
	test.vault.entries.delete("mica-data");
	test.vault.readHook = async (file) => {
		if (file.path === "mica.json" && test.vault.entries.has("mica-data")) {
			entered.resolve();
			await release.promise;
		}
	};
	await test.plugin.onload();
	await bounded(entered.promise, "initialization marker preflight");
	assert.deepEqual(test.vault.writes, ["mkdir:mica-data"]);
	await unload(test);
	release.resolve();
	await flush();
	assertInactive(test);
	assert.deepEqual(
		test.vault.writes,
		["mkdir:mica-data"],
		"cancelled startup must leave an empty recoverable directory",
	);
	assert.equal(test.vault.entries.has("mica-data/root.json"), false);
	assert.equal((JSON.parse(fileAt(test, "mica.json").text) as { initializing: boolean }).initializing, true);
});

for (const phase of ["before-create", "after-create"] as const) {
	await check(`rapid reload recovers an initializing store with the old marker ${phase} suspended`, async () => {
		const test = fixture(true);
		const entered = deferred();
		const release = deferred();
		writeFixtureLocation(test, { initializing: true });
		test.vault.entries.delete("mica-data/root.json");
		const folder = test.vault.entries.get("mica-data");
		assert.ok(folder instanceof runtime.TFolder);
		folder.children = [];
		let first = true;
		const suspend = async (filePath: string): Promise<void> => {
			if (filePath === "mica-data/root.json" && first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
		};
		if (phase === "before-create") test.vault.createHook = suspend;
		else test.vault.afterCreateHook = suspend;
		await test.plugin.onload();
		await bounded(entered.promise, `marker ${phase}`);
		await unload(test);
		const next = { ...test, plugin: new runtime.MicaPlugin(test.plugin.app) };
		await next.plugin.onload();
		await flush();
		assertActive(next);
		const published = fileAt(test, "mica.json").text;
		release.resolve();
		await flush();
		assert.equal(test.plugin.engine, undefined, "the old initializer must stay cancelled after its write settles");
		assert.equal(
			fileAt(test, "mica.json").text,
			published,
			"the old initializer must not republish a completed route",
		);
		assert.equal(test.vault.writes.filter((effect) => effect === "create:mica-data/root.json").length, 1);
		assert.equal(test.vault.writes.filter((effect) => effect === "process:mica.json").length, 1);
		assert.ok(await next.plugin.engine.historyStore(next.note as unknown as ObsidianFile));
		assert.deepEqual(runtime.observations.notices, []);
		await unload(next);
	});
}

await check("rapid reload completes a moved store while the old rename promise is draining", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	writeFixtureLocation(test, { folder: "archived-history", previousFolder: "mica-data" });
	const marker = fileAt(test, "mica-data/root.json").text;
	test.vault.afterRenameHook = async () => {
		entered.resolve();
		await release.promise;
	};
	await test.plugin.onload();
	await bounded(entered.promise, "moved store rename");
	await unload(test);
	const next = { ...test, plugin: new runtime.MicaPlugin(test.plugin.app) };
	await next.plugin.onload();
	await flush();
	assertActive(next);
	const published = fileAt(test, "mica.json").text;
	release.resolve();
	await flush();
	assert.equal(test.plugin.engine, undefined);
	assert.equal(fileAt(test, "mica.json").text, published);
	assert.equal(fileAt(test, "archived-history/root.json").text, marker);
	assert.equal(test.vault.writes.filter((effect) => effect.startsWith("rename:")).length, 1);
	assert.equal(test.vault.writes.filter((effect) => effect === "process:mica.json").length, 1);
	assert.equal(
		(await next.plugin.engine.historyStore(next.note as unknown as ObsidianFile))?.root.paths.root,
		"archived-history",
	);
	assert.deepEqual(runtime.observations.notices, []);
	await unload(next);
});

await check("a genuine startup failure reports once and cleans up instead of escaping the callback", async () => {
	const test = fixture(true);
	test.vault.readHook = async () => {
		throw new Error("fixture storage read failed");
	};
	const original = console.error;
	const errors: unknown[][] = [];
	console.error = (...args: unknown[]): void => {
		errors.push(args);
	};
	try {
		await test.plugin.onload();
		await flush();
	} finally {
		console.error = original;
	}
	assert.deepEqual(runtime.observations.notices, ["fixture storage read failed"]);
	assert.equal(errors.length, 1);
	assert.equal(test.plugin.engine, undefined);
	assert.equal(test.plugin.api, undefined);
	assert.equal(test.vault.listeners.size, 0);
	assert.deepEqual(test.vault.writes, []);
	assert.deepEqual(test.plugin.commands, []);
});

await check("same-instance reload ignores the old settings read when it settles last", async () => {
	const test = fixture(true);
	const entered = deferred();
	const release = deferred();
	let first = true;
	test.plugin.loadDataHook = async () => {
		if (first) {
			first = false;
			entered.resolve();
			await release.promise;
			return { reconcileOnLoad: false, theme: "ocean" };
		}
		return { reconcileOnLoad: false, theme: "forest" };
	};
	await test.plugin.onload();
	await bounded(entered.promise, "old settings read");
	await unload(test);
	await test.plugin.onload();
	await flush();
	assertActive(test);
	assert.equal(test.plugin.settings.theme, "forest");
	release.resolve();
	await flush();
	assert.equal(test.plugin.settings.theme, "forest", "the stale load must not overwrite the newest settings");
	assert.equal(runtime.observations.events.filter((event) => event === "register-bridge").length, 1);
	assert.ok(await test.plugin.engine.historyStore(test.note as unknown as ObsidianFile));
	await unload(test);
});

await check("a new initializer recovers the exact marker when two creates were already admitted", async () => {
	const test = fixture(true);
	const firstEntered = deferred();
	const secondEntered = deferred();
	const releaseFirst = deferred();
	const releaseSecond = deferred();
	writeFixtureLocation(test, { initializing: true });
	test.vault.entries.delete("mica-data/root.json");
	const folder = test.vault.entries.get("mica-data");
	assert.ok(folder instanceof runtime.TFolder);
	folder.children = [];
	let calls = 0;
	test.vault.createHook = async (filePath) => {
		if (filePath !== "mica-data/root.json") return;
		calls += 1;
		if (calls === 1) {
			firstEntered.resolve();
			await releaseFirst.promise;
		} else {
			secondEntered.resolve();
			await releaseSecond.promise;
		}
	};
	await test.plugin.onload();
	await bounded(firstEntered.promise, "first admitted marker create");
	await unload(test);
	const next = { ...test, plugin: new runtime.MicaPlugin(test.plugin.app) };
	await next.plugin.onload();
	await bounded(secondEntered.promise, "second admitted marker create");
	releaseFirst.resolve();
	await flush();
	assert.equal(test.plugin.engine, undefined);
	releaseSecond.resolve();
	await flush();
	assertActive(next);
	assert.equal(test.vault.writes.filter((effect) => effect === "create:mica-data/root.json").length, 1);
	assert.equal(test.vault.writes.filter((effect) => effect === "process:mica.json").length, 1);
	assert.ok(await next.plugin.engine.historyStore(next.note as unknown as ObsidianFile));
	await unload(next);
});

console.log(`startup-lifecycle: ${passed} scenarios passed`);
