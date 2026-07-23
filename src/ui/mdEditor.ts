import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Compartment, StateEffect, type Range } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	highlightWhitespace,
	keymap,
	lineNumbers,
	placeholder as cmPlaceholder,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate,
} from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { resolveCodeLanguage } from "./codeLangs";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { Platform, Scope, type App } from "obsidian";

/** The user-chosen editor save key ("none" = buttons only). */
export type SaveShortcut = "mod-enter" | "mod-s" | "shift-enter" | "none";

let saveShortcut: SaveShortcut = "mod-enter";

/** Called from settings load/change — editors opened afterwards use it. */
export function setSaveShortcut(s: SaveShortcut): void {
	saveShortcut = s;
}

/** Human label for the current save key ("" when none) — placeholders and
 *  tooltips derive from this so the text always matches the binding. */
export function saveShortcutLabel(): string {
	const mod = Platform.isMacOS ? "Cmd" : "Ctrl";
	switch (saveShortcut) {
		case "mod-enter":
			return `${mod}+Enter`;
		case "mod-s":
			return `${mod}+S`;
		case "shift-enter":
			return "Shift+Enter";
		case "none":
			return "";
	}
}

/** The save binding in CodeMirror keymap syntax, or null when disabled. */
function saveKeyCm(): string | null {
	switch (saveShortcut) {
		case "mod-enter":
			return "Mod-Enter";
		case "mod-s":
			return "Mod-s";
		case "shift-enter":
			return "Shift-Enter";
		case "none":
			return null;
	}
}

/** The save binding as Obsidian Scope (modifiers, key), or null. */
function saveKeyScope(): [Array<"Mod" | "Shift">, string] | null {
	switch (saveShortcut) {
		case "mod-enter":
			return [["Mod"], "Enter"];
		case "mod-s":
			return [["Mod"], "s"];
		case "shift-enter":
			return [["Shift"], "Enter"];
		case "none":
			return null;
	}
}

/** Editor view options (line numbers, whitespace) — persisted by the host
 *  plugin and applied to every editor, live-toggleable per instance. */
export interface EditorViewPrefs {
	lineNumbers: boolean;
	whitespace: boolean;
	liveSyntax: boolean;
}

let viewPrefs: EditorViewPrefs = { lineNumbers: false, whitespace: false, liveSyntax: true };
let persistPrefs: ((prefs: EditorViewPrefs) => void) | null = null;
const openInstances = new Set<MdEditor>();

/** Push new prefs to all open editors and future ones. */
export function setEditorViewPrefs(prefs: EditorViewPrefs): void {
	viewPrefs = prefs;
	for (const ed of openInstances) ed.applyViewPrefs();
	if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("mica-editor-prefs-change"));
}

/** The host registers how toggled prefs persist (plugin settings). */
export function registerViewPrefsPersistence(cb: (prefs: EditorViewPrefs) => void): void {
	persistPrefs = cb;
}

/** Toggle + persist (the lightbox toolbar buttons). */
export function toggleViewPref(key: keyof EditorViewPrefs): EditorViewPrefs {
	const next = { ...viewPrefs, [key]: !viewPrefs[key] };
	setEditorViewPrefs(next);
	persistPrefs?.(next);
	return next;
}

export function editorViewPrefs(): EditorViewPrefs {
	return viewPrefs;
}

export interface MdEditorOpts {
	initial: string;
	placeholder?: string;
	/** Preferred source line ending when `initial` is empty. */
	lineSeparator?: "\n" | "\r\n";
	/** Syntax shown by this editor. Markdown is the default; structured code
	 * editors pass the fence info string so the body alone gets its language. */
	language?: EditorLanguage;
	/** Ctrl/Cmd+Enter — the ONLY keyboard commit. */
	onSave: () => void;
	/** Escape (the host decides whether to confirm when dirty). */
	onCancel: () => void;
	onChange?: (value: string) => void;
	/** Fires on selection movement too (cheap consumers only, e.g. stats). */
	onSelection?: () => void;
	autofocus?: boolean;
	/** When provided, save/cancel keys also register on a focus-scoped
	 * Obsidian keymap Scope: global hotkeys (Obsidian's or a community
	 * plugin's, e.g. one binding Ctrl+Enter) run at window capture and eat
	 * the REAL keystroke before the shadow editor's keymap ever sees it —
	 * a pushed Scope outranks them while the editor is focused. */
	app?: App;
}

/** The syntax projection for one shared editor instance. A code info string may
 * include attributes; only its first token selects highlighting. */
export type EditorLanguage = { kind: "markdown" } | { kind: "code"; info: string };

const MARKDOWN_LANGUAGE: EditorLanguage = { kind: "markdown" };

interface SearchHighlights {
	ranges: Uint32Array;
	current: number;
	preview?: SearchReplacementPreview;
}

export type SearchPreviewMode = "original" | "changes" | "result";

export interface SearchReplacementPreview {
	mode: Exclude<SearchPreviewMode, "original">;
	replacements: readonly string[];
}

const setSearchHighlightsEffect = StateEffect.define<SearchHighlights>();

/** Search results may be numerous; retain compact offsets but create CM
 * decorations only for visible ranges. Rebuilding is O(visible matches). */
class SearchHighlightPlugin {
	decorations: DecorationSet = Decoration.none;
	private ranges: Uint32Array<ArrayBufferLike> = new Uint32Array();
	private current = -1;
	private preview: SearchReplacementPreview | undefined;

	constructor(view: EditorView) {
		this.rebuild(view);
	}

	update(update: ViewUpdate): void {
		let changed = update.viewportChanged;
		if (update.docChanged) {
			this.ranges = new Uint32Array();
			this.current = -1;
			this.preview = undefined;
			changed = true;
		}
		for (const effect of update.transactions.flatMap((transaction) => transaction.effects)) {
			if (!effect.is(setSearchHighlightsEffect)) continue;
			this.ranges = effect.value.ranges;
			this.current = effect.value.current;
			this.preview = effect.value.preview;
			changed = true;
		}
		if (changed) this.rebuild(update.view);
	}

	private rebuild(view: EditorView): void {
		const marks: Range<Decoration>[] = [];
		for (const visible of view.visibleRanges) {
			let pair = lowerBoundPair(this.ranges, visible.from);
			if (pair > 0 && this.ranges[pair * 2 - 1] >= visible.from) pair--;
			for (; pair * 2 < this.ranges.length; pair++) {
				const from = this.ranges[pair * 2];
				const rawTo = this.ranges[pair * 2 + 1];
				if (from > visible.to) break;
				if (rawTo < visible.from) continue;
				const to = rawTo > from ? rawTo : Math.min(view.state.doc.length, from + 1);
				const replacement = this.preview?.replacements[pair] ?? "";
				if (this.preview?.mode === "result") {
					const widget = new SearchReplacementWidget(replacement, "mica-search-preview-result");
					marks.push(
						(rawTo > from ? Decoration.replace({ widget }) : Decoration.widget({ widget, side: 1 })).range(
							from,
							rawTo > from ? rawTo : from,
						),
					);
					continue;
				}
				if (this.preview?.mode === "changes") {
					if (rawTo > from)
						marks.push(Decoration.mark({ class: "mica-search-preview-old" }).range(from, rawTo));
					marks.push(
						Decoration.widget({
							widget: new SearchReplacementWidget(replacement, "mica-search-preview-new"),
							side: 1,
						}).range(rawTo),
					);
					continue;
				}
				if (to <= from) continue;
				marks.push(
					Decoration.mark({
						class: pair === this.current ? "mica-search-current" : "mica-search-match",
					}).range(from, to),
				);
			}
		}
		this.decorations = Decoration.set(marks, true);
	}
}

class SearchReplacementWidget extends WidgetType {
	constructor(
		private readonly replacement: string,
		private readonly className: string,
	) {
		super();
	}

	eq(other: SearchReplacementWidget): boolean {
		return this.replacement === other.replacement && this.className === other.className;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = this.className;
		span.textContent = this.replacement;
		span.setAttribute("aria-label", this.replacement ? `Replacement: ${this.replacement}` : "Empty replacement");
		return span;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

const searchHighlightExtension = ViewPlugin.fromClass(SearchHighlightPlugin, {
	decorations: (plugin) => plugin.decorations,
});

/** Obsidian's ==highlight== syntax is not CommonMark. Scan only visible
 * ranges, preserve every marker, and let the document parser handle all
 * standard Markdown incrementally. */
class MarkdownHighlightPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = this.build(view);
	}

	update(update: ViewUpdate): void {
		if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view);
	}

	private build(view: EditorView): DecorationSet {
		const decorations: Range<Decoration>[] = [];
		for (const visible of view.visibleRanges) {
			const text = view.state.sliceDoc(visible.from, visible.to);
			const pattern = /==(?=\S)(.*?\S)==/gu;
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(text)) !== null) {
				const from = visible.from + match.index;
				const to = from + match[0].length;
				decorations.push(Decoration.mark({ class: "mica-mhighlight" }).range(from, to));
			}
		}
		return Decoration.set(decorations, true);
	}
}

const markdownHighlightExtension = ViewPlugin.fromClass(MarkdownHighlightPlugin, {
	decorations: (plugin) => plugin.decorations,
});

function lowerBoundPair(ranges: Uint32Array, position: number): number {
	let low = 0;
	let high = ranges.length / 2;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (ranges[middle * 2] < position) low = middle + 1;
		else high = middle;
	}
	return low;
}

function markdownExtension(): Extension {
	return [markdown({ base: markdownLanguage, codeLanguages: resolveCodeLanguage }), markdownHighlightExtension];
}

function infoLanguage(info: string): string {
	return info.trimStart().match(/^[^\s]+/)?.[0] ?? "";
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
		height: "100%",
		backgroundColor: "transparent",
		fontSize: "var(--font-text-size, 16px)",
		color: "var(--text-normal)",
	},
	"&.cm-focused": { outline: "none" },
	".cm-scroller": {
		overflow: "auto",
		lineHeight: "1.55",
		fontFamily: "var(--font-text, sans-serif)",
	},
	"&[data-mica-editor-kind='code'] .cm-scroller": {
		fontFamily: "var(--font-monospace, monospace)",
	},
	".cm-content": {
		padding: "8px 10px",
		caretColor: "var(--mica-accent, var(--text-accent))",
		minHeight: "2.2em",
	},
	".cm-line": { padding: "1px 4px" },
	".cm-gutters": {
		background: "var(--mica-gutter-background, transparent)",
		color: "var(--mica-gutter-foreground, var(--text-faint))",
		borderRight: "1px solid var(--mica-gutter-divider, var(--background-modifier-border))",
		fontFamily: "var(--font-monospace, monospace)",
		fontSize: "var(--mica-gutter-font-size, 0.78em)",
		fontVariantNumeric: "tabular-nums",
	},
	".cm-lineNumbers .cm-gutterElement": {
		minWidth: "calc(2ch + var(--mica-gutter-padding, 8px))",
		padding: "0 var(--mica-gutter-padding, 8px) 0 4px",
	},
	".cm-activeLineGutter": {
		background: "var(--mica-gutter-active-background, color-mix(in srgb, var(--mica-accent) 8%, transparent))",
		color: "var(--mica-gutter-active-foreground, var(--text-muted))",
	},
	".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--mica-accent, var(--text-accent))" },
	"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection": {
		background: "color-mix(in srgb, var(--mica-accent) 25%, transparent)",
	},
	".cm-activeLine": { background: "color-mix(in srgb, var(--mica-accent) 7%, transparent)" },
	".mica-search-match": {
		background: "var(--mica-search-match, color-mix(in srgb, var(--text-accent) 20%, transparent))",
		borderRadius: "2px",
	},
	".mica-search-current": {
		background: "var(--mica-search-current, color-mix(in srgb, var(--text-accent) 38%, transparent))",
		boxShadow: "inset 0 -1px 0 var(--text-accent)",
		borderRadius: "2px",
	},
	".mica-search-preview-old": {
		background: "color-mix(in srgb, var(--mica-diff-del, var(--color-red)) 18%, transparent)",
		textDecoration: "line-through",
		textDecorationColor: "var(--mica-diff-del, var(--color-red))",
		textDecorationThickness: "1px",
	},
	".mica-search-preview-new, .mica-search-preview-result": {
		background: "color-mix(in srgb, var(--mica-diff-add, var(--color-green)) 18%, transparent)",
		textDecoration: "underline",
		textDecorationColor: "var(--mica-diff-add, var(--color-green))",
		textDecorationThickness: "1px",
		whiteSpace: "pre-wrap",
	},
	".cm-placeholder": { color: "var(--text-faint)", fontStyle: "italic" },
	"&[data-mica-live-syntax='on'] .mica-mh": {
		fontWeight: "var(--bold-weight, 700)",
		color: "var(--text-normal)",
	},
	"&[data-mica-live-syntax='on'] .mica-mstrong": { fontWeight: "var(--bold-weight, 700)" },
	"&[data-mica-live-syntax='on'] .mica-mem": { fontStyle: "italic" },
	"&[data-mica-live-syntax='on'] .mica-mstrike": {
		textDecoration: "line-through",
		color: "var(--text-muted)",
	},
	"&[data-mica-live-syntax='on'] .mica-mcode": {
		fontFamily: "var(--font-monospace, monospace)",
		fontSize: "0.92em",
		color: "var(--code-normal, var(--text-normal))",
	},
	"&[data-mica-live-syntax='on'] .mica-mquote": { color: "var(--text-muted)" },
	"&[data-mica-live-syntax='on'] .mica-mlink, &[data-mica-live-syntax='on'] .mica-murl": {
		color: "var(--link-color, var(--text-accent))",
	},
	"&[data-mica-live-syntax='on'] .mica-mmark": {
		color: "var(--text-faint)",
	},
	"&[data-mica-live-syntax='on'] .mica-mhighlight": {
		background: "var(--text-highlight-bg)",
		borderRadius: "2px",
	},
	"&[data-mica-markdown-syntax='off'] .mica-ck, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-ck":
		{
			color: "var(--code-keyword, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cs, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cs":
		{
			color: "var(--code-string, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cc, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cc":
		{
			color: "var(--code-comment, var(--text-muted))",
			fontStyle: "italic",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cv, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cv":
		{
			color: "var(--code-value, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cf, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cf":
		{
			color: "var(--code-function, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-ct, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-ct":
		{
			color: "var(--code-important, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cp, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cp":
		{
			color: "var(--code-property, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cg, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cg":
		{
			color: "var(--code-tag, var(--text-normal))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-co, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-co":
		{
			color: "var(--code-operator, var(--text-muted))",
		},
	"&[data-mica-markdown-syntax='off'] .mica-cm, &[data-mica-markdown-syntax='on'][data-mica-live-syntax='on'] .mica-cm":
		{
			color: "var(--code-comment, var(--text-muted))",
		},
});

/**
 * The one editor Mica uses everywhere (quick edit, lightbox, branch edit):
 * CodeMirror 6 with reconfigurable Markdown/code syntax, history, and
 * explicit-save keys.
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
	private readonly viewOpts = new Compartment();
	private readonly syntax = new Compartment();
	private popScope: (() => void) | null = null;
	private syntaxRequest = 0;
	private destroyed = false;

	constructor(parent: HTMLElement, opts: MdEditorOpts) {
		this.host = parent.createDiv({ cls: "mica-mdeditor" });
		const root = this.host.attachShadow({ mode: "open" });
		const mount = document.createElement("div");
		mount.style.display = "contents";
		root.appendChild(mount);
		// CodeMirror normalizes line endings internally unless a separator is
		// configured. Match the incoming text so editing a stored CRLF version
		// cannot silently rewrite it as LF on save.
		const lineSeparator = opts.lineSeparator ?? opts.initial.match(/\r\n|\n/)?.[0] ?? "\n";

		// Global hotkeys (Obsidian's own, or a community plugin's Ctrl+Enter)
		// run at window capture and consume REAL keystrokes before the shadow
		// editor's keymap sees them. A Scope pushed while we hold focus
		// outranks them; everything we don't bind falls through to the app.
		if (opts.app) {
			const app = opts.app;
			const scope = new Scope(app.scope);
			// The CM keymap below handles the key when the event reaches the
			// shadow editor first (target phase) — it preventDefaults, and the
			// scope stands down. The scope earns its keep when a global hotkey
			// would otherwise consume the key before CM ever sees it.
			const sk = saveKeyScope();
			if (sk) {
				scope.register(sk[0], sk[1], (evt) => {
					if (!evt.defaultPrevented) opts.onSave();
					return false;
				});
			}
			scope.register([], "Escape", (evt) => {
				if (!evt.defaultPrevented) opts.onCancel();
				return false;
			});
			let pushed = false;
			const push = (): void => {
				if (!pushed) {
					app.keymap.pushScope(scope);
					pushed = true;
				}
			};
			const pop = (): void => {
				if (pushed) {
					app.keymap.popScope(scope);
					pushed = false;
				}
			};
			// focusin/focusout are composed — they cross the shadow boundary.
			this.host.addEventListener("focusin", push);
			this.host.addEventListener("focusout", pop);
			this.popScope = pop;
		}

		const initialLanguage = opts.language ?? MARKDOWN_LANGUAGE;
		const cmKey = saveKeyCm();
		const saveKeys = keymap.of([
			...(cmKey
				? [
						{
							key: cmKey,
							run: (): boolean => {
								opts.onSave();
								return true;
							},
						},
					]
				: []),
			{
				key: "Escape",
				run: (): boolean => {
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
					EditorState.lineSeparator.of(lineSeparator),
					// Order matters: our save/cancel keys must beat the defaults.
					saveKeys,
					history(),
					keymap.of([...historyKeymap, ...defaultKeymap, indentWithTab]),
					this.syntax.of(initialLanguage.kind === "markdown" ? markdownExtension() : []),
					syntaxHighlighting(mdHighlight),
					micaEditorTheme,
					searchHighlightExtension,
					this.viewOpts.of(viewPrefsExtensions()),
					EditorView.lineWrapping,
					cmPlaceholder(opts.placeholder ?? "Write markdown…"),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) opts.onChange?.(u.state.sliceDoc());
						else if (u.selectionSet) opts.onSelection?.();
					}),
				],
			}),
		});
		this.view.dom.dataset.micaEditorKind = initialLanguage.kind;
		this.paintSyntaxKind(initialLanguage);
		this.view.dom.dataset.micaLiveSyntax = viewPrefs.liveSyntax ? "on" : "off";
		if (initialLanguage.kind === "code") this.setLanguage(initialLanguage);
		// Clicking the empty space BELOW the last line should behave like
		// clicking the end of the document. Listen on the LIGHT-DOM host:
		// clicks below the shadow's content never reach a shadow-internal
		// listener, and composedPath() still lets us skip real content hits.
		this.host.addEventListener("mousedown", (e) => {
			const path = e.composedPath() as HTMLElement[];
			if (
				path.some(
					(n) =>
						n instanceof HTMLElement &&
						(n.classList?.contains("cm-content") ||
							n.classList?.contains("cm-gutters") ||
							n.classList?.contains("cm-panel") ||
							n.classList?.contains("cm-tooltip")),
				)
			)
				return;
			// Only the scroller's own empty area represents space below the last
			// line. Scrollbars and unrelated shadow chrome keep their native action.
			const target = path.find((node) => node instanceof HTMLElement) as HTMLElement | undefined;
			if (target !== this.host && !target?.classList.contains("cm-scroller")) return;
			if (target?.classList.contains("cm-scroller")) {
				const rect = target.getBoundingClientRect();
				if (e.clientX >= rect.left + target.clientWidth || e.clientY >= rect.top + target.clientHeight) return;
			}
			e.preventDefault();
			this.view.dispatch({ selection: { anchor: this.view.state.doc.length } });
			this.view.focus();
		});
		openInstances.add(this);
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
		return this.view.state.sliceDoc();
	}

	setValue(value: string): void {
		this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } });
	}

	setSearchHighlights(ranges: Uint32Array, current: number, preview?: SearchReplacementPreview): void {
		this.view.dispatch({ effects: setSearchHighlightsEffect.of({ ranges, current, preview }) });
	}

	revealRange(from: number, to: number): void {
		const end = Math.max(from, to);
		this.view.dispatch({
			selection: { anchor: from, head: end },
			effects: EditorView.scrollIntoView(from, { y: "center" }),
		});
		this.view.focus();
	}

	focus(): void {
		this.view.focus();
	}

	/** Reconfigure syntax without replacing the editor or its undo history.
	 * LanguageDescription loading is async, so a monotonic request id prevents a
	 * slow earlier choice from overwriting the user's latest info string. */
	setLanguage(language: EditorLanguage): void {
		if (this.destroyed) return;
		const request = ++this.syntaxRequest;
		this.view.dom.dataset.micaEditorKind = language.kind;
		this.paintSyntaxKind(language);
		if (language.kind === "markdown") {
			this.view.dispatch({ effects: this.syntax.reconfigure(markdownExtension()) });
			return;
		}

		// Clear the previous parser immediately. Empty and unknown identifiers are
		// deliberately plain text; rendered preview remains Obsidian-native.
		this.view.dispatch({ effects: this.syntax.reconfigure([]) });
		const name = infoLanguage(language.info);
		const description = name ? resolveCodeLanguage(name) : null;
		if (!description) return;
		void description
			.load()
			.then((support) => {
				if (this.destroyed || request !== this.syntaxRequest) return;
				this.view.dispatch({
					effects: this.syntax.reconfigure(
						["md", "markdown"].includes(name.toLocaleLowerCase())
							? [support, markdownHighlightExtension]
							: support,
					),
				});
			})
			.catch(() => {
				// Optional highlighting must never make an otherwise valid code fence
				// uneditable. The plain-text projection installed above is the fallback.
			});
	}

	private paintSyntaxKind(language: EditorLanguage): void {
		const markdownSyntax =
			language.kind === "markdown" ||
			["md", "markdown"].includes(infoLanguage(language.info).toLocaleLowerCase());
		this.view.dom.dataset.micaMarkdownSyntax = markdownSyntax ? "on" : "off";
	}

	/** Re-apply the shared view prefs (line numbers / whitespace) live. */
	applyViewPrefs(): void {
		this.view.dom.dataset.micaLiveSyntax = viewPrefs.liveSyntax ? "on" : "off";
		this.view.dispatch({ effects: this.viewOpts.reconfigure(viewPrefsExtensions()) });
	}

	destroy(): void {
		this.destroyed = true;
		this.syntaxRequest++;
		this.popScope?.();
		openInstances.delete(this);
		this.view.destroy();
		this.host.remove();
	}
}

function viewPrefsExtensions(): Extension[] {
	const exts: Extension[] = [];
	if (viewPrefs.lineNumbers) exts.push(lineNumbers());
	if (viewPrefs.whitespace) exts.push(highlightWhitespace());
	return exts;
}
