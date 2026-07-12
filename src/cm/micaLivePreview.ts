import { editorInfoField, editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import { parseBlock, scanBlocks, scanBlocksView, serializeCst, setBlockAttr, type BlockView } from "../wasm/bridge";
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
class MicaWidget extends WidgetType {
	private child: MarkdownRenderChild | null = null;

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
		return other.id === this.id && other.content === this.content && sameAttrs(other.attrs, this.attrs);
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
		let ui = this.plugin.micaUi.get(key);
		if (!ui) {
			ui = { active: new Map(), reveal: null, draft: null, collapsed: false };
			this.plugin.micaUi.set(key, ui);
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
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

// Cache the last scan so pure cursor moves (selection-only transactions) skip
// the WASM scan; a re-scan happens only when the document text changes.
let scanCache: { doc: string; blocks: BlockView[]; attrs: Record<string, string>[] } | null = null;
function scanCached(doc: string): { blocks: BlockView[]; attrs: Record<string, string>[] } {
	if (scanCache && scanCache.doc === doc) return scanCache;
	const blocks = scanBlocksView(doc);
	// Byte-offset scan runs once for the header attrs (appearance, name).
	const attrs = scanBlocks(doc).map((b) => Object.fromEntries(b.attrs));
	scanCache = { doc, blocks, attrs };
	return scanCache;
}

/**
 * Build replace-decorations for every closed ` ```mica ` block not under the
 * cursor. Runs in a StateField (not a ViewPlugin) because CodeMirror only
 * accepts block-level decorations when they are provided directly.
 */
function build(plugin: MicaPlugin, state: EditorState): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const doc = state.doc.toString();
	const sel = state.selection.main;
	const ranges = [];
	const { blocks, attrs } = scanCached(doc);
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		if (!b.closed) continue;
		// End at the closing fence line's end, not past its newline: block replace
		// decorations must cover whole lines exactly.
		const to = doc.charCodeAt(b.end - 1) === 10 ? b.end - 1 : b.end;
		// Reveal the raw source while the caret/selection is inside the block
		// (arrow-keying in, or an explicit click on the revealed source).
		if (sel.from <= to && sel.to >= b.start) continue;
		const content = doc.slice(b.content_start, b.content_end);
		ranges.push(
			Decoration.replace({
				widget: new MicaWidget(plugin, b.id, b.start, content, attrs[i] ?? {}),
				block: true,
			}).range(b.start, to),
		);
	}
	return Decoration.set(ranges, true);
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
			if (tr.docChanged || tr.selection || modeFlipped) return build(plugin, tr.state);
			return deco;
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	// Beat Obsidian's built-in fenced-code handling.
	return Prec.highest(field);
}
