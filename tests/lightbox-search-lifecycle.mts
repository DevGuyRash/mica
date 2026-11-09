import assert from "node:assert/strict";
import { build } from "esbuild";
import type { LightboxSearch as Search } from "../src/ui/lightboxSearch.ts";
import type { MdEditor } from "../src/ui/mdEditor.ts";

// Exercise the real search controller, replacing only its host and worker boundaries.
const bundle = await build({
	entryPoints: ["src/ui/lightboxSearch.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	write: false,
	plugins: [
		{
			name: "search-host",
			setup(api) {
				api.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "search-host" }));
				api.onLoad({ filter: /.*/, namespace: "search-host" }, () => ({
					contents: "export function setIcon() {}",
				}));
			},
		},
	],
});
const { LightboxSearch } = (await import(
	`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
)) as { LightboxSearch: typeof Search };

class Clock {
	nextId = 0;
	now = 0;
	timers = new Map<number, { at: number; run: () => void }>();
	microtasks: Array<() => void> = [];
	setTimeout = (run: () => void, delay: number): number => {
		const id = ++this.nextId;
		this.timers.set(id, { at: this.now + delay, run });
		return id;
	};
	clearTimeout = (id: number): void => {
		this.timers.delete(id);
	};
	queueMicrotask = (run: () => void): void => {
		this.microtasks.push(run);
	};
	tick(delay: number): void {
		const end = this.now + delay;
		for (;;) {
			const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			this.now = next[1].at;
			this.timers.delete(next[0]);
			next[1].run();
		}
		this.now = end;
		for (const run of this.microtasks.splice(0)) run();
	}
}

type Options = { cls?: string; text?: string; attr?: Record<string, string> };
class Element {
	hidden = false;
	isConnected = true;
	value = "";
	checked = false;
	disabled = false;
	text = "";
	attributes = new Map<string, string>();
	children: Element[] = [];
	listeners = new Map<string, Array<(event: Event) => void>>();
	constructor(readonly win: Clock) {}
	addClass(): void {}
	focus(): void {}
	select(): void {}
	setText(text: string): void {
		this.text = text;
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	createEl(_tag: string, options: Options = {}): Element {
		const child = new Element(this.win);
		child.text = options.text ?? "";
		for (const [key, value] of Object.entries(options.attr ?? {})) child.attributes.set(key, value);
		this.children.push(child);
		return child;
	}
	createDiv(options?: Options): Element {
		return this.createEl("div", options);
	}
	createSpan(options?: Options): Element {
		return this.createEl("span", options);
	}
	addEventListener(type: string, listener: (event: Event) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
	}
	label(label: string): Element {
		const find = (element: Element): Element | undefined =>
			element.attributes.get("aria-label") === label ? element : element.children.map(find).find(Boolean);
		const result = find(this);
		assert.ok(result, `missing control: ${label}`);
		return result;
	}
}

type Request = { id: number; type: "scan" | "replace" };
class FakeWorker {
	static instances: FakeWorker[] = [];
	requests: Request[] = [];
	terminated = false;
	listener?: (event: MessageEvent) => void;
	constructor() {
		FakeWorker.instances.push(this);
	}
	addEventListener(_type: string, listener: (event: MessageEvent) => void): void {
		this.listener = listener;
	}
	postMessage(request: Request): void {
		this.requests.push(request);
	}
	terminate(): void {
		this.terminated = true;
	}
	reply(id: number): void {
		this.listener?.({
			data: { id, ok: true, type: "scan", ranges: new Uint32Array([0, 4]).buffer, replacements: ["new"] },
		} as MessageEvent);
	}
}

const originalWorker = globalThis.Worker;
globalThis.Worker = FakeWorker as unknown as typeof Worker;
function fixture() {
	const clock = new Clock();
	const host = new Element(clock);
	const highlights: number[][] = [];
	const writes: string[] = [];
	let focusCount = 0;
	const editor = {
		getValue: () => "word word",
		setValue: (text: string) => {
			writes.push(text);
		},
		setSearchHighlights: (ranges: Uint32Array) => {
			highlights.push([...ranges]);
		},
		focus: () => {
			focusCount++;
		},
		view: { state: { selection: { main: { head: 0 } } } },
	};
	const search = new LightboxSearch(host as unknown as HTMLElement, editor as unknown as MdEditor);
	const worker = FakeWorker.instances.at(-1)!;
	const input = host.label("Find");
	input.value = "word";
	return { search, clock, host, worker, input, highlights, writes, focused: () => focusCount };
}

try {
	// A debounced input must not acquire a new generation after close invalidated the old one.
	{
		const f = fixture();
		f.search.open();
		f.clock.tick(0);
		f.worker.reply(f.worker.requests[0]!.id);
		f.input.emit("input");
		f.host.label("Close search").emit("click");
		f.clock.tick(120);
		assert.equal(f.worker.requests.length, 1, "closing search must cancel its pending scan");
		assert.deepEqual(f.highlights.at(-1), []);
		assert.equal(f.search.isOpen, false);
		assert.equal(f.focused(), 1);
		f.search.destroy();
	}
	// Opening and closing in the same event turn must cancel even the immediate scan.
	{
		const f = fixture();
		f.search.open();
		f.search.close();
		assert.equal(f.clock.timers.size, 0, "close must release the queued timer");
		f.clock.tick(500);
		assert.equal(f.worker.requests.length, 0);
		f.search.destroy();
	}
	// Already-posted replies cannot restore highlights after close; reopening accepts only fresh work.
	{
		const f = fixture();
		f.search.open();
		f.clock.tick(0);
		const stale = f.worker.requests[0]!.id;
		f.search.close();
		f.worker.reply(stale);
		assert.deepEqual(f.highlights.at(-1), []);
		f.search.open();
		f.clock.tick(0);
		const current = f.worker.requests[1]!.id;
		f.worker.reply(stale);
		assert.deepEqual(f.highlights.at(-1), []);
		f.worker.reply(current);
		assert.deepEqual(f.highlights.at(-1), [0, 4]);
		assert.equal(f.focused(), 0, "a stale close microtask must not take focus from reopened search");
		f.search.destroy();
	}
	// A late replacement result must not mutate the document after dismissal.
	{
		const f = fixture();
		f.search.open(true);
		f.clock.tick(0);
		f.worker.reply(f.worker.requests[0]!.id);
		const replaceAll = f.host.children
			.flatMap((row) => row.children)
			.find((control) => control.text === "Replace all")!;
		replaceAll.emit("click");
		const pending = f.worker.requests.at(-1)!;
		assert.equal(pending.type, "replace");
		f.search.close();
		f.worker.listener?.({ data: { id: pending.id, ok: true, type: "replace", text: "new new" } } as MessageEvent);
		assert.deepEqual(f.writes, []);
		assert.deepEqual(f.highlights.at(-1), []);
		f.search.destroy();
	}
	// Teardown cancels timers, discards replies, and cannot refocus a removed editor.
	{
		const f = fixture();
		f.search.open();
		f.clock.tick(0);
		const pending = f.worker.requests[0]!.id;
		f.input.emit("input");
		f.search.close();
		f.search.destroy();
		f.clock.tick(500);
		f.worker.reply(pending);
		assert.equal(f.worker.requests.length, 1);
		assert.equal(f.worker.terminated, true);
		assert.equal(f.clock.timers.size, 0);
		assert.equal(f.focused(), 0);
		assert.deepEqual(f.highlights.at(-1), []);
	}
	console.log("lightbox search lifecycle: 5 scenarios passed");
} finally {
	globalThis.Worker = originalWorker;
}
