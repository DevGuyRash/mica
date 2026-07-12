import type { EditorView } from "@codemirror/view";
import * as verbs from "./toolbar";

/**
 * The toolbar's vocabulary: every button the ribbon can hold, including
 * variant groups (hover a group → its variants; click → the group's current
 * default) and user-defined template buttons (espanso-style placeholders).
 */

/** One selectable action inside a group. */
export interface ToolVariant {
	id: string;
	icon: string;
	label: string;
	run: (view: EditorView) => void;
}

/** One ribbon item: a simple action, a variant group, or a special popover. */
export interface ToolItem {
	id: string;
	icon: string;
	label: string;
	/** Simple tools: the action. */
	run?: (view: EditorView) => void;
	/** Groups: the variants shown on hover; click runs the current default. */
	variants?: ToolVariant[];
	/** Popover tools handled by the view layer. */
	special?: "callout" | "codeblock" | "table";
}

/** A user-defined template button (see [`expandTemplate`]). */
export interface CustomTool {
	id: string;
	name: string;
	icon: string;
	template: string;
}

/** Toolbar configuration, owned by settings and injected at plugin load. */
export interface ToolbarConfig {
	/** Ordered item ids; `"|"` is a separator. */
	layout: string[];
	/** Group id → the variant id its primary button runs (follows last use). */
	defaults: Record<string, string>;
	customs: CustomTool[];
	/** Persist a changed group default (fire-and-forget). */
	onDefaultChange: (groupId: string, variantId: string) => void;
}

/** The factory-default ribbon layout. */
export const DEFAULT_TOOLBAR_LAYOUT = [
	"bold",
	"italic",
	"strikethrough",
	"highlight",
	"code",
	"|",
	"heading",
	"|",
	"list",
	"quote",
	"|",
	"callout",
	"codeblock",
	"|",
	"link",
	"table",
	"hr",
];

let config: ToolbarConfig = {
	layout: DEFAULT_TOOLBAR_LAYOUT,
	defaults: {},
	customs: [],
	onDefaultChange: () => undefined,
};

/** Install the live toolbar configuration (main.ts, on load + settings change). */
export function setToolbarConfig(cfg: ToolbarConfig): void {
	config = cfg;
}

/** The live toolbar configuration. */
export function toolbarConfig(): ToolbarConfig {
	return config;
}

/** All built-in ribbon items, in a stable catalog order. */
export function builtinTools(): ToolItem[] {
	return [
		{ id: "bold", icon: "bold", label: "Bold", run: (v) => verbs.toggleInline(v, "**") },
		{ id: "italic", icon: "italic", label: "Italic", run: (v) => verbs.toggleInline(v, "*") },
		{ id: "strikethrough", icon: "strikethrough", label: "Strikethrough", run: (v) => verbs.toggleInline(v, "~~") },
		{ id: "highlight", icon: "highlighter", label: "Highlight", run: (v) => verbs.toggleInline(v, "==") },
		{ id: "code", icon: "code", label: "Inline code", run: (v) => verbs.toggleInline(v, "`") },
		{
			id: "heading",
			icon: "heading",
			label: "Heading",
			variants: [1, 2, 3, 4, 5, 6].map((n) => ({
				id: `h${n}`,
				icon: n <= 6 ? `heading-${n}` : "heading",
				label: `Heading ${n}`,
				run: (v) => verbs.setHeading(v, n),
			})),
		},
		{
			id: "list",
			icon: "list",
			label: "List",
			variants: [
				{ id: "bullet", icon: "list", label: "Bullet list", run: (v) => verbs.toggleList(v, "bullet") },
				{
					id: "ordered",
					icon: "list-ordered",
					label: "Numbered list",
					run: (v) => verbs.toggleList(v, "ordered"),
				},
				{ id: "task", icon: "list-checks", label: "Task list", run: (v) => verbs.toggleList(v, "task") },
			],
		},
		{ id: "quote", icon: "text-quote", label: "Blockquote (nests)", run: (v) => verbs.toggleQuote(v) },
		{ id: "callout", icon: "megaphone", label: "Callout…", special: "callout" },
		{ id: "codeblock", icon: "square-code", label: "Code block…", special: "codeblock" },
		{
			id: "link",
			icon: "link",
			label: "Link",
			variants: [
				{ id: "md", icon: "link", label: "Markdown link", run: (v) => verbs.insertLink(v) },
				{ id: "wiki", icon: "brackets", label: "Wikilink", run: (v) => verbs.insertWikilink(v) },
				{ id: "embed", icon: "image-plus", label: "Embed (![[…]])", run: (v) => verbs.insertEmbed(v) },
			],
		},
		{ id: "table", icon: "table", label: "Table…", special: "table" },
		{ id: "hr", icon: "minus", label: "Horizontal rule", run: (v) => verbs.insertHr(v) },
	];
}

/** Resolve an id (builtin or `custom:*`) into a ribbon item. */
export function resolveTool(id: string): ToolItem | null {
	const builtin = builtinTools().find((t) => t.id === id);
	if (builtin) return builtin;
	const custom = config.customs.find((c) => `custom:${c.id}` === id);
	if (custom) {
		return {
			id,
			icon: custom.icon || "sparkles",
			label: custom.name,
			run: (view) => verbs.insertTemplate(view, custom.template),
		};
	}
	return null;
}

/** The group's current default variant (falls back to the first). */
export function groupDefault(item: ToolItem): ToolVariant | null {
	if (!item.variants?.length) return null;
	const wanted = config.defaults[item.id];
	return item.variants.find((v) => v.id === wanted) ?? item.variants[0];
}

/** Record (and persist) a group's new default after a variant is used. */
export function rememberDefault(groupId: string, variantId: string): void {
	config.defaults[groupId] = variantId;
	config.onDefaultChange(groupId, variantId);
}
