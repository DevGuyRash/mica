import { editorInfoField, editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import { nodeAtPath, parseBlock, scanBlocksView, serializeCst, type BlockView } from "../wasm/bridge";
import { renderCst } from "../render/layoutEngine";

/**
 * The rendered widget shown in place of a ` ```mica ` block in Live Preview.
 * Editing a tab dispatches a change whose bounds are recomputed from a live
 * re-scan at save time (located by id when present, else by the block's start
 * position), so it can't corrupt the document and works even before a block has
 * an id.
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
		renderCst(parseBlock(this.content), el, {
			app: this.plugin.app,
			sourcePath: info?.file?.path ?? this.plugin.app.workspace.getActiveFile()?.path ?? "",
			component: child,
			editable: { save: (path, title, text) => this.save(view, path, title, text) },
			chip,
		});
		return el;
	}

	private save(view: EditorView, path: number[], expectedTitle: string, newText: string): void {
		const doc = view.state.doc.toString();
		const live = scanBlocksView(doc).find((b) => (this.id ? b.id === this.id : b.start === this.start));
		if (!live) return;
		const cst = parseBlock(doc.slice(live.content_start, live.content_end));
		const target = nodeAtPath(cst, path);
		// The path was captured at render time; verify the tab still has the same
		// identity before writing — never write to a guessed node.
		if (!target || target.kind !== "container" || target.name !== "tab" || target.title !== expectedTitle) {
			console.warn("Mica: tab changed underneath the editor; save aborted (re-open to edit).");
			return;
		}
		target.children = parseBlock(newText).children;
		// Dispatch against the LIVE content range (UTF-16 offsets from the re-scan).
		view.dispatch({ changes: { from: live.content_start, to: live.content_end, insert: serializeCst(cst) } });
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
