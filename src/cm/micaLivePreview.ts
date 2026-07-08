import { editorInfoField, editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import { parseBlock, scanBlocksView, serializeCst, type BlockView, type Cst } from "../wasm/bridge";
import { renderCst, type BlockUi } from "../render/layoutEngine";
import { applyOp, revealFor, type StructOp } from "../cst/ops";

/**
 * The rendered widget shown in place of a ` ```mica ` block in Live Preview.
 * Every edit — typing in a region or a structural op — is applied to the block's
 * CST and dispatched as one change whose bounds are recomputed from a live
 * re-scan, so it can't corrupt the document and works even before a block has an
 * id. Per-block UI state (active tab + a one-shot focus target) lives on the
 * plugin, keyed by id/position, so it survives the rebuild each edit triggers.
 */
class MicaWidget extends WidgetType {
	private child: MarkdownRenderChild | null = null;

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly id: string | null,
		private readonly start: number,
		private readonly content: string,
	) {
		super();
	}

	eq(other: MicaWidget): boolean {
		return other.id === this.id && other.content === this.content;
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
			editable: { apply: (op) => this.apply(view, op, ui) },
			editorAutosize: this.plugin.settings.editorAutosize,
			chip,
			ui,
		});
		return el;
	}

	/** Per-block UI state, kept on the plugin so it survives widget rebuilds. */
	private blockUi(): BlockUi {
		const key = this.id ?? `@${this.start}`;
		let ui = this.plugin.micaUi.get(key);
		if (!ui) {
			ui = { active: new Map(), reveal: null };
			this.plugin.micaUi.set(key, ui);
		}
		return ui;
	}

	/** Apply one structural op to the block's CST and dispatch it live. */
	private apply(view: EditorView, op: StructOp, ui: BlockUi): void {
		ui.reveal = revealFor(op);
		this.structuralEdit(view, (cst) => {
			if (!applyOp(cst, op)) ui.reveal = null; // no-op op → don't reveal
		});
	}

	private structuralEdit(view: EditorView, mutate: (cst: Cst) => void): void {
		const doc = view.state.doc.toString();
		const live = scanBlocksView(doc).find((b) => (this.id ? b.id === this.id : b.start === this.start));
		if (!live) return;
		const before = doc.slice(live.content_start, live.content_end);
		const cst = parseBlock(before);
		mutate(cst);
		let after = serializeCst(cst);
		// A closed block's content always ends at the closing fence's line start, so
		// it must end in a newline — otherwise typing newline-free text would glue
		// the last line onto the ``` and break the fence. Guarantee it here, the one
		// place every edit is written.
		if (after.length && !after.endsWith("\n")) after += "\n";
		if (after === before) return; // aborted / no change — never churn the doc
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

// Cache the last scan so pure cursor moves (selection-only transactions) skip
// the WASM scan; a re-scan happens only when the document text changes.
let scanCache: { doc: string; blocks: BlockView[] } | null = null;
function scanCached(doc: string): BlockView[] {
	if (scanCache && scanCache.doc === doc) return scanCache.blocks;
	const blocks = scanBlocksView(doc);
	scanCache = { doc, blocks };
	return blocks;
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
	for (const b of scanCached(doc)) {
		if (!b.closed) continue;
		// End at the closing fence line's end, not past its newline: block replace
		// decorations must cover whole lines exactly.
		const to = doc.charCodeAt(b.end - 1) === 10 ? b.end - 1 : b.end;
		// Reveal the raw source while the cursor/selection is inside the block.
		if (sel.from <= to && sel.to >= b.start) continue;
		const content = doc.slice(b.content_start, b.content_end);
		ranges.push(
			Decoration.replace({ widget: new MicaWidget(plugin, b.id, b.start, content), block: true }).range(
				b.start,
				to,
			),
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
