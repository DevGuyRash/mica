import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { resolveCodeLanguage } from "./codeLangs";
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
	/** Fires on selection movement too (cheap consumers only, e.g. stats). */
	onSelection?: () => void;
	autofocus?: boolean;
}

/**
 * Markdown highlighting mapped onto Obsidian's CSS variables (which inherit
 * across the shadow boundary), styled by the CM theme below.
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
	// Fenced-code tokens: Obsidian's --code-* variables inherit through the
	// shadow boundary, so highlighted code follows the vault theme.
	{ tag: tags.keyword, class: "mica-ck" },
	{ tag: [tags.string, tags.special(tags.string), tags.regexp], class: "mica-cs" },
	{ tag: [tags.comment, tags.lineComment, tags.blockComment], class: "mica-cc" },
	{ tag: [tags.number, tags.bool, tags.atom, tags.null], class: "mica-cv" },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "mica-cf" },
	{ tag: [tags.typeName, tags.className, tags.namespace], class: "mica-ct" },
	{ tag: tags.propertyName, class: "mica-cp" },
	{ tag: [tags.tagName, tags.angleBracket], class: "mica-cg" },
	{ tag: [tags.operator, tags.definitionOperator], class: "mica-co" },
	{ tag: [tags.meta, tags.annotation], class: "mica-cm" },
]);

/**
 * The editor's complete visual identity, expressed as a CodeMirror theme so it
 * is injected INTO the editor's own root. Values lean on CSS custom properties
 * (`--mica-accent`, `--font-text`, …), which inherit across shadow boundaries —
 * so the editor follows Obsidian's theme tokens without being reachable by any
 * theme's selectors.
 */
const micaEditorTheme = EditorView.theme({
	"&": {
		backgroundColor: "transparent",
		fontSize: "var(--font-text-size, 16px)",
		color: "var(--text-normal, #ddd)",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		overflow: "auto",
		lineHeight: "1.55",
		fontFamily: "var(--font-text, sans-serif)",
	},
	".cm-content": {
		padding: "8px 10px",
		caretColor: "var(--mica-accent, var(--text-accent))",
		minHeight: "2.2em",
	},
	".cm-line": { padding: "1px 4px" },
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--mica-accent, var(--text-accent))" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
		background: "color-mix(in srgb, var(--mica-accent, #7c5cff) 25%, transparent)",
	},
	".cm-activeLine": { background: "color-mix(in srgb, var(--mica-accent, #7c5cff) 7%, transparent)" },
	".cm-placeholder": { color: "var(--text-faint, #888)", fontStyle: "italic" },
	".mica-mh": { fontWeight: "700", color: "var(--text-normal, #eee)" },
	".mica-mh1": { fontSize: "1.4em" },
	".mica-mh2": { fontSize: "1.25em" },
	".mica-mh3": { fontSize: "1.12em" },
	".mica-mstrong": { fontWeight: "700" },
	".mica-mem": { fontStyle: "italic" },
	".mica-mstrike": { textDecoration: "line-through", color: "var(--text-muted, #999)" },
	".mica-mcode": {
		fontFamily: "var(--font-monospace, monospace)",
		fontSize: "0.92em",
		color: "var(--code-normal, var(--text-normal, #eee))",
	},
	".mica-mquote": { color: "var(--text-muted, #999)" },
	".mica-mlink, .mica-murl": { color: "var(--link-color, var(--text-accent, #7c5cff))" },
	".mica-mmark": { color: "color-mix(in srgb, var(--mica-accent, #7c5cff) 75%, var(--text-faint, #777))" },
	".mica-ck": { color: "var(--code-keyword, #cf8e6d)" },
	".mica-cs": { color: "var(--code-string, #6aab73)" },
	".mica-cc": { color: "var(--code-comment, #7a7e85)", fontStyle: "italic" },
	".mica-cv": { color: "var(--code-value, #2aacb8)" },
	".mica-cf": { color: "var(--code-function, #56a8f5)" },
	".mica-ct": { color: "var(--code-important, #c77dbb)" },
	".mica-cp": { color: "var(--code-property, #c77dbb)" },
	".mica-cg": { color: "var(--code-tag, #e8bf6a)" },
	".mica-co": { color: "var(--code-operator, var(--text-muted, #999))" },
	".mica-cm": { color: "var(--code-comment, #7a7e85)" },
});

/**
 * The one markdown editor Mica uses everywhere (quick edit, lightbox, branch
 * edit): CodeMirror 6 with markdown syntax, history, and explicit-save keys.
 *
 * Mounted inside a SHADOW ROOT: no theme, snippet, or other plugin can reach
 * the editor's internals (the hostile-theme hanging-indent bug class is
 * impossible by construction), while CSS custom properties still inherit in,
 * so it always matches the vault's look. Never commits on blur — Save is a
 * button or Ctrl/Cmd+Enter, full stop.
 */
export class MdEditor {
	readonly view: EditorView;
	/** The light-DOM host (carries `.mica-mdeditor` for layout + tests). */
	readonly host: HTMLElement;

	constructor(parent: HTMLElement, opts: MdEditorOpts) {
		this.host = parent.createDiv({ cls: "mica-mdeditor" });
		const root = this.host.attachShadow({ mode: "open" });
		const mount = document.createElement("div");
		mount.style.display = "contents";
		root.appendChild(mount);

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
			parent: mount,
			state: EditorState.create({
				doc: opts.initial,
				extensions: [
					// Order matters: our save/cancel keys must beat the defaults.
					saveKeys,
					history(),
					keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
					markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage }),
					syntaxHighlighting(mdHighlight),
					micaEditorTheme,
					EditorView.lineWrapping,
					cmPlaceholder(opts.placeholder ?? "Write markdown…"),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) opts.onChange?.(u.state.doc.toString());
						if (u.selectionSet || u.docChanged) opts.onSelection?.();
					}),
				],
			}),
		});
		// The test/debug handle lives on the light-DOM host.
		(this.host as unknown as { micaEditor?: MdEditor }).micaEditor = this;
		if (opts.autofocus ?? true) {
			// Focus after the current event settles so nothing steals it back.
			queueMicrotask(() => {
				this.view.focus();
				this.host.scrollIntoView({ block: "nearest" });
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
		this.host.remove();
	}
}
