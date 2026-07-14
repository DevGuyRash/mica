import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { scanCached } from "./micaLivePreview";

/**
 * Structure highlighting for mica's OWN syntax whenever a block shows as raw
 * source (cursor inside in Live Preview, or plain source mode): the fence
 * header, `tab:` delimiters, and `:::` directive lines get subtle accent
 * tinting so the block's shape stays readable while editing it raw.
 *
 * Piggybacks on the scanBlocksView single-slot memo — on the doc-changed path
 * this adds zero extra WASM scans, and selection-only transactions reuse the
 * previous decorations untouched.
 */
const fenceLine = Decoration.line({ class: "mica-src-fence" });
const tabLine = Decoration.line({ class: "mica-src-tab" });
const dirLine = Decoration.line({ class: "mica-src-dir" });

function build(state: EditorState): DecorationSet {
	const { blocks, doc: docText } = scanCached(state);
	const doc = state.doc;
	const builder = new RangeSetBuilder<Decoration>();
	for (const b of blocks) {
		let pos = b.start;
		const end = Math.min(b.end, docText.length);
		while (pos < end) {
			const line = doc.lineAt(pos);
			const text = docText.slice(line.from, line.to);
			const t = text.trimStart();
			if (t.startsWith("```")) builder.add(line.from, line.from, fenceLine);
			else if (t.startsWith("tab:")) builder.add(line.from, line.from, tabLine);
			else if (t.startsWith(":::")) builder.add(line.from, line.from, dirLine);
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

export function micaSourceHighlight(): Extension {
	const field = StateField.define<DecorationSet>({
		create(state) {
			return build(state);
		},
		update(deco, tr) {
			if (!tr.docChanged) return deco;
			return build(tr.state);
		},
		provide: (f) => EditorView.decorations.from(f),
	});
	return field;
}
