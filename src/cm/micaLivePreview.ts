import { editorInfoField, editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import {
	guardedBlockContentEdit,
	guardedBlockContentEditAt,
	parseBlock,
	scanBlocksView,
	setBlockAttrEdit,
	type BlockView,
} from "../wasm/bridge";
import { renderCst, type BlockUi } from "../ui/blockShell";
import { applyOpsText, applyOpText, revealFor, type StructOp } from "../cst/ops";
import { getBlockUi } from "../render/blockUiState";
import type { BlockApplyHost, CrossBlockMove } from "../ui/dnd";
import { noteBasenameFromPath, unnamedBlockOrdinals } from "../identity/blockLabel";

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
		private readonly attrs: Readonly<Record<string, string>>,
		private readonly unnamedOrdinal: number,
	) {
		super();
	}

	eq(other: MicaWidget): boolean {
		return (
			other.epoch === this.epoch &&
			other.id === this.id &&
			(this.id !== null || other.start === this.start) &&
			other.content === this.content &&
			other.unnamedOrdinal === this.unnamedOrdinal &&
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
		const sourcePath = info?.file?.path ?? this.plugin.app.workspace.getActiveFile()?.path ?? "";
		const chip =
			this.id && info?.file
				? { plugin: this.plugin, file: info.file, blockId: this.id, content: this.content }
				: undefined;
		const ui = this.blockUi(sourcePath);
		// Cross-block drops need the TARGET block's op hook: expose it on the
		// root (apply relocates the block by id, so a stale widget stays safe).
		el.dataset.micaBlockId = this.id ?? "";
		const host = el as BlockApplyHost;
		host.micaContent = this.content;
		host.micaApply = (op) => this.apply(view, op, ui);
		const applyMany = (ops: readonly StructOp[]): boolean => this.applyMany(view, ops, ui);
		host.micaApplyMany = applyMany;
		host.micaMoveAcross = (move) => this.moveAcross(view, move);
		renderCst(parseBlock(this.content), el, {
			app: this.plugin.app,
			sourcePath,
			component: child,
			editable: {
				order: this.start,
				apply: (op) => this.apply(view, op, ui),
				applyMany,
				replaceAll: (expected, content) => this.replaceAll(view, expected, content),
				setAttr: (key, value) => this.setAttr(view, key, value),
			},
			editorAutosize: this.plugin.settings.editorAutosize,
			chip,
			ui,
			blockAttrs: this.attrs,
			blockNamePresentation: {
				noteBasename: info?.file?.basename ?? noteBasenameFromPath(sourcePath),
				unnamedOrdinal: this.unnamedOrdinal,
			},
			headerMode: this.plugin.settings.blockHeaderMode,
			copyOptions: () => ({
				includeMicaSyntax: this.plugin.settings.copyIncludeMicaSyntax,
				includeOuterContainer: this.plugin.settings.copyIncludeOuterContainer,
				includeLineNumbers: this.plugin.settings.copyIncludeLineNumbers,
				lineNumberScope: this.plugin.settings.copyLineNumberScope,
			}),
			entityActionLayout: this.plugin.settings.entityActionLayout,
			showTabActionMenuOnHover: this.plugin.settings.showTabActionMenuOnHover,
			preImage: () => this.liveContent(view) ?? this.content,
		});
		return el;
	}

	/** Per-block UI state, kept on the plugin so it survives widget rebuilds. */
	private blockUi(sourcePath: string): BlockUi {
		return getBlockUi(this.plugin, this.id ?? `@${sourcePath}:${this.start}`);
	}

	/** The block's CURRENT content from a live scan (never the cached copy). */
	private liveContent(view: EditorView): string | null {
		const doc = view.state.doc.toString();
		const matches = scanBlocksView(doc).filter((b) => (this.id ? b.id === this.id : b.start === this.start));
		const live = matches.length === 1 ? matches[0] : null;
		return live ? doc.slice(live.content_start, live.content_end) : null;
	}

	/** Apply one structural op via the shared Rust reducer and dispatch it live. */
	private apply(view: EditorView, op: StructOp, ui: BlockUi): boolean {
		ui.reveal = revealFor(op);
		return this.structuralEdit(view, (content) => {
			const { changed, text } = applyOpText(content, op);
			if (!changed) {
				ui.reveal = null;
				return null;
			}
			return text;
		});
	}

	/** Apply all edits to one fresh tree and dispatch once. Any rejection leaves
	 * the document byte-for-byte unchanged. */
	private applyMany(view: EditorView, ops: readonly StructOp[], ui: BlockUi): boolean {
		if (!ops.length) return true;
		ui.reveal = null;
		return this.structuralEdit(view, (content) => {
			const result = applyOpsText(content, ops);
			return result.changed ? result.text : null;
		});
	}

	/** Reduce a source deletion and target insertion from one fresh document,
	 * then dispatch both non-overlapping changes as one CodeMirror transaction. */
	private moveAcross(view: EditorView, move: CrossBlockMove): boolean {
		if (!this.id || move.sourceId === this.id) return false;
		const doc = view.state.doc.toString();
		const blocks = scanBlocksView(doc);
		const targets = blocks.filter((b) => b.id === this.id);
		const sources = blocks.filter((b) => b.id === move.sourceId);
		if (targets.length !== 1 || sources.length !== 1) return false;
		const target = targets[0];
		const source = sources[0];
		const targetBefore = doc.slice(target.content_start, target.content_end);
		const sourceBefore = doc.slice(source.content_start, source.content_end);
		if (targetBefore !== move.targetExpected || sourceBefore !== move.sourceExpected) return false;
		const targetResult = applyOpText(targetBefore, move.targetOp);
		const sourceResult = applyOpText(sourceBefore, move.sourceOp);
		if (!targetResult.changed || !sourceResult.changed) return false;
		const targetEdit = guardedBlockContentEditAt(doc, target.start, targetBefore, targetResult.text);
		const sourceEdit = guardedBlockContentEditAt(doc, source.start, sourceBefore, sourceResult.text);
		if (!targetEdit || !sourceEdit) return false;
		const changes = [targetEdit, sourceEdit].sort((a, b) => a.from - b.from);
		view.dispatch({ changes });
		return true;
	}

	/** Replace the whole block body (undo toasts, whole-block lightbox edits). */
	private replaceAll(view: EditorView, expected: string, content: string): boolean {
		if (this.id) {
			const edit = guardedBlockContentEdit(view.state.doc.toString(), this.id, expected, content);
			if (!edit) return false;
			view.dispatch({ changes: edit });
			return true;
		}
		return this.structuralEdit(view, (live) => (live === expected ? content : null));
	}

	/** Write / remove one fence-header attribute (name, accent, density, …). */
	private setAttr(view: EditorView, key: string, value: string | null): void {
		if (!this.id) return;
		const doc = view.state.doc.toString();
		const edit = setBlockAttrEdit(doc, this.id, key, value);
		if (!edit) return;
		view.dispatch({ changes: edit });
	}

	private structuralEdit(view: EditorView, mutate: (content: string) => string | null): boolean {
		const doc = view.state.doc.toString();
		const matches = scanBlocksView(doc).filter((b) => (this.id ? b.id === this.id : b.start === this.start));
		// An id must identify exactly one live block. Choosing the first duplicate
		// silently edits the original after copy/paste, which is worse than a
		// visible rejected operation.
		if (matches.length !== 1) return false;
		const live = matches[0];
		const before = doc.slice(live.content_start, live.content_end);
		const after = mutate(before);
		if (after === null) return false;
		if (after === before) return false; // no change — never churn the doc
		const edit = guardedBlockContentEditAt(doc, live.start, before, after);
		if (!edit) return false;
		view.dispatch({ changes: edit });
		return true;
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

function sameAttrs(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
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
	blocks: readonly BlockView[];
	attrs: readonly Readonly<Record<string, string>>[];
	/** Per-block replace-range end (the closing fence line's end). */
	tos: readonly number[];
	/** Per-block content slices — shared instances make widget `eq` O(1). */
	contents: readonly string[];
	/** One-based document-order positions among blocks without an explicit name. */
	unnamedOrdinals: readonly number[];
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
	const unnamedOrdinals = unnamedBlockOrdinals(blocks.map((block) => block.name));
	scanCache = { texts: new WeakSet([state.doc]), doc, blocks, attrs, tos, contents, unnamedOrdinals };
	return scanCache;
}

/**
 * Build replace-decorations for every closed ` ```mica ` block not under the
 * cursor. Runs in a StateField (not a ViewPlugin) because CodeMirror only
 * accepts block-level decorations when they are provided directly.
 */
function build(plugin: MicaPlugin, state: EditorState, sel: RevealSel): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const ranges = [];
	const { blocks, attrs, tos, contents, unnamedOrdinals } = scanCached(state);
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (!b.closed) continue;
		const to = tos[i];
		// Reveal the raw source while the USER's caret/selection is inside the
		// block (arrow-keying in, or an explicit click on revealed source).
		if (sel && sel.from <= to && sel.to >= b.start) continue;
		ranges.push(
			Decoration.replace({
				widget: new MicaWidget(plugin, b.id, b.start, contents[i], attrs[i] ?? {}, unnamedOrdinals[i] ?? 1),
				block: true,
			}).range(b.start, to),
		);
	}
	return Decoration.set(ranges, true);
}

/** The selection reveal decisions are made against — null reveals nothing. */
type RevealSel = { from: number; to: number } | null;

/**
 * True when moving from reveal-selection `a` to `b` leaves every block's
 * reveal state (caret inside ⇒ raw source shown) as it was — the current
 * decoration set is then still exact and a rebuild would only churn
 * identical widgets.
 */
function revealUnchanged(state: EditorState, a: RevealSel, b: RevealSel): boolean {
	const { blocks, tos } = scanCached(state);
	for (let i = 0; i < blocks.length; i++) {
		const blk = blocks[i];
		if (!blk.closed) continue;
		const to = tos[i];
		const ain = a ? a.from <= to && a.to >= blk.start : false;
		const bin = b ? b.from <= to && b.to >= blk.start : false;
		if (ain !== bin) return false;
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

/** Decorations plus the user-driven selection they were revealed against. */
interface RevealState {
	deco: DecorationSet;
	sel: RevealSel;
}

/** The Live Preview editor extension. Registered via `registerEditorExtension`. */
export function micaLivePreview(plugin: MicaPlugin): Extension {
	const field = StateField.define<RevealState>({
		create(state) {
			// Nothing is revealed at create time: the restore-cursor Obsidian
			// places on file open is programmatic, not the user asking for raw
			// source (it routinely lands inside a block that starts at offset 0).
			return { deco: build(plugin, state, null), sel: null };
		},
		update(value, tr) {
			const modeFlipped =
				tr.state.field(editorLivePreviewField, false) !== tr.startState.field(editorLivePreviewField, false);
			const refresh = tr.effects.some((e) => e.is(micaRefreshEffect));
			// The ONLY selections allowed to reveal raw source are USER-driven
			// ones (pointer/keyboard selects, typing, undo). Selections synced
			// back from the DOM without a user event — Obsidian Menu close
			// restoring focus, cold-start cursor restore, native caret escapes —
			// must never flip a block open under the user (they read as "it
			// suddenly shows the whole code block").
			const userDriven =
				tr.isUserEvent("select") ||
				tr.isUserEvent("input") ||
				tr.isUserEvent("delete") ||
				tr.isUserEvent("move") ||
				tr.isUserEvent("undo") ||
				tr.isUserEvent("redo");
			const main = tr.state.selection.main;
			const sel: RevealSel = userDriven
				? { from: main.from, to: main.to }
				: value.sel && tr.docChanged
					? { from: tr.changes.mapPos(value.sel.from), to: tr.changes.mapPos(value.sel.to) }
					: value.sel;
			if (tr.docChanged || modeFlipped || refresh) return { deco: build(plugin, tr.state, sel), sel };
			if (!tr.selection || !userDriven) return sel === value.sel ? value : { deco: value.deco, sel };
			// Outside Live Preview `deco` is already Decoration.none (mode flips
			// always rebuild), which is exactly what build() would return.
			if (!tr.state.field(editorLivePreviewField, false)) return { deco: value.deco, sel };
			// Cursor-only transaction: rebuild only if a block's reveal flipped.
			return revealUnchanged(tr.state, value.sel, sel)
				? { deco: value.deco, sel }
				: { deco: build(plugin, tr.state, sel), sel };
		},
		provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
	});
	// Beat Obsidian's built-in fenced-code handling.
	return Prec.highest(field);
}
