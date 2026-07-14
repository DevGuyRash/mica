import { editorInfoField, editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import { parseBlock, scanBlocksView, serializeCst, setBlockAttr, type BlockView } from "../wasm/bridge";
import { renderCst, type BlockUi } from "../ui/blockShell";
import { applyOp, revealFor, type StructOp } from "../cst/ops";

/**
 * The rendered widget shown in place of a ` ```mica ` block in Live Preview.
 * Every edit — typing in a region or a structural op — is applied to the
 * block's CST by the shared Rust reducer and dispatched as one change whose
 * bounds are recomputed from a live re-scan, so it can't corrupt the document
 * and works even before a block has an id. Per-block UI state (active tab,
 * focus target, editor draft, collapse) lives on the plugin, keyed by id, so
 * it survives the rebuild each edit triggers AND reading⇄editing mode flips.
 */
/** Bumped when render-affecting settings change (header mode, version chip):
 *  it participates in widget identity, so a refresh dispatch rebuilds DOM. */
let configEpoch = 0;

class MicaWidget extends WidgetType {
	private child: MarkdownRenderChild | null = null;
	private readonly epoch = configEpoch;

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly id: string | null,
		private readonly start: number,
		private readonly content: string,
		private readonly attrs: Record<string, string>,
	) {
		super();
	}

	eq(other: MicaWidget): boolean {
		return (
			other.epoch === this.epoch &&
			other.id === this.id &&
			other.content === this.content &&
			sameAttrs(other.attrs, this.attrs)
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const el = document.createElement("div");
		el.className = "mica-lp";
		const child = new MarkdownRenderChild(el);
		this.child = child;
		this.plugin.addChild(child);
		const info = view.state.field(editorInfoField, false);
		const chip =
			this.plugin.settings.showVersionChip && this.id && info?.file
				? { plugin: this.plugin, file: info.file, blockId: this.id, content: this.content }
				: undefined;
		const ui = this.blockUi();
		renderCst(parseBlock(this.content), el, {
			app: this.plugin.app,
			sourcePath: info?.file?.path ?? this.plugin.app.workspace.getActiveFile()?.path ?? "",
			component: child,
			editable: {
				apply: (op) => this.apply(view, op, ui),
				replaceAll: (content) => this.replaceAll(view, content),
				setAttr: (key, value) => this.setAttr(view, key, value),
			},
			editorAutosize: this.plugin.settings.editorAutosize,
			chip,
			ui,
			blockAttrs: this.attrs,
			headerMode: this.plugin.settings.blockHeaderMode,
			preImage: () => this.liveContent(view) ?? this.content,
		});
		return el;
	}

	/** Per-block UI state, kept on the plugin so it survives widget rebuilds. */
	private blockUi(): BlockUi {
		const key = this.id ?? `@${this.start}`;
		const store = this.plugin.micaUi;
		let ui = store.get(key);
		if (ui) {
			// Refresh recency (Map preserves insertion order → cheap LRU).
			store.delete(key);
			store.set(key, ui);
			return ui;
		}
		ui = { active: new Map(), reveal: null, draft: null, collapsed: false, folded: new Set() };
		// Folds survive restarts: restore from plugin data, write back on change.
		const saved = this.plugin.settings.foldState[key];
		if (saved) for (const k of saved) ui.folded.add(k);
		const plugin = this.plugin;
		ui.persistFolds = () => {
			if (ui!.folded.size) plugin.settings.foldState[key] = [...ui!.folded];
			else delete plugin.settings.foldState[key];
			// The store is user data — cap it like the UI store itself.
			const keys = Object.keys(plugin.settings.foldState);
			if (keys.length > 256) for (const k of keys.slice(0, keys.length - 256)) delete plugin.settings.foldState[k];
			void plugin.saveSettings();
		};
		store.set(key, ui);
		// The store is otherwise unbounded and pins draft strings for every
		// block ever rendered — evict the stalest draft-free entries.
		if (store.size > 128) {
			for (const [k, v] of store) {
				if (store.size <= 128) break;
				if (k !== key && !v.draft) store.delete(k);
			}
		}
		return ui;
	}

	/** The block's CURRENT content from a live scan (never the cached copy). */
	private liveContent(view: EditorView): string | null {
		const doc = view.state.doc.toString();
		const live = scanBlocksView(doc).find((b) => (this.id ? b.id === this.id : b.start === this.start));
		return live ? doc.slice(live.content_start, live.content_end) : null;
	}

	/** Apply one structural op via the shared Rust reducer and dispatch it live. */
	private apply(view: EditorView, op: StructOp, ui: BlockUi): void {
		ui.reveal = revealFor(op);
		this.structuralEdit(view, (content) => {
			const { changed, cst } = applyOp(parseBlock(content), op);
			if (!changed) {
				ui.reveal = null;
				return null;
			}
			return serializeCst(cst);
		});
	}

	/** Replace the whole block body (undo toasts, whole-block lightbox edits). */
	private replaceAll(view: EditorView, content: string): void {
		this.structuralEdit(view, () => content);
	}

	/** Write / remove one fence-header attribute (name, accent, density, …). */
	private setAttr(view: EditorView, key: string, value: string | null): void {
		if (!this.id) return;
		const doc = view.state.doc.toString();
		const next = setBlockAttr(doc, this.id, key, value);
		if (next === null || next === doc) return;
		view.dispatch({ changes: { from: 0, to: doc.length, insert: next } });
	}

	private structuralEdit(view: EditorView, mutate: (content: string) => string | null): void {
		const doc = view.state.doc.toString();
		const live = scanBlocksView(doc).find((b) => (this.id ? b.id === this.id : b.start === this.start));
		if (!live) return;
		const before = doc.slice(live.content_start, live.content_end);
		let after = mutate(before);
		if (after === null) return;
		// A closed block's content always ends at the closing fence's line start,
		// so it must end in a newline — otherwise newline-free text would glue the
		// last line onto the ``` and break the fence.
		if (after.length && !after.endsWith("\n")) after += "\n";
		if (after === before) return; // no change — never churn the doc
		view.dispatch({ changes: { from: live.content_start, to: live.content_end, insert: after } });
	}

	destroy(): void {
		if (this.child) {
			this.plugin.removeChild(this.child);
			this.child = null;
		}
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function sameAttrs(a: Record<string, string>, b: Record<string, string>): boolean {
	if (a === b) return true;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

// Cache the last scan so pure cursor moves (selection-only transactions) skip
// the WASM scan — and, via the Text identity fast path, the O(doc) string
// round-trip; a re-scan happens only when the document text changes.
export interface ScanCache {
	/** Text instances known to equal `doc` (split panes share one entry). */
	texts: WeakSet<Text>;
	doc: string;
	blocks: BlockView[];
	attrs: Record<string, string>[];
	/** Per-block replace-range end (the closing fence line's end). */
	tos: number[];
	/** Per-block content slices — shared instances make widget `eq` O(1). */
	contents: string[];
}
let scanCache: ScanCache | null = null;
/** Exported for sibling extensions (source highlighter): same Text-identity
 *  cache, so an extra consumer adds ZERO stringify/scan work per edit. */
export function scanCached(state: EditorState): ScanCache {
	if (scanCache?.texts.has(state.doc)) return scanCache;
	const doc = state.doc.toString();
	if (scanCache && scanCache.doc === doc) {
		scanCache.texts.add(state.doc);
		return scanCache;
	}
	const blocks = scanBlocksView(doc);
	// One scan serves geometry AND appearance — BlockView carries the attrs.
	const attrs = blocks.map((b) => Object.fromEntries(b.attrs));
	// End at the closing fence line's end, not past its newline: block replace
	// decorations must cover whole lines exactly.
	const tos = blocks.map((b) => (doc.charCodeAt(b.end - 1) === 10 ? b.end - 1 : b.end));
	const contents = blocks.map((b) => doc.slice(b.content_start, b.content_end));
	scanCache = { texts: new WeakSet([state.doc]), doc, blocks, attrs, tos, contents };
	return scanCache;
}

/**
 * Build replace-decorations for every closed ` ```mica ` block not under the
 * cursor. Runs in a StateField (not a ViewPlugin) because CodeMirror only
 * accepts block-level decorations when they are provided directly.
 */
function build(plugin: MicaPlugin, state: EditorState): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const sel = state.selection.main;
	const ranges = [];
	const { blocks, attrs, tos, contents } = scanCached(state);
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (!b.closed) continue;
		const to = tos[i];
		// Reveal the raw source while the caret/selection is inside the block
		// (arrow-keying in, or an explicit click on the revealed source).
		if (sel.from <= to && sel.to >= b.start) continue;
		ranges.push(
			Decoration.replace({
				widget: new MicaWidget(plugin, b.id, b.start, contents[i], attrs[i] ?? {}),
				block: true,
			}).range(b.start, to),
		);
	}
	return Decoration.set(ranges, true);
}

/**
 * True when a selection-only transaction leaves every block's reveal state
 * (caret inside ⇒ raw source shown) as it was — the current decoration set is
 * then still exact and a rebuild would only churn identical widgets.
 */
function revealUnchanged(tr: Transaction): boolean {
	const { blocks, tos } = scanCached(tr.state);
	const a = tr.startState.selection.main;
	const b = tr.state.selection.main;
	for (let i = 0; i < blocks.length; i++) {
		const blk = blocks[i];
		if (!blk.closed) continue;
		const to = tos[i];
		if ((a.from <= to && a.to >= blk.start) !== (b.from <= to && b.to >= blk.start)) return false;
	}
	return true;
}

/** Dispatched into open editors after render-affecting settings change:
 *  bumps the widget epoch (done by the caller) and forces a rebuild. */
export const micaRefreshEffect = StateEffect.define<null>();

/** Bump the widget identity epoch (pair with dispatching the effect). */
export function bumpConfigEpoch(): void {
	configEpoch++;
}

/** The Live Preview editor extension. Registered via `registerEditorExtension`. */
export function micaLivePreview(plugin: MicaPlugin): Extension {
	const field = StateField.define<DecorationSet>({
		create(state) {
			return build(plugin, state);
		},
		update(deco, tr) {
			const modeFlipped =
				tr.state.field(editorLivePreviewField, false) !== tr.startState.field(editorLivePreviewField, false);
			const refresh = tr.effects.some((e) => e.is(micaRefreshEffect));
			if (tr.docChanged || modeFlipped || refresh) return build(plugin, tr.state);
			if (!tr.selection) return deco;
			// Outside Live Preview `deco` is already Decoration.none (mode flips
			// always rebuild), which is exactly what build() would return.
			if (!tr.state.field(editorLivePreviewField, false)) return deco;
			// Cursor-only transaction: rebuild only if a block's reveal flipped.
			return revealUnchanged(tr) ? deco : build(plugin, tr.state);
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	// Beat Obsidian's built-in fenced-code handling.
	return Prec.highest(field);
}
