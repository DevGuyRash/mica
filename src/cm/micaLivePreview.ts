import { editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
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
		private readonly view: EditorView,
		private readonly id: string | null,
		private readonly content: string,
	) {
		super();
	}

	eq(other: MicaWidget): boolean {
		return other.id === this.id && other.content === this.content;
	}

	toDOM(): HTMLElement {
		const el = document.createElement("div");
		el.className = "mica-lp";
		const child = new MarkdownRenderChild(el);
		this.child = child;
		this.plugin.addChild(child);
		renderCst(parseBlock(this.content), el, {
			app: this.plugin.app,
			sourcePath: this.plugin.app.workspace.getActiveFile()?.path ?? "",
			component: child,
			editable: this.id ? { save: (path, text) => this.save(path, text) } : undefined,
		});
		return el;
	}

	private save(path: number[], newText: string): void {
		if (!this.id) return;
		const doc = this.view.state.doc.toString();
		const live = scanBlocksView(doc).find((b) => b.id === this.id);
		if (!live) return;
		const cst = parseBlock(doc.slice(live.content_start, live.content_end));
		const target = nodeAtPath(cst, path);
		if (!target || target.kind !== "container") return;
		target.children = parseBlock(newText).children;
		const change = blockContentEdit(doc, this.id, serializeCst(cst));
		if (!change) return;
		this.view.dispatch({ changes: { from: change.from, to: change.to, insert: change.insert } });
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

// Cache the last scan so cursor moves (selectionSet with no doc change) skip the
// WASM scan entirely; a re-scan happens only when the document actually changes.
let scanCache: { doc: string; blocks: BlockView[] } | null = null;
function scanCached(doc: string): BlockView[] {
	if (scanCache && scanCache.doc === doc) return scanCache.blocks;
	const blocks = scanBlocksView(doc);
	scanCache = { doc, blocks };
	return blocks;
}

function build(plugin: MicaPlugin, view: EditorView): DecorationSet {
	if (!view.state.field(editorLivePreviewField)) return Decoration.none;
	const doc = view.state.doc.toString();
	const sel = view.state.selection.main;
	const builder = new RangeSetBuilder<Decoration>();
	for (const b of scanCached(doc)) {
		if (!b.closed) continue;
		// Reveal the raw source while the cursor/selection is inside the block.
		if (sel.from <= b.end && sel.to >= b.start) continue;
		const content = doc.slice(b.content_start, b.content_end);
		builder.add(
			b.start,
			b.end,
			Decoration.replace({ widget: new MicaWidget(plugin, view, b.id, content), block: true }),
		);
	}
	return builder.finish();
}

/** The Live Preview editor extension. Registered via `registerEditorExtension`. */
export function micaLivePreview(plugin: MicaPlugin): Extension {
	const vp = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(plugin, view);
			}
			update(u: ViewUpdate): void {
				if (u.docChanged || u.viewportChanged || u.selectionSet) {
					this.decorations = build(plugin, u.view);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);
	// Beat Obsidian's built-in fenced-code widget.
	return Prec.highest(vp);
}
