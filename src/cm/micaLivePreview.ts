import { editorLivePreviewField, MarkdownRenderChild } from "obsidian";
import { Prec, RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type MicaPlugin from "../main";
import { parseBlock, scanBlocksView } from "../wasm/bridge";
import { renderCst } from "../render/layoutEngine";

/**
 * The rendered widget shown in place of a ` ```mica ` block in Live Preview.
 * `eq()` keyed on (id, content) lets CodeMirror reuse the DOM across unrelated
 * keystrokes instead of rebuilding it.
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
		});
		return el;
	}

	destroy(): void {
		if (this.child) {
			this.plugin.removeChild(this.child);
			this.child = null;
		}
	}

	ignoreEvent(): boolean {
		// The widget owns its clicks (tab switching); CodeMirror shouldn't treat
		// them as editor gestures.
		return true;
	}
}

/** Build replace-decorations for every closed ` ```mica ` block not under the cursor. */
function build(plugin: MicaPlugin, view: EditorView): DecorationSet {
	if (!view.state.field(editorLivePreviewField)) return Decoration.none;
	const doc = view.state.doc.toString();
	const sel = view.state.selection.main;
	const builder = new RangeSetBuilder<Decoration>();
	for (const b of scanBlocksView(doc)) {
		if (!b.closed) continue;
		// Reveal the raw source while the cursor/selection is inside the block.
		if (sel.from <= b.end && sel.to >= b.start) continue;
		const content = doc.slice(b.content_start, b.content_end);
		builder.add(b.start, b.end, Decoration.replace({ widget: new MicaWidget(plugin, b.id, content), block: true }));
	}
	return builder.finish();
}

/** The Live Preview editor extension. Registered via `registerEditorExtension`. */
export function micaLivePreview(plugin: MicaPlugin): Extension {
	const plugin$ = ViewPlugin.fromClass(
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
	return Prec.highest(plugin$);
}
