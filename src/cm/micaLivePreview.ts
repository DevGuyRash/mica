import {
	editorInfoField,
	editorLivePreviewField,
	MarkdownRenderChild,
	MarkdownView,
	Menu,
	Notice,
	setIcon,
	TFile,
} from "obsidian";
import type { MarkdownFileInfo } from "obsidian";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorState, Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import {
	guardedBlockContentEdit,
	guardedBlockContentEditAt,
	parseBlock,
	scanBlocksView,
	setBlockAttrEdit,
	contentSignature,
	type BlockView,
} from "../wasm/bridge";
import { renderCst, resumeBlockAppearance, type BlockUi, type RenderCtx } from "../ui/blockShell";
import { applyOpsText, applyOpText, revealFor, type StructOp } from "../cst/ops";
import { getBlockUi } from "../render/blockUiState";
import type { BlockApplyHost, CrossBlockMove } from "../ui/dnd";
import { noteBasenameFromPath, unnamedBlockOrdinals } from "../identity/blockLabel";
import { VersionsModal, type WorkingCopyProvider } from "../ui/versionsModal";
import { readObject } from "../storage/sidecar";
import { blockEditHistory } from "./blockEditHistory";
import { revertBlockToHead, saveBlockVersion } from "../ui/versionActions";
import { copyOptionsFromSettings } from "../ui/copyPayload";
import { writeClipboardProjection } from "../ui/clipboard";
import { DEFAULT_DOCK_ACTION_LAYOUT, DOCK_ACTION_OPTIONS, type DockActionId } from "../ui/dockConfig";
import {
	compactDockTargetLabel,
	copyTargetForScope,
	dockCopyTargetDescription,
	DockScopeCursorIndex,
	DockTargetController,
	type DockTargetState,
} from "../ui/dockScope";
import { buildDockRuntimeSource, type DockRuntimeSource } from "../ui/dockScopeRuntime";
import { DockScopePicker } from "../ui/dockScopePicker";
import { mountResponsiveActionStrip, type MountedResponsiveActionStrip } from "../ui/responsiveActionStrip";
import type { ActionSpec } from "../ui/actionMenu";

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
		const win = view.dom.win;
		// Obsidian installs global DOM helpers in every workspace window.
		const el = (win as Window & { createDiv: typeof createDiv }).createDiv();
		el.className = "mica-lp";
		const child = new MarkdownRenderChild(el);
		this.child = child;
		this.plugin.addChild(child);
		const info = view.state.field(editorInfoField, false);
		const sourcePath = info?.file?.path ?? this.plugin.app.workspace.getActiveFile()?.path ?? "";
		const chip =
			this.id && info?.file
				? {
						plugin: this.plugin,
						file: info.file,
						blockId: this.id,
						content: this.content,
						workingCopy: workingCopyProvider(this.plugin, view, info),
						recordDocuments: (before: string, after: string, blockIds: readonly string[]) =>
							blockEditHistory(view).recordDocuments(before, after, blockIds),
						acknowledgeExactState: (
							document: string,
							blockIds: readonly string[],
							state: "done" | "undone",
						) => {
							const acknowledged = blockEditHistory(view).acknowledgeExactState(
								document,
								blockIds,
								state,
							);
							if (acknowledged) {
								bumpConfigEpoch();
								view.dispatch({ effects: micaRefreshEffect.of(null) });
							}
							return acknowledged;
						},
					}
				: undefined;
		const ui = this.blockUi(sourcePath);
		// Cross-block drops need the TARGET block's op hook: expose it on the
		// root (apply relocates the block by id, so a stale widget stays safe).
		el.dataset.micaBlockId = this.id ?? "";
		el.dataset.micaSourceStart = String(this.start);
		const host = el as BlockApplyHost;
		host.micaContent = this.content;
		host.micaApply = (op) => this.apply(view, op, ui);
		const applyMany = (ops: readonly StructOp[]): boolean => this.applyMany(view, ops, ui);
		host.micaApplyMany = applyMany;
		host.micaMoveAcross = (move) => this.moveAcross(view, move);
		const renderCtx: RenderCtx = {
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
			copyOptions: () => copyOptionsFromSettings(this.plugin.settings),
			entityActionLayout: this.plugin.settings.entityActionLayout,
			showTabActionMenuOnHover: this.plugin.settings.showTabActionMenuOnHover,
			longBlockControls: this.plugin.settings.longBlockControls,
			dockCopyTargetMode: this.plugin.settings.dockCopyTargetMode,
			dockActionLayout: this.plugin.settings.dockActionLayout,
			hiddenSectionActions: new Set(this.plugin.settings.hiddenSectionActions),
			preImage: () => this.liveContent(view) ?? this.content,
			editHistory: this.id
				? {
						canUndo: () => blockEditHistory(view).canUndo(this.id as string),
						canRedo: () => blockEditHistory(view).canRedo(this.id as string),
						undo: () => blockEditHistory(view).undo(this.id as string),
						redo: () => blockEditHistory(view).redo(this.id as string),
					}
				: undefined,
			suppressSourceReveal: () =>
				view.dispatch({ effects: micaSuppressWidgetRevealEffect.of(Date.now() + 1000) }),
		};
		renderCst(parseBlock(this.content), el, renderCtx);
		if (ui.appearanceOpen) {
			let frame = 0;
			let attempts = 0;
			const resume = (): void => {
				frame = 0;
				if (!ui.appearanceOpen) return;
				if (el.isConnected) {
					resumeBlockAppearance(el, renderCtx);
					return;
				}
				if (++attempts < 120) frame = win.requestAnimationFrame(resume);
			};
			frame = win.requestAnimationFrame(resume);
			child.register(() => {
				if (frame) win.cancelAnimationFrame(frame);
			});
		}
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
		blockEditHistory(view).recordChanges(doc, changes, [this.id, move.sourceId]);
		view.dispatch({ changes });
		return true;
	}

	/** Replace the whole block body (undo toasts, whole-block lightbox edits). */
	private replaceAll(view: EditorView, expected: string, content: string): boolean {
		if (this.id) {
			const edit = guardedBlockContentEdit(view.state.doc.toString(), this.id, expected, content);
			if (!edit) return false;
			blockEditHistory(view).recordChanges(view.state.doc.toString(), [edit], [this.id]);
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
		blockEditHistory(view).recordChanges(doc, [edit], [this.id]);
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
		if (this.id) blockEditHistory(view).recordChanges(doc, [edit], [this.id]);
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
const micaSuppressWidgetRevealEffect = StateEffect.define<number>();
const micaAllowKeyboardRevealEffect = StateEffect.define<number>();

/** Bump the widget identity epoch (pair with dispatching the effect). */
export function bumpConfigEpoch(): void {
	configEpoch++;
}

/** Decorations plus the user-driven selection they were revealed against. */
interface RevealState {
	deco: DecorationSet;
	sel: RevealSel;
	suppressUntil: number;
	allowKeyboardUntil: number;
}

/** The Live Preview editor extension. Registered via `registerEditorExtension`. */
export function micaLivePreview(plugin: MicaPlugin): Extension {
	const field = StateField.define<RevealState>({
		create(state) {
			// Nothing is revealed at create time: the restore-cursor Obsidian
			// places on file open is programmatic, not the user asking for raw
			// source (it routinely lands inside a block that starts at offset 0).
			return { deco: build(plugin, state, null), sel: null, suppressUntil: 0, allowKeyboardUntil: 0 };
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
			// suddenly shows the whole code block"). A select-style transaction
			// newly entering a rendered widget is likewise chrome focus, not a
			// request for source; keyboard movement uses the separate move event.
			const userDriven =
				tr.isUserEvent("select") ||
				tr.isUserEvent("input") ||
				tr.isUserEvent("delete") ||
				tr.isUserEvent("move") ||
				tr.isUserEvent("undo") ||
				tr.isUserEvent("redo");
			const suppressUntil = tr.effects.reduce(
				(latest, effect) =>
					effect.is(micaSuppressWidgetRevealEffect) ? Math.max(latest, effect.value) : latest,
				value.suppressUntil,
			);
			const allowKeyboardUntil = tr.effects.reduce(
				(latest, effect) =>
					effect.is(micaAllowKeyboardRevealEffect) ? Math.max(latest, effect.value) : latest,
				value.allowKeyboardUntil,
			);
			const main = tr.state.selection.main;
			const selectionEnteredWidget =
				tr.state.field(editorLivePreviewField, false) &&
				tr.isUserEvent("select") &&
				Date.now() > allowKeyboardUntil &&
				selectionNewlyEntersBlock(tr.state, tr.startState.selection.main, main);
			const suppressReveal = userDriven && (Date.now() <= suppressUntil || selectionEnteredWidget);
			const sel: RevealSel = suppressReveal
				? value.sel && tr.docChanged
					? { from: tr.changes.mapPos(value.sel.from), to: tr.changes.mapPos(value.sel.to) }
					: value.sel
				: userDriven
					? { from: main.from, to: main.to }
					: value.sel && tr.docChanged
						? { from: tr.changes.mapPos(value.sel.from), to: tr.changes.mapPos(value.sel.to) }
						: value.sel;
			if (tr.docChanged || modeFlipped || refresh)
				return { deco: build(plugin, tr.state, sel), sel, suppressUntil, allowKeyboardUntil };
			if (!tr.selection || !userDriven)
				return sel === value.sel &&
					suppressUntil === value.suppressUntil &&
					allowKeyboardUntil === value.allowKeyboardUntil
					? value
					: { deco: value.deco, sel, suppressUntil, allowKeyboardUntil };
			// Outside Live Preview `deco` is already Decoration.none (mode flips
			// always rebuild), which is exactly what build() would return.
			if (!tr.state.field(editorLivePreviewField, false))
				return { deco: value.deco, sel, suppressUntil, allowKeyboardUntil };
			// Cursor-only transaction: rebuild only if a block's reveal flipped.
			return revealUnchanged(tr.state, value.sel, sel)
				? { deco: value.deco, sel, suppressUntil, allowKeyboardUntil }
				: { deco: build(plugin, tr.state, sel), sel, suppressUntil, allowKeyboardUntil };
		},
		provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
	});
	const widgetPointerGuard = EditorView.domEventHandlers({
		pointerdown: guardWidgetChrome,
		mousedown: guardWidgetChrome,
		keydown: allowKeyboardReveal,
	});
	// Beat Obsidian's built-in fenced-code handling.
	return [Prec.highest(field), Prec.highest(widgetPointerGuard), sourceBlockDock(plugin)];
}

const SOURCE_NAVIGATION_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

function allowKeyboardReveal(event: KeyboardEvent, view: EditorView): boolean {
	if (!SOURCE_NAVIGATION_KEYS.has(event.key)) return false;
	view.dispatch({ effects: micaAllowKeyboardRevealEffect.of(Date.now() + 1000) });
	return false;
}

function guardWidgetChrome(event: Event, view: EditorView): boolean {
	const target = event.target as Node | null;
	if (!target?.instanceOf(HTMLElement)) return false;
	if (!target.closest(".mica-lp") || target.closest("a, .internal-link")) return false;
	const markdown = target.closest<HTMLElement>(".mica-md");
	const selectableProse = Boolean(markdown?.textContent?.trim() && !markdown.querySelector(".mica-ghost"));
	const editor = target.closest('input, textarea, [contenteditable="true"], .mica-mdeditor');
	if (selectableProse || editor) return false;
	event.preventDefault();
	view.dispatch({ effects: micaSuppressWidgetRevealEffect.of(Date.now() + 1000) });
	return true;
}

function selectionNewlyEntersBlock(
	state: EditorState,
	previous: RevealSel,
	next: { from: number; to: number },
): boolean {
	const { blocks, tos } = scanCached(state);
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block.closed) continue;
		const to = tos[index];
		if (next.from > to || next.to < block.start) continue;
		const previousInside = previous ? previous.from <= to && previous.to >= block.start : false;
		return !previousInside;
	}
	return false;
}

function sourceBlockDock(plugin: MicaPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly dock: HTMLElement;
			private readonly liveDockOverlay: HTMLElement;
			private readonly win: Window;
			private generation = 0;
			private current: BlockView | null = null;
			private frame = 0;
			private renderFallback = 0;
			private menu: Menu | null = null;
			private controlsDirty = true;
			private scopeRuntime: DockRuntimeSource | null = null;
			private scopeSource = "";
			private scopeController: DockTargetController | null = null;
			private scopeCursor: DockScopeCursorIndex | null = null;
			private scopeCopy: HTMLButtonElement | null = null;
			private scopePicker: HTMLButtonElement | null = null;
			private responsiveActions: MountedResponsiveActionStrip | null = null;
			private readonly sourceActionElements = new Map<DockActionId, HTMLButtonElement>();
			private readonly onScroll = (): void => this.scheduleRender();

			constructor(private readonly view: EditorView) {
				this.win = view.dom.win;
				this.liveDockOverlay = this.view.dom.createDiv({ cls: "mica-live-long-dock-overlay" });
				this.dock = this.view.dom.createDiv({ cls: "mica-source-dock" });
				this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
				this.scheduleRender();
			}

			update(update: ViewUpdate): void {
				blockEditHistory(this.view).recordRawUpdate(update, this.current);
				const refreshed = update.transactions.some((transaction) =>
					transaction.effects.some((effect) => effect.is(micaRefreshEffect)),
				);
				if (refreshed) this.controlsDirty = true;
				if (
					update.docChanged ||
					update.selectionSet ||
					update.viewportChanged ||
					update.geometryChanged ||
					refreshed
				)
					this.scheduleRender();
			}

			destroy(): void {
				this.generation++;
				if (this.frame) this.win.cancelAnimationFrame(this.frame);
				if (this.renderFallback) this.win.clearTimeout(this.renderFallback);
				this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
				this.menu?.hide();
				this.menu = null;
				this.scopeController = null;
				this.scopeRuntime = null;
				this.scopeCursor = null;
				this.responsiveActions?.destroy();
				this.responsiveActions = null;
				this.dock.remove();
				this.liveDockOverlay.remove();
			}

			private scheduleRender(): void {
				if (this.frame || this.renderFallback) return;
				const run = (): void => {
					if (!this.frame && !this.renderFallback) return;
					if (this.frame) this.win.cancelAnimationFrame(this.frame);
					if (this.renderFallback) this.win.clearTimeout(this.renderFallback);
					this.frame = 0;
					this.renderFallback = 0;
					this.render();
				};
				this.frame = this.win.requestAnimationFrame(run);
				this.renderFallback = this.win.setTimeout(run, 50);
			}

			private render(): void {
				const mode = plugin.settings.longBlockControls;
				const info = this.view.state.field(editorInfoField, false);
				const head = this.view.state.selection.main.head;
				const cache = scanCached(this.view.state);
				const block = cache.blocks.find(
					(candidate) => candidate.closed && head >= candidate.start && head <= candidate.end,
				);
				const livePreview = this.view.state.field(editorLivePreviewField, false);
				const rendered =
					livePreview &&
					block &&
					this.view.dom.querySelector(
						`.mica-lp[data-mica-source-start="${CSS.escape(String(block.start))}"]`,
					);
				if (
					!block ||
					mode === "off" ||
					rendered ||
					block.end < this.view.viewport.from ||
					block.start > this.view.viewport.to
				) {
					if (this.current) {
						this.generation++;
						this.menu?.hide();
						this.menu = null;
					}
					this.current = null;
					this.dock.hidden = true;
					return;
				}
				const start = this.view.lineBlockAt(block.start);
				const end = this.view.lineBlockAt(Math.max(block.start, block.end - 1));
				const height = end.bottom - start.top;
				const viewportHeight = this.view.scrollDOM.clientHeight;
				if (height <= 800 || height <= viewportHeight * 1.25) {
					if (this.current) {
						this.generation++;
						this.menu?.hide();
						this.menu = null;
					}
					this.current = null;
					this.dock.hidden = true;
					return;
				}
				const scrollTop = this.view.scrollDOM.scrollTop;
				const scrollBottom = scrollTop + viewportHeight;
				const openingVisible = start.top >= scrollTop && start.top <= scrollBottom;
				const closingVisible = end.bottom >= scrollTop && end.bottom <= scrollBottom;
				const placement = openingVisible ? "top" : closingVisible ? "bottom" : "middle";
				const sameControls =
					!this.controlsDirty &&
					this.current === block &&
					!this.dock.hidden &&
					this.dock.dataset.micaSourceMode === mode;
				this.current = block;
				this.dock.hidden = false;
				this.dock.dataset.micaSourcePlacement = placement;
				this.dock.dataset.micaSourceMode = mode;
				this.position(block, placement);
				this.updateScopeTarget(block, info);
				if (sameControls) return;
				this.menu?.hide();
				this.menu = null;
				this.responsiveActions?.destroy();
				this.responsiveActions = null;
				this.sourceActionElements.clear();
				this.dock.empty();
				this.buildControls(mode, info, block);
				this.controlsDirty = false;
			}

			private position(block: BlockView, placement: "top" | "middle" | "bottom"): void {
				const editorRect = this.view.dom.getBoundingClientRect();
				const startCoords = this.view.coordsAtPos(block.start);
				const endCoords = this.view.coordsAtPos(Math.max(block.start, block.end - 1));
				this.dock.style.removeProperty("top");
				this.dock.style.removeProperty("bottom");
				if (placement === "top" && startCoords)
					this.dock.style.top = `${Math.max(8, startCoords.top - editorRect.top)}px`;
				else if (placement === "bottom" && endCoords)
					this.dock.style.bottom = `${Math.max(8, editorRect.bottom - endCoords.bottom)}px`;
			}

			private buildControls(
				mode: "contextual" | "jumps-only",
				info: MarkdownFileInfo | undefined,
				block: BlockView,
			): void {
				if (mode === "contextual") {
					const name = this.dock.createSpan({
						cls: "mica-source-dock-name",
						text: block.name?.trim() || info?.file?.basename || "Unnamed block",
					});
					name.title = name.textContent ?? "";
					if (this.actionEnabled("copy")) {
						const scopeGroup = this.dock.createDiv({ cls: "mica-source-dock-scope" });
						this.scopeCopy = this.button(
							"copy",
							"Copy current scope",
							() => this.copy(block),
							scopeGroup,
							"copy",
						);
						this.scopePicker = scopeGroup.createEl("button", {
							cls: "clickable-icon mica-source-dock-target",
							attr: { type: "button", "aria-label": "Choose clipboard scope" },
						});
						this.scopePicker.createSpan({ cls: "mica-source-dock-target-text" });
						setIcon(
							this.scopePicker.createSpan({ cls: "mica-source-dock-target-chevron" }),
							"chevron-down",
						);
						this.scopePicker.addEventListener("click", () => {
							const controller = this.scopeController;
							if (!controller) return;
							new DockScopePicker(plugin.app, controller, () => this.copy(block, true)).open();
						});
					}
					const localHistory = blockEditHistory(this.view);
					if (
						this.actionEnabled("save") &&
						!plugin.settings.autoSnapshotEnabled &&
						block.id &&
						info?.file instanceof TFile
					)
						this.button("save", "Save version", () => void this.save(info, block), this.dock, "save");
					if (
						block.id &&
						(this.actionEnabled("undo") || this.actionEnabled("redo")) &&
						(localHistory.canUndo(block.id) || localHistory.canRedo(block.id))
					) {
						const editHistory = this.dock.createDiv({
							cls: "mica-source-edit-controls",
							attr: { role: "group", "aria-label": "Block edit history" },
						});
						if (this.actionEnabled("undo") && localHistory.canUndo(block.id))
							this.button(
								"undo-2",
								"Undo last block edit",
								() => localHistory.undo(block.id as string),
								editHistory,
								"undo",
							);
						if (this.actionEnabled("redo") && localHistory.canRedo(block.id))
							this.button(
								"redo-2",
								"Redo last block edit",
								() => localHistory.redo(block.id as string),
								editHistory,
								"redo",
							);
					}
					const revert = this.button(
						"rotate-ccw",
						"Revert all block changes to HEAD",
						() => {
							if (!(info?.file instanceof TFile) || !block.id) return;
							void revertBlockToHead(plugin, info.file, block.id, {
								workingCopy: workingCopyProvider(plugin, this.view, info),
								recordDocuments: (before, after, blockIds) =>
									blockEditHistory(this.view).recordDocuments(before, after, blockIds),
								acknowledgeExactState: (document, blockIds, state) => {
									const acknowledged = blockEditHistory(this.view).acknowledgeExactState(
										document,
										blockIds,
										state,
									);
									if (acknowledged) {
										bumpConfigEpoch();
										this.view.dispatch({ effects: micaRefreshEffect.of(null) });
									}
									return acknowledged;
								},
							});
						},
						this.dock,
						"revert",
					);
					revert.hidden = true;
					revert.dataset.micaDockAvailable = "false";
					if (!this.actionEnabled("revert")) revert.remove();
					revert.hidden = true;
					const history = this.button(
						"history",
						"Version history",
						() => {
							if (!(info?.file instanceof TFile) || !block.id) return;
							new VersionsModal(
								plugin,
								info.file,
								block.id,
								workingCopyProvider(plugin, this.view, info),
							).open();
						},
						this.dock,
						"history",
					);
					if (!this.actionEnabled("history")) history.remove();
					history.disabled = !block.id || !(info?.file instanceof TFile);
					if (history.disabled) history.title = "Version history requires a stable block ID.";
					const count = history.createSpan({ cls: "mica-source-dock-count", text: "…" });
					if (block.id && info)
						history.addEventListener("contextmenu", (event) => {
							event.preventDefault();
							event.stopPropagation();
							const id = block.id as string;
							const menu = new Menu();
							this.menu = menu;
							menu.addItem((item) =>
								item
									.setTitle(localHistory.canUndo(id) ? "Undo last block edit" : "Undo unavailable")
									.setIcon("undo-2")
									.setDisabled(!localHistory.canUndo(id))
									.onClick(() => localHistory.undo(id)),
							);
							menu.addItem((item) =>
								item
									.setTitle(localHistory.canRedo(id) ? "Redo last block edit" : "Redo unavailable")
									.setIcon("redo-2")
									.setDisabled(!localHistory.canRedo(id))
									.onClick(() => localHistory.redo(id)),
							);
							menu.addItem((item) =>
								item
									.setTitle(
										revert.dataset.micaDockAvailable !== "true"
											? "Block already matches HEAD"
											: "Revert all block changes to HEAD",
									)
									.setIcon("rotate-ccw")
									.setDisabled(revert.dataset.micaDockAvailable !== "true")
									.onClick(() => revert.click()),
							);
							menu.addSeparator();
							menu.addItem((item) =>
								item
									.setTitle("Save version now")
									.setIcon("save")
									.onClick(() => void this.save(info, block)),
							);
							menu.showAtMouseEvent(event);
						});
					if (info && (this.actionEnabled("history") || this.actionEnabled("revert")))
						void this.refreshStatus(info, block, count, history, revert);
				}
				if (this.actionEnabled("jump-top"))
					this.button(
						"arrow-up-to-line",
						"Jump to top of block",
						() =>
							this.view.dispatch({
								effects: EditorView.scrollIntoView(block.start, { y: "start", yMargin: 12 }),
							}),
						this.dock,
						"jump-top",
					);
				if (this.actionEnabled("jump-bottom"))
					this.button(
						"arrow-down-to-line",
						"Jump to bottom of block",
						() =>
							this.view.dispatch({
								effects: EditorView.scrollIntoView(block.end, { y: "end", yMargin: 12 }),
							}),
						this.dock,
						"jump-bottom",
					);
				this.mountSourceResponsiveActions();
				this.updateScopeTarget(block, info);
			}

			private actionEnabled(id: DockActionId): boolean {
				return (plugin.settings.dockActionLayout ?? DEFAULT_DOCK_ACTION_LAYOUT).includes(id);
			}

			private button(
				icon: string,
				label: string,
				run: () => void,
				parent: HTMLElement = this.dock,
				actionId?: DockActionId,
			): HTMLButtonElement {
				const button = parent.createEl("button", {
					cls: "clickable-icon mica-source-dock-button",
					attr: { type: "button", "aria-label": label, title: label },
				});
				setIcon(button, icon);
				button.addEventListener("click", run);
				if (actionId) {
					button.dataset.micaDockAction = actionId;
					this.sourceActionElements.set(actionId, button);
				}
				return button;
			}

			private mountSourceResponsiveActions(): void {
				const actions = (): ActionSpec[] =>
					(plugin.settings.dockActionLayout ?? DEFAULT_DOCK_ACTION_LAYOUT)
						.filter((id) => id !== "copy" && id !== "history")
						.map((id, index): ActionSpec | null => {
							const element = this.sourceActionElements.get(id);
							const definition = DOCK_ACTION_OPTIONS.find((option) => option.id === id);
							if (!element || !definition || element.dataset.micaDockAvailable === "false") return null;
							return {
								id,
								label: element.ariaLabel ?? definition.label,
								icon: definition.icon,
								directPriority: Math.min(4, index) as 0 | 1 | 2 | 3 | 4,
								danger: id === "revert",
								disabled: element.disabled,
								run: () => element.click(),
							};
						})
						.filter((action): action is ActionSpec => action !== null);
				const host = this.dock.createDiv({ cls: "mica-source-dock-responsive-host" });
				this.responsiveActions = mountResponsiveActionStrip(host, actions, {
					app: plugin.app,
					source: this.view.dom,
					label: "Source dock actions",
					className: "mica-source-dock-responsive-actions",
					buttonClass: "mica-source-dock-button",
					menuClass: "mica-source-dock-button",
					reservedWidth: () =>
						(this.dock.querySelector<HTMLElement>(".mica-source-dock-name")?.offsetWidth ?? 0) +
						(this.dock.querySelector<HTMLElement>(".mica-source-dock-scope")?.offsetWidth ?? 0) +
						(this.sourceActionElements.get("history")?.offsetWidth ?? 0) +
						32,
				});
				for (const [id, element] of this.sourceActionElements) {
					if (id === "copy" || id === "history") continue;
					element.hidden = true;
				}
				for (const group of this.dock.querySelectorAll<HTMLElement>(".mica-source-edit-controls"))
					group.hidden = true;
			}

			private copy(block: BlockView, wholeBlock = false): void {
				const document = this.view.state.doc.toString();
				const head = this.view.state.selection.main.head;
				const blocks = scanBlocksView(document);
				const current = block.id
					? blocks.find((candidate) => candidate.closed && candidate.id === block.id)
					: blocks.find(
							(candidate) =>
								candidate.closed &&
								(candidate.start === block.start || (head >= candidate.start && head <= candidate.end)),
						);
				if (!current) {
					new Notice("Mica: this block changed before it could be copied. Try again.");
					return;
				}
				try {
					const content = document.slice(current.content_start, current.content_end);
					const runtime = buildDockRuntimeSource(content);
					const resolved = wholeBlock
						? runtime.index.byKey.get("block:")
						: this.scopeController?.resolveIn(runtime.index)?.scope;
					if (!resolved) {
						new Notice("Mica: the selected copy scope changed or became ambiguous. Choose it again.");
						return;
					}
					const target = copyTargetForScope(runtime.cst, runtime.source, resolved);
					if (!target) {
						new Notice("Mica: the selected copy scope is stale. Choose it again.");
						return;
					}
					writeClipboardProjection(
						target,
						copyOptionsFromSettings(plugin.settings),
						`${wholeBlock ? "Whole block" : (this.scopeController?.describe(resolved).label ?? "Scope")} copied.`,
					);
				} catch {
					new Notice("Mica: this block could not be parsed for copying.");
				}
			}

			private updateScopeTarget(block: BlockView, info: MarkdownFileInfo | undefined): void {
				if (!this.scopeCopy && !this.scopePicker) return;
				const source = this.view.state.doc.sliceString(block.content_start, block.content_end);
				if (!this.scopeRuntime || source !== this.scopeSource) {
					try {
						this.scopeRuntime = buildDockRuntimeSource(source);
						this.scopeSource = source;
						this.scopeCursor = new DockScopeCursorIndex(this.scopeRuntime.index);
						const ui = getBlockUi(plugin, block.id ?? `@${info?.file?.path ?? ""}:${block.start}`);
						this.scopeController = new DockTargetController(
							this.scopeRuntime.index,
							this.scopeRuntime.cst,
							() => plugin.settings.dockCopyTargetMode,
							{
								get: () => ui.dockPinnedScope,
								set: (locator) => {
									ui.dockPinnedScope = locator;
								},
							},
						);
						this.scopeController.subscribe((target) => this.paintScopeTarget(target));
					} catch {
						this.scopeRuntime = null;
						this.scopeController = null;
						this.scopeCursor = null;
					}
				}
				const controller = this.scopeController;
				const cursor = this.scopeCursor;
				if (!controller || !cursor) return;
				const selection = this.view.state.selection.main;
				const from = Math.max(0, Math.min(source.length, selection.from - block.content_start));
				const to = Math.max(from, Math.min(source.length, selection.to - block.content_start));
				controller.setFocused(cursor.containing(from, to).key);
				this.paintScopeTarget(controller.current());
			}

			private paintScopeTarget(target: DockTargetState): void {
				const reason =
					target.reason === "automatic"
						? "Automatic"
						: target.reason === "focused"
							? "Focused"
							: target.reason === "pinned"
								? "Pinned"
								: target.reason === "manual"
									? "Manual"
									: "Whole block";
				const breadcrumb = target.breadcrumb.join(" › ");
				const compact = compactDockTargetLabel(target);
				const description = dockCopyTargetDescription(target);
				if (this.scopeCopy) {
					this.scopeCopy.ariaLabel = `Copy ${description}`;
					this.scopeCopy.title = `Copy ${breadcrumb}`;
				}
				if (this.scopePicker) {
					this.scopePicker.querySelector<HTMLElement>(".mica-source-dock-target-text")?.setText(compact);
					this.scopePicker.ariaLabel = `Change copy target. ${reason}: ${description}`;
					this.scopePicker.title = `${reason} copy target · ${breadcrumb}`;
					this.scopePicker.dataset.micaDockTargetReason = target.reason;
					this.scopePicker.dataset.micaDockTargetKind = target.scope.kind;
				}
			}

			private async save(info: MarkdownFileInfo, block: BlockView): Promise<void> {
				if (!(info instanceof MarkdownView) || !info.file || !block.id) return;
				await saveBlockVersion(plugin, info.file, block.id, {
					workingCopy: workingCopyProvider(plugin, this.view, info),
				});
			}

			private async refreshStatus(
				info: MarkdownFileInfo,
				block: BlockView,
				count: HTMLElement,
				history: HTMLElement,
				revert: HTMLButtonElement,
			): Promise<void> {
				if (!(info?.file instanceof TFile) || !block.id) {
					count.setText("—");
					return;
				}
				const generation = ++this.generation;
				try {
					const state = (await plugin.engine.state(info.file))[block.id];
					if (generation !== this.generation || this.current !== block) return;
					count.setText(String(state?.versions.length ?? 0));
					const currentHead = state?.rawHead ?? state?.head;
					const head = currentHead ? await readObject(plugin.app.vault, info.file, currentHead) : "";
					if (generation !== this.generation || this.current !== block) return;
					const document = this.view.state.doc.toString();
					const current = document.slice(block.content_start, block.content_end);
					history.toggleClass(
						"is-dirty",
						head === null || contentSignature(head ?? "") !== contentSignature(current),
					);
					const canRevert = Boolean(currentHead && head !== null && head !== current);
					revert.dataset.micaDockAvailable = String(canRevert);
					revert.hidden = Boolean(this.responsiveActions) || !canRevert;
					this.responsiveActions?.refresh();
				} catch {
					count.setText("?");
					history.addClass("is-dirty");
					revert.hidden = true;
					revert.dataset.micaDockAvailable = "false";
					this.responsiveActions?.refresh();
				}
			}
		},
	);
}

function workingCopyProvider(plugin: MicaPlugin, view: EditorView, info: MarkdownFileInfo): WorkingCopyProvider {
	return {
		readDocument: () => (view.dom.isConnected ? view.state.doc.toString() : null),
		flush: async (expectedDocument) => {
			if (!view.dom.isConnected || view.state.doc.toString() !== expectedDocument) return false;
			if (!(info instanceof MarkdownView)) return false;
			await info.save();
			if (view.state.doc.toString() !== expectedDocument || !info.file) return false;
			return (await plugin.app.vault.read(info.file)) === expectedDocument;
		},
	};
}
