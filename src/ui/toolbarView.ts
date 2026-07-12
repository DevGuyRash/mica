import { setIcon, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { calloutCatalog, type CalloutFold } from "./calloutCatalog";
import * as verbs from "./toolbar";

/** Common fence languages offered first in the codeblock picker. */
const COMMON_LANGS = [
	"js",
	"ts",
	"python",
	"rust",
	"bash",
	"json",
	"yaml",
	"html",
	"css",
	"sql",
	"markdown",
	"c",
	"cpp",
	"go",
	"java",
	"diff",
	"text",
];

interface Item {
	icon: string;
	label: string;
	run: (view: EditorView) => void;
	/** Only shown in the full (lightbox) toolbar when true. */
	fullOnly?: boolean;
}

/**
 * Build the markdown toolbar into `host`. One implementation serves both the
 * quick editor (compact) and the lightbox (full). Buttons act on the CM6 view
 * returned by `getView`, so the toolbar never holds a stale editor reference.
 */
export function buildToolbar(host: HTMLElement, app: App, getView: () => EditorView, compact: boolean): void {
	const bar = host.createDiv({ cls: `mica-toolbar ${compact ? "is-compact" : ""}` });

	const btn = (parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement => {
		const b = parent.createEl("button", {
			cls: "mica-tool",
			attr: { type: "button", "aria-label": label, tabindex: "-1" },
		});
		setIcon(b, icon);
		// mousedown+preventDefault keeps focus in the editor while clicking tools.
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", onClick);
		return b;
	};

	const sep = (): void => {
		bar.createSpan({ cls: "mica-tool-sep" });
	};

	const inline: Item[] = [
		{ icon: "bold", label: "Bold (**)", run: (v) => verbs.toggleInline(v, "**") },
		{ icon: "italic", label: "Italic (*)", run: (v) => verbs.toggleInline(v, "*") },
		{ icon: "strikethrough", label: "Strikethrough (~~)", run: (v) => verbs.toggleInline(v, "~~"), fullOnly: true },
		{ icon: "highlighter", label: "Highlight (==)", run: (v) => verbs.toggleInline(v, "=="), fullOnly: true },
		{ icon: "code", label: "Inline code (`)", run: (v) => verbs.toggleInline(v, "`") },
	];
	for (const it of inline) {
		if (it.fullOnly && compact) continue;
		btn(bar, it.icon, it.label, () => it.run(getView()));
	}
	sep();

	// Headings: three buttons in full, one popover in compact.
	if (compact) {
		btn(bar, "heading", "Heading…", (): void => {
			openPopover(bar, (panel, close) => {
				for (const level of [1, 2, 3, 4, 5, 6]) {
					const b = panel.createEl("button", { cls: "mica-pop-item", text: `H${level}`, attr: { type: "button" } });
					b.addEventListener("click", () => {
						verbs.setHeading(getView(), level);
						close();
					});
				}
			});
		});
	} else {
		for (const level of [1, 2, 3]) {
			btn(bar, `heading-${level}`, `Heading ${level}`, () => verbs.setHeading(getView(), level));
		}
	}
	sep();

	const lists: Item[] = [
		{ icon: "list", label: "Bullet list", run: (v) => verbs.toggleList(v, "bullet") },
		{ icon: "list-ordered", label: "Numbered list", run: (v) => verbs.toggleList(v, "ordered"), fullOnly: true },
		{ icon: "list-checks", label: "Task list", run: (v) => verbs.toggleList(v, "task") },
		{ icon: "text-quote", label: "Blockquote (nests)", run: (v) => verbs.toggleQuote(v) },
	];
	for (const it of lists) {
		if (it.fullOnly && compact) continue;
		btn(bar, it.icon, it.label, () => it.run(getView()));
	}
	sep();

	// Callout picker: every Obsidian type + Admonition custom types, searchable.
	btn(bar, "megaphone", "Callout…", () => {
		openPopover(bar, (panel, close) => buildCalloutPicker(panel, app, getView, close));
	});

	// Codeblock with language picker.
	btn(bar, "square-code", "Code block…", () => {
		openPopover(bar, (panel, close) => buildLangPicker(panel, getView, close));
	});

	const rest: Item[] = [
		{ icon: "link", label: "Link", run: (v) => verbs.insertLink(v) },
		{ icon: "brackets", label: "Wikilink", run: (v) => verbs.insertWikilink(v), fullOnly: true },
		{ icon: "table", label: "Table", run: (v) => verbs.insertTable(v), fullOnly: true },
		{ icon: "minus", label: "Horizontal rule", run: (v) => verbs.insertHr(v), fullOnly: true },
	];
	for (const it of rest) {
		if (it.fullOnly && compact) continue;
		btn(bar, it.icon, it.label, () => it.run(getView()));
	}
}

/** A dismissable popover anchored under the toolbar. */
function openPopover(bar: HTMLElement, build: (panel: HTMLElement, close: () => void) => void): void {
	bar.querySelector(".mica-popover")?.remove();
	const panel = bar.createDiv({ cls: "mica-popover" });
	const close = (): void => {
		panel.remove();
		document.removeEventListener("pointerdown", onOutside, true);
	};
	const onOutside = (e: PointerEvent): void => {
		if (!panel.contains(e.target as Node)) close();
	};
	document.addEventListener("pointerdown", onOutside, true);
	panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			close();
		}
	});
	build(panel, close);
}

/** The callout picker: search, fold mode, optional title, full type catalog. */
function buildCalloutPicker(panel: HTMLElement, app: App, getView: () => EditorView, close: () => void): void {
	panel.addClass("mica-callout-picker");
	const search = panel.createEl("input", {
		cls: "mica-pop-search",
		attr: { type: "text", placeholder: "Filter types…" },
	});

	let fold: CalloutFold = "";
	const foldRow = panel.createDiv({ cls: "mica-pop-row" });
	const foldBtns: HTMLButtonElement[] = [];
	const foldOpt = (label: string, value: CalloutFold, tip: string): void => {
		const b = foldRow.createEl("button", {
			cls: `mica-pop-seg ${value === fold ? "is-on" : ""}`,
			text: label,
			attr: { type: "button", "aria-label": tip },
		});
		b.addEventListener("click", () => {
			fold = value;
			foldBtns.forEach((x) => x.removeClass("is-on"));
			b.addClass("is-on");
		});
		foldBtns.push(b);
	};
	foldOpt("Static", "", "Always expanded");
	foldOpt("Fold +", "+", "Foldable, starts open");
	foldOpt("Fold −", "-", "Foldable, starts collapsed");

	const title = panel.createEl("input", {
		cls: "mica-pop-search",
		attr: { type: "text", placeholder: "Title (optional)" },
	});

	const grid = panel.createDiv({ cls: "mica-callout-grid" });
	const types = calloutCatalog(app);
	const paint = (filter: string): void => {
		grid.empty();
		const f = filter.trim().toLowerCase();
		for (const t of types) {
			if (f && !t.id.includes(f) && !t.aliases.some((a) => a.includes(f))) continue;
			const b = grid.createEl("button", {
				cls: "mica-callout-type",
				attr: {
					type: "button",
					"aria-label": t.aliases.length ? `${t.id} (also: ${t.aliases.join(", ")})` : t.id,
				},
			});
			b.style.setProperty("--mica-co-color", t.color);
			setIcon(b.createSpan({ cls: "mica-callout-ico" }), t.icon);
			b.createSpan({ cls: "mica-callout-name", text: t.id });
			if (t.source === "admonition") b.createSpan({ cls: "mica-callout-src", text: "adm" });
			b.addEventListener("click", () => {
				verbs.insertCallout(getView(), t.id, fold, title.value.trim());
				close();
			});
		}
		if (!grid.childElementCount) grid.createDiv({ cls: "mica-pop-empty", text: "No matching types" });
	};
	search.addEventListener("input", () => paint(search.value));
	paint("");
	queueMicrotask(() => search.focus());
}

/** The code fence language picker: search-or-type, Enter inserts. */
function buildLangPicker(panel: HTMLElement, getView: () => EditorView, close: () => void): void {
	panel.addClass("mica-lang-picker");
	const input = panel.createEl("input", {
		cls: "mica-pop-search",
		attr: { type: "text", placeholder: "Language (Enter to insert)…" },
	});
	const list = panel.createDiv({ cls: "mica-lang-list" });
	const paint = (filter: string): void => {
		list.empty();
		for (const lang of COMMON_LANGS.filter((l) => l.includes(filter.trim().toLowerCase()))) {
			const b = list.createEl("button", { cls: "mica-pop-item", text: lang, attr: { type: "button" } });
			b.addEventListener("click", () => {
				verbs.insertCodeblock(getView(), lang);
				close();
			});
		}
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			verbs.insertCodeblock(getView(), input.value.trim());
			close();
		}
	});
	input.addEventListener("input", () => paint(input.value));
	paint("");
	queueMicrotask(() => input.focus());
}
