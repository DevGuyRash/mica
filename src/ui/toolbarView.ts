import { setIcon, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { calloutCatalog, type CalloutFold } from "./calloutCatalog";
import { groupDefault, rememberDefault, resolveTool, toolbarConfig, type ToolItem } from "./toolSpec";
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

/**
 * Build the markdown toolbar into `host` from the user's configured layout.
 * One implementation serves the quick editor (compact) and the lightbox
 * (full). Variant groups run their current default on click and reveal all
 * variants on hover (or via the caret); the picked variant becomes the new
 * default. Buttons act on the CM6 view from `getView`, so the toolbar never
 * holds a stale editor reference.
 */
export function buildToolbar(host: HTMLElement, app: App, getView: () => EditorView, compact: boolean): void {
	const bar = host.createDiv({ cls: `mica-toolbar ${compact ? "is-compact" : ""}` });
	const layout = toolbarConfig().layout;

	// Every top-level element in layout order — the responsive unit.
	const pieces: HTMLElement[] = [];
	const track = <T extends HTMLElement>(el: T): T => {
		pieces.push(el);
		return el;
	};
	for (const id of layout) {
		if (id === "|") {
			track(bar.createSpan({ cls: "mica-tool-sep" }));
			continue;
		}
		const item = resolveTool(id);
		if (!item) continue; // a removed custom tool leaves no corpse
		const before = bar.lastElementChild;
		renderItem(bar, app, getView, item);
		// renderItem appends exactly one root element per item.
		const added = bar.lastElementChild;
		if (added && added !== before) track(added as HTMLElement);
	}

	// Overflow: whatever doesn't fit folds into a "More tools" popover, so the
	// ribbon works at every width (narrow cells, split panes, mobile).
	const more = bar.createEl("button", {
		cls: "clickable-icon mica-tool mica-toolbar-more",
		attr: { type: "button", "aria-label": "More tools…" },
	});
	setIcon(more, "ellipsis");
	more.style.display = "none";
	const hidden: HTMLElement[] = [];
	more.addEventListener("mousedown", (e) => e.preventDefault());
	more.addEventListener("click", () => {
		openPopover(bar, (panel) => {
			panel.addClass("mica-overflow-panel");
			// Relocate the real elements (their handlers travel with them); they
			// return to the bar on the next relayout.
			for (const el of hidden) panel.appendChild(el);
		});
	});

	let relayoutQueued = false;
	const relayout = (): void => {
		if (relayoutQueued) return;
		relayoutQueued = true;
		window.requestAnimationFrame(() => {
			relayoutQueued = false;
			// Restore everything, measure, then trim from the tail.
			bar.querySelector(".mica-popover")?.remove();
			for (const el of pieces) {
				el.style.display = "";
				bar.insertBefore(el, more);
			}
			hidden.length = 0;
			const avail = bar.clientWidth;
			if (avail === 0) return; // not laid out yet
			let used = 34; // reserve room for the "more" button
			let overflowing = false;
			for (const el of pieces) {
				if (!overflowing) {
					used += el.offsetWidth + 5;
					if (used > avail) overflowing = true;
				}
				if (overflowing) {
					el.style.display = "none";
					if (!el.hasClass("mica-tool-sep")) hidden.push(el);
				}
			}
			more.style.display = hidden.length ? "" : "none";
		});
	};
	const ro = new ResizeObserver(relayout);
	ro.observe(bar);
	relayout();
}

function toolButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
	const b = parent.createEl("button", {
		cls: "clickable-icon mica-tool",
		attr: { type: "button", "aria-label": label, tabindex: "-1" },
	});
	setIcon(b, icon);
	// mousedown+preventDefault keeps focus in the editor while clicking tools.
	b.addEventListener("mousedown", (e) => e.preventDefault());
	return b;
}

function renderItem(bar: HTMLElement, app: App, getView: () => EditorView, item: ToolItem): void {
	// Popover specials -----------------------------------------------------
	if (item.special === "callout") {
		toolButton(bar, item.icon, item.label).addEventListener("click", () => {
			openPopover(bar, (panel, close) => buildCalloutPicker(panel, app, getView, close));
		});
		return;
	}
	if (item.special === "codeblock") {
		toolButton(bar, item.icon, item.label).addEventListener("click", () => {
			openPopover(bar, (panel, close) => buildLangPicker(panel, getView, close));
		});
		return;
	}
	if (item.special === "table") {
		toolButton(bar, item.icon, item.label).addEventListener("click", () => {
			openPopover(bar, (panel, close) => buildTablePicker(panel, getView, close));
		});
		return;
	}

	// Simple tools ----------------------------------------------------------
	if (!item.variants?.length) {
		toolButton(bar, item.icon, item.label).addEventListener("click", () => item.run?.(getView()));
		return;
	}

	// Variant groups: primary (current default) + caret; hover reveals variants.
	const group = bar.createDiv({ cls: "mica-tool-group" });
	const current = groupDefault(item);
	const primary = toolButton(
		group,
		current?.icon ?? item.icon,
		`${current?.label ?? item.label} (click) — hover for more`,
	);
	primary.addEventListener("click", () => {
		const v = groupDefault(item);
		v?.run(getView());
	});
	const caret = group.createEl("button", {
		cls: "clickable-icon mica-tool-caret",
		attr: { type: "button", "aria-label": `${item.label} options`, tabindex: "-1" },
	});
	setIcon(caret, "chevron-down");
	caret.addEventListener("mousedown", (e) => e.preventDefault());

	let hoverTimer: number | null = null;
	const openVariants = (): void => {
		openPopover(bar, (panel, close) => {
			panel.addClass("mica-variant-menu");
			for (const v of item.variants ?? []) {
				const row = panel.createEl("button", {
					cls: "clickable-icon mica-pop-item mica-variant",
					attr: { type: "button" },
				});
				setIcon(row.createSpan({ cls: "mica-variant-ico" }), v.icon);
				row.createSpan({ text: v.label });
				if (groupDefault(item)?.id === v.id) setIcon(row.createSpan({ cls: "mica-variant-check" }), "check");
				row.addEventListener("mousedown", (e) => e.preventDefault());
				row.addEventListener("click", () => {
					v.run(getView());
					rememberDefault(item.id, v.id);
					// The primary button now reflects the new default.
					primary.empty();
					setIcon(primary, v.icon);
					primary.setAttribute("aria-label", `${v.label} (click) — hover for more`);
					close();
				});
			}
		});
		positionPopoverUnder(bar, group);
	};
	caret.addEventListener("click", openVariants);
	group.addEventListener("pointerenter", () => {
		hoverTimer = window.setTimeout(openVariants, 350);
	});
	group.addEventListener("pointerleave", () => {
		if (hoverTimer !== null) window.clearTimeout(hoverTimer);
		hoverTimer = null;
	});
}

// ---------------------------------------------------------------------------
// Popover plumbing
// ---------------------------------------------------------------------------

/** A dismissable popover anchored inside the toolbar. */
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

/** Nudge the open popover to sit under `anchor` (variant groups). */
function positionPopoverUnder(bar: HTMLElement, anchor: HTMLElement): void {
	const panel = bar.querySelector<HTMLElement>(".mica-popover");
	if (!panel) return;
	const left = anchor.getBoundingClientRect().left - bar.getBoundingClientRect().left;
	panel.style.left = `${Math.max(0, left)}px`;
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

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
			cls: `clickable-icon mica-pop-seg ${value === fold ? "is-on" : ""}`,
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
				cls: "clickable-icon mica-callout-type",
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
			const b = list.createEl("button", {
				cls: "clickable-icon mica-pop-item",
				text: lang,
				attr: { type: "button" },
			});
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

/** The table picker: hover a grid to size it, or type custom dimensions. */
function buildTablePicker(panel: HTMLElement, getView: () => EditorView, close: () => void): void {
	panel.addClass("mica-table-picker");
	const label = panel.createDiv({ cls: "mica-table-label", text: "Insert table" });
	const MAX = 8;
	const grid = panel.createDiv({ cls: "mica-table-grid" });
	grid.style.setProperty("--mica-tp-cols", String(MAX));
	const cells: HTMLElement[] = [];
	const highlight = (r: number, c: number): void => {
		cells.forEach((cell, i) => {
			const cr = Math.floor(i / MAX) + 1;
			const cc = (i % MAX) + 1;
			cell.toggleClass("is-on", cr <= r && cc <= c);
		});
		label.setText(r > 0 ? `Insert ${r} × ${c} table` : "Insert table");
	};
	for (let r = 1; r <= MAX; r++) {
		for (let c = 1; c <= MAX; c++) {
			const cell = grid.createEl("button", {
				cls: "clickable-icon mica-table-cell",
				attr: { type: "button", "aria-label": `${r} rows × ${c} columns` },
			});
			cell.addEventListener("pointerenter", () => highlight(r, c));
			cell.addEventListener("mousedown", (e) => e.preventDefault());
			cell.addEventListener("click", () => {
				verbs.insertTable(getView(), r, c);
				close();
			});
			cells.push(cell);
		}
	}
	grid.addEventListener("pointerleave", () => highlight(0, 0));

	// Custom dimensions for anything past the hover grid.
	const custom = panel.createDiv({ cls: "mica-pop-row mica-table-custom" });
	const rows = custom.createEl("input", { attr: { type: "number", min: "1", max: "50", placeholder: "rows" } });
	custom.createSpan({ text: "×" });
	const cols = custom.createEl("input", { attr: { type: "number", min: "1", max: "20", placeholder: "cols" } });
	const go = custom.createEl("button", { cls: "mod-cta", text: "Insert", attr: { type: "button" } });
	const insertCustom = (): void => {
		verbs.insertTable(getView(), Number(rows.value) || 2, Number(cols.value) || 2);
		close();
	};
	go.addEventListener("click", insertCustom);
	for (const inp of [rows, cols]) {
		inp.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				insertCustom();
			}
		});
	}
}
