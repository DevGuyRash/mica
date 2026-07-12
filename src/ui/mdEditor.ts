import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export interface MdEditorOpts {
	initial: string;
	placeholder?: string;
	/** Ctrl/Cmd+Enter — the ONLY keyboard commit. */
	onSave: () => void;
	/** Escape (the host decides whether to confirm when dirty). */
	onCancel: () => void;
	onChange?: (value: string) => void;
	autofocus?: boolean;
}

/**
 * Markdown highlighting mapped onto Obsidian's own CSS variables, so the
 * editor looks native under any theme without shipping colors of our own.
 */
const mdHighlight = HighlightStyle.define([
	{ tag: tags.heading1, class: "mica-mh mica-mh1" },
	{ tag: tags.heading2, class: "mica-mh mica-mh2" },
	{ tag: tags.heading3, class: "mica-mh mica-mh3" },
	{ tag: tags.heading4, class: "mica-mh" },
	{ tag: tags.heading5, class: "mica-mh" },
	{ tag: tags.heading6, class: "mica-mh" },
	{ tag: tags.strong, class: "mica-mstrong" },
	{ tag: tags.emphasis, class: "mica-mem" },
	{ tag: tags.strikethrough, class: "mica-mstrike" },
	{ tag: tags.monospace, class: "mica-mcode" },
	{ tag: tags.quote, class: "mica-mquote" },
	{ tag: tags.link, class: "mica-mlink" },
	{ tag: tags.url, class: "mica-murl" },
	{ tag: tags.processingInstruction, class: "mica-mmark" },
	{ tag: tags.labelName, class: "mica-mmark" },
]);

/**
 * The one markdown editor Mica uses everywhere (quick edit, lightbox, branch
 * edit): CodeMirror 6 with markdown syntax, history, and explicit-save keys.
 * Never commits on blur — Save is a button or Ctrl/Cmd+Enter, full stop.
 */
export class MdEditor {
	readonly view: EditorView;

	constructor(host: HTMLElement, opts: MdEditorOpts) {
		const saveKeys = keymap.of([
			{
				key: "Mod-Enter",
				run: () => {
					opts.onSave();
					return true;
				},
			},
			{
				key: "Escape",
				run: () => {
					opts.onCancel();
					return true;
				},
			},
		]);
		this.view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: opts.initial,
				extensions: [
					// Order matters: our save/cancel keys must beat the defaults.
					saveKeys,
					history(),
					keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
					markdown({ base: markdownLanguage }),
					syntaxHighlighting(mdHighlight),
					EditorView.lineWrapping,
					cmPlaceholder(opts.placeholder ?? "Write markdown…"),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) opts.onChange?.(u.state.doc.toString());
					}),
					EditorView.theme({}, { dark: document.body.hasClass("theme-dark") }),
				],
			}),
		});
		this.view.dom.addClass("mica-mdeditor");
		// E2e affordance: drive the editor without reaching into CM internals.
		(this.view.dom as unknown as { micaEditor?: MdEditor }).micaEditor = this;
		if (opts.autofocus ?? true) {
			// Focus after the current event settles so nothing steals it back.
			queueMicrotask(() => {
				this.view.focus();
				this.view.dom.scrollIntoView({ block: "nearest" });
			});
		}
	}

	getValue(): string {
		return this.view.state.doc.toString();
	}

	setValue(value: string): void {
		this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } });
	}

	focus(): void {
		this.view.focus();
	}

	destroy(): void {
		this.view.destroy();
	}
}
