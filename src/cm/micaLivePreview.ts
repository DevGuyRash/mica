import { editorInfoField, editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, StateField } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import type MicaPlugin from "../main";
import { blockContentEdit, nodeAtPath, parseBlock, scanBlocksView, serializeCst, type BlockView } from "../wasm/bridge";
import { renderCst } from "../render/layoutEngine";

/**
 * The rendered widget shown in place of a ` ```mica ` block in Live Preview.
 * `eq()` keyed on (id, content) lets CodeMirror reuse the DOM across unrelated
 * keystrokes. Editing a tab dispatches a live-recomputed change (never a cached
 * offset), so it can't corrupt the document.
 */
class MicaWidget extends WidgetType {
	private child: MarkdownRenderChild | null = null;

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly id: string | null,
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
		// Resolve the note this editor actually hosts (correct across split
		// panes/popouts, where getActiveFile() may point elsewhere).
		const info = view.state.field(editorInfoField, false);
		renderCst(parseBlock(this.content), el, {
			app: this.plugin.app,
			sourcePath: info?.file?.path ?? this.plugin.app.workspace.getActiveFile()?.path ?? "",
			component: child,
			editable: this.id ? { save: (path, title, text) => this.save(view, path, title, text) } : undefined,
		});
		return el;
	}

	private save(view: EditorView, path: number[], expectedTitle: string, newText: string): void {
		if (!this.id) return;
		const doc = view.state.doc.toString();
		const live = scanBlocksView(doc).find((b) => b.id === this.id);
		if (!live) return;
		const cst = parseBlock(doc.slice(live.content_start, live.content_end));
		const target = nodeAtPath(cst, path);
		// The path was captured at render time; if the block changed underneath
		// (sync, bridge, revert), the same indices may now point at a DIFFERENT
		// node. Verify identity before writing — never write to a guessed node.
		if (!target || target.kind !== "container" || target.name !== "tab" || target.title !== expectedTitle) {
			console.warn("Mica: tab changed underneath the editor; save aborted (re-open to edit).");
			return;
		}
		target.children = parseBlock(newText).children;
		const change = blockContentEdit(doc, this.id, serializeCst(cst));
		if (!change) return;
		view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert } });
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
 * accepts block-level decorations when they are provided directly — a
 * ViewPlugin doing this throws "Block decorations may not be specified via
 * plugins" and takes the whole MarkdownView down with it.
 */
function build(plugin: MicaPlugin, state: EditorState): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const doc = state.doc.toString();
	const sel = state.selection.main;
	const decorations: { from: number; to: number; deco: Decoration }[] = [];
	for (const b of scanCached(doc)) {
		if (!b.closed) continue;
		// End at the closing fence line's end, not past its newline: block
		// replace decorations must cover whole lines exactly.
		const to = doc.charCodeAt(b.end - 1) === 10 ? b.end - 1 : b.end;
		// Reveal the raw source while the cursor/selection is inside the block
		// (clamped range — the line AFTER the block must not count as inside).
		if (sel.from <= to && sel.to >= b.start) continue;
		const content = doc.slice(b.content_start, b.content_end);
		decorations.push({
			from: b.start,
			to,
			deco: Decoration.replace({ widget: new MicaWidget(plugin, b.id, content), block: true }),
		});
	}
	return Decoration.set(decorations.map((d) => d.deco.range(d.from, d.to)));
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
