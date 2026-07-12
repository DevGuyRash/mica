import { App, Component, Menu, MarkdownRenderer, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { contentSignature, serializeCst, type Cst, type MicaNode } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import type { Reveal, StructOp } from "../cst/ops";
import { makeDraggable } from "./dnd";
import { draftKey, openLightboxFor, openQuickEdit, type RegionTarget } from "./quickEdit";
import { EditorLightbox } from "./lightbox";
import { VersionsModal } from "./versionsModal";

/** The hooks a rendered block uses to mutate itself (Live Preview only). */
export interface EditHooks {
	apply: (op: StructOp) => void;
	/** Replace the whole block content (undo toasts, whole-block edits). */
	replaceAll: (content: string) => void;
	/** Write / remove a fence-header attribute (name, accent, density, …). */
	setAttr: (key: string, value: string | null) => void;
}

/** Everything the footer needs to show version state and open history. */
export interface ChipInfo {
	plugin: MicaPlugin;
	file: TFile;
	blockId: string;
	content: string;
}

/**
 * UI state that survives the widget being rebuilt after every edit: active tab
 * per group, a one-shot focus target, the in-progress editor draft, and the
 * collapsed flag. Keyed by block id on the plugin, so it also survives
 * reading ⇄ editing mode flips.
 */
export interface BlockUi {
	active: Map<string, number>;
	reveal: Reveal | null;
	draft: { key: string; text: string } | null;
	collapsed: boolean;
}

export interface RenderCtx {
	app: App;
	sourcePath: string;
	component: Component;
	editable?: EditHooks;
	chip?: ChipInfo;
	/** Live Preview only: grow the inline editor with content (default true). */
	editorAutosize?: boolean;
	ui?: BlockUi;
	/** Fence-header attrs (name, accent, density, tabstyle, radius, …). */
	blockAttrs?: Record<string, string>;
	/** Header visibility: hover (default) / always / never. */
	headerMode?: "hover" | "always" | "never";
	/** The block's current content — captured before destructive ops for Undo. */
	preImage?: () => string;
	/** Internal: repaint one region back to view mode after a cancel. */
	repaintRegion?: (region: HTMLElement, target: RegionTarget) => void;
}

type Container = Extract<MicaNode, { kind: "container" }>;
type Leaf = Extract<MicaNode, { kind: "leaf" }>;

/**
 * A square icon button (Lucide via setIcon) with an accessible label.
 * Carries Obsidian's `clickable-icon` class so themes apply their icon-button
 * treatment (and skip their heavy text-button skin) — never fight the theme.
 */
function iconButton(parent: HTMLElement, cls: string, icon: string, label: string): HTMLButtonElement {
	const b = parent.createEl("button", {
		cls: `clickable-icon ${cls}`,
		attr: { type: "button", "aria-label": label },
	});
	setIcon(b, icon);
	return b;
}

const pathKey = (path: number[]): string => path.join(",");
const samePath = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const prefixOf = (parent: number[], child: number[]): boolean =>
	child.length === parent.length + 1 && parent.every((x, i) => x === child[i]);

/** `"A {icon=rocket}"` → `["A", "icon=rocket"]`. */
export function splitTitleAttrs(title: string): [string, string] {
	const t = title.trimEnd();
	if (t.endsWith("}")) {
		const open = t.lastIndexOf("{");
		if (open >= 0) return [t.slice(0, open).trim(), t.slice(open + 1, -1).trim()];
	}
	return [t.trim(), ""];
}

function titleAttr(title: string, key: string): string | null {
	const [, attrs] = splitTitleAttrs(title);
	for (const tok of attrs.split(/\s+/)) {
		const eq = tok.indexOf("=");
		if (eq > 0 && tok.slice(0, eq) === key) return tok.slice(eq + 1);
	}
	return null;
}

/** Consume a one-shot region-edit reveal if it targets `path`. */
function takeRegionReveal(ctx: RenderCtx, path: number[]): boolean {
	const r = ctx.ui?.reveal;
	if (r && r.kind === "region-edit" && samePath(r.path, path)) {
		ctx.ui!.reveal = null;
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Render a parsed block into `el`. Shared by reading view and Live Preview. */
export function renderCst(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.addClass("mica");
	el.setAttribute("data-mica-mode", ctx.editable ? "edit" : "read");
	applyBlockAttrs(el, ctx.blockAttrs ?? {});

	// A repaint closure so collapse and cancels can redraw without a doc change.
	ctx.repaintRegion = (region, target) => paintRegionView(region, ctx, target);

	// Keep widget-internal pointer events away from CodeMirror: a click inside
	// the block must never move the note's caret (that is what caused the
	// "everything flips to raw source" surprise). BUBBLE phase, so the block's
	// own controls (drag grips, chips, editors) still receive their events —
	// stopping here only prevents the event from reaching CodeMirror above.
	// Attached once — collapse/appearance repaints reuse the same root element.
	if (ctx.editable && !el.hasAttribute("data-mica-guarded")) {
		el.setAttribute("data-mica-guarded", "1");
		for (const type of ["pointerdown", "mousedown", "click"] as const) {
			el.addEventListener(type, (e) => {
				if (!(e.target as HTMLElement).closest("a, .internal-link")) e.stopPropagation();
			});
		}
	}

	renderHeader(cst, el, ctx);
	if (ctx.ui?.collapsed) {
		el.addClass("is-collapsed");
		if (ctx.chip) renderFooter(el, ctx, ctx.chip);
		return;
	}

	const body = el.createDiv({ cls: "mica-block-body" });
	markGroupContainer(body, [], cst.children.length);
	const rootInsert = !cst.children.some((c) => c.kind === "container");
	const autoOpen = takeRegionReveal(ctx, []);
	renderNodes(cst.children, body, ctx, [], { insert: rootInsert, autoOpen });
	if (ctx.chip) renderFooter(el, ctx, ctx.chip);
}

/** Per-block appearance: fence attrs → local CSS vars / data attributes. */
function applyBlockAttrs(el: HTMLElement, attrs: Record<string, string>): void {
	if (attrs["accent"]) el.style.setProperty("--mica-accent", attrs["accent"]);
	if (attrs["radius"]) el.style.setProperty("--mica-radius", `${Number(attrs["radius"]) || 0}px`);
	if (attrs["density"]) el.setAttribute("data-mica-density", attrs["density"]);
	if (attrs["tabstyle"]) el.setAttribute("data-mica-tabstyle", attrs["tabstyle"]);
}

function markGroupContainer(el: HTMLElement, path: number[], len: number): void {
	el.setAttribute("data-mica-container", "group");
	el.setAttribute("data-path", path.join("."));
	el.setAttribute("data-len", String(len));
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	const mode = ctx.headerMode ?? "hover";
	if (mode === "never" && !ctx.ui?.collapsed) return;
	const head = el.createDiv({ cls: `mica-head ${mode === "always" || ctx.ui?.collapsed ? "is-pinned" : ""}` });

	// Collapse chevron.
	const collapse = iconButton(
		head,
		"mica-head-btn mica-head-collapse",
		ctx.ui?.collapsed ? "chevron-right" : "chevron-down",
		ctx.ui?.collapsed ? "Expand block" : "Collapse block",
	);
	collapse.addEventListener("click", () => {
		if (!ctx.ui) return;
		ctx.ui.collapsed = !ctx.ui.collapsed;
		rerender(cst, el, ctx);
	});

	// Name (click to rename in LP).
	const name = ctx.blockAttrs?.["name"] ?? "";
	const nameBtn = head.createEl("button", {
		cls: `mica-head-name ${name ? "" : "is-unnamed"}`,
		text: name || "Untitled block",
		attr: { type: "button", "aria-label": ctx.editable ? "Rename block" : "Block name" },
	});
	if (ctx.editable) {
		nameBtn.addEventListener("click", () => {
			const input = head.createEl("input", { cls: "mica-rename", attr: { type: "text" } });
			head.insertBefore(input, nameBtn);
			nameBtn.style.display = "none";
			input.value = name;
			input.focus();
			input.select();
			let done = false;
			const commit = (): void => {
				if (done) return;
				done = true;
				const v = input.value.trim();
				if (v !== name) ctx.editable?.setAttr("name", v || null);
				else {
					input.remove();
					nameBtn.style.display = "";
				}
			};
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") commit();
				else if (e.key === "Escape") {
					done = true;
					input.remove();
					nameBtn.style.display = "";
				}
			});
			input.addEventListener("blur", commit);
		});
	}

	if (ctx.ui?.collapsed) {
		const tabs = countTabs(cst.children);
		head.createSpan({ cls: "mica-head-summary", text: tabs ? `${tabs} tab${tabs === 1 ? "" : "s"}` : "collapsed" });
	}

	head.createDiv({ cls: "mica-footer-spacer" });

	// Mode glyph: can this block be edited right here?
	const modeIco = head.createSpan({
		cls: "mica-head-mode",
		attr: { "aria-label": ctx.editable ? "Editable (Live Preview)" : "Read-only view" },
	});
	setIcon(modeIco, ctx.editable ? "pencil" : "book-open");

	// Navigator.
	iconButton(head, "mica-head-btn", "list-tree", "Block navigator").addEventListener("click", (e) => {
		openNavigator(cst, el, e);
	});

	// Overflow menu.
	iconButton(head, "mica-head-btn", "ellipsis-vertical", "Block menu").addEventListener("click", (e) => {
		const menu = new Menu();
		if (ctx.editable) {
			menu.addItem((i) =>
				i
					.setTitle("Edit block source")
					.setIcon("file-code")
					.onClick(() => {
						new EditorLightbox({
							app: ctx.app,
							title: ctx.blockAttrs?.["name"] ? `Edit “${ctx.blockAttrs["name"]}”` : "Edit block source",
							initial: serializeCst(cst),
							sourcePath: ctx.sourcePath,
							onSave: (value) => ctx.editable?.replaceAll(value),
						}).open();
					}),
			);
			menu.addItem((i) =>
				i
					.setTitle("Block appearance…")
					.setIcon("palette")
					.onClick(() => openAppearance(el, ctx)),
			);
			menu.addSeparator();
		}
		menu.addItem((i) =>
			i
				.setTitle("Copy block markdown")
				.setIcon("copy")
				.onClick(() => {
					void navigator.clipboard.writeText(serializeCst(cst)).then(
						() => new Notice("Block markdown copied."),
						() => new Notice("Couldn't access the clipboard."),
					);
				}),
		);
		if (ctx.chip) {
			const chip = ctx.chip;
			menu.addItem((i) =>
				i
					.setTitle("Version history…")
					.setIcon("history")
					.onClick(() => new VersionsModal(chip.plugin, chip.file, chip.blockId).open()),
			);
			menu.addItem((i) =>
				i
					.setTitle("Save version now")
					.setIcon("save")
					.onClick(() => {
						void chip.plugin.engine.snapshot(chip.file, true);
						new Notice("Mica: version saved.");
					}),
			);
		}
		menu.showAtMouseEvent(e);
	});
}

function countTabs(nodes: MicaNode[]): number {
	let n = 0;
	for (const c of nodes) {
		if (c.kind === "container") {
			if (c.name === "tab") n++;
			n += countTabs(c.children);
		}
	}
	return n;
}

/** Full re-render of the block into the same element (collapse, appearance). */
function rerender(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.empty();
	el.removeClass("is-collapsed");
	renderCst(cst, el, ctx);
}

/** The tree popover: jump to any tab/cell; shows per-tab word counts. */
function openNavigator(cst: Cst, root: HTMLElement, e: MouseEvent): void {
	const menu = new Menu();
	const walk = (nodes: MicaNode[], path: number[], depth: number): void => {
		nodes.forEach((n, i) => {
			if (n.kind !== "container") return;
			const p = [...path, i];
			if (n.name === "tab" || n.name === "cell" || n.name === "tabs" || n.name === "grid") {
				const [display] = splitTitleAttrs(n.title);
				const words = wordCount(n.children);
				const label = `${"    ".repeat(depth)}${iconFor(n.name)} ${display || n.name}${words ? `  ·  ${words}w` : ""}`;
				menu.addItem((item) => {
					item.setTitle(label);
					if (n.name === "tab") {
						item.onClick(() => activateTabByPath(root, p));
					}
				});
			}
			walk(n.children, p, depth + 1);
		});
	};
	walk(cst.children, [], 0);
	menu.showAtMouseEvent(e);
}

function iconFor(name: string): string {
	return name === "tabs" ? "▤" : name === "tab" ? "▸" : name === "grid" ? "▦" : "▢";
}

function wordCount(nodes: MicaNode[]): number {
	let n = 0;
	for (const c of nodes) {
		if (c.kind === "leaf") n += (c.text.match(/\S+/g) ?? []).length;
		else n += wordCount(c.children);
	}
	return n;
}

/** Click through the chip chain so the tab at `path` becomes visible. */
function activateTabByPath(root: HTMLElement, path: number[]): void {
	for (let depth = 1; depth <= path.length; depth++) {
		const prefix = path.slice(0, depth);
		const chip = root.querySelector<HTMLElement>(`.mica-tab-btn[data-mica-tab="${prefix.join(",")}"]`);
		chip?.click();
	}
}

/** Per-block appearance popover — writes fence attrs via the edit hooks. */
function openAppearance(el: HTMLElement, ctx: RenderCtx): void {
	el.querySelector(".mica-appearance")?.remove();
	const pop = el.createDiv({ cls: "mica-appearance" });
	const done = (): void => pop.remove();
	document.addEventListener(
		"pointerdown",
		function onOut(ev) {
			if (!pop.contains(ev.target as Node)) {
				pop.remove();
				document.removeEventListener("pointerdown", onOut, true);
			}
		},
		true,
	);

	pop.createDiv({ cls: "mica-appearance-title", text: "This block's appearance" });

	// Accent.
	const accentRow = pop.createDiv({ cls: "mica-appearance-row" });
	accentRow.createSpan({ text: "Accent" });
	const color = accentRow.createEl("input", { attr: { type: "color" } });
	color.value = ctx.blockAttrs?.["accent"] ?? "#8b5cf6";
	color.addEventListener("change", () => ctx.editable?.setAttr("accent", color.value));
	const clearAccent = iconButton(accentRow, "mica-head-btn", "rotate-ccw", "Follow the theme accent");
	clearAccent.addEventListener("click", () => ctx.editable?.setAttr("accent", null));

	// Density + tab style segments.
	const seg = (label: string, key: string, opts: [string, string][]): void => {
		const row = pop.createDiv({ cls: "mica-appearance-row" });
		row.createSpan({ text: label });
		const cur = ctx.blockAttrs?.[key] ?? "";
		for (const [value, text] of opts) {
			const b = row.createEl("button", {
				cls: `clickable-icon mica-pop-seg ${cur === value ? "is-on" : ""}`,
				text,
				attr: { type: "button" },
			});
			b.addEventListener("click", () => {
				ctx.editable?.setAttr(key, value || null);
				done();
			});
		}
	};
	seg("Density", "density", [
		["", "Theme"],
		["comfortable", "Comfy"],
		["compact", "Compact"],
	]);
	seg("Tabs", "tabstyle", [
		["", "Theme"],
		["connected", "Connected"],
		["underline", "Underline"],
		["pill", "Pill"],
	]);

	const radiusRow = pop.createDiv({ cls: "mica-appearance-row" });
	radiusRow.createSpan({ text: "Radius" });
	const slider = radiusRow.createEl("input", { attr: { type: "range", min: "0", max: "20", step: "1" } });
	slider.value = ctx.blockAttrs?.["radius"] ?? "10";
	slider.addEventListener("change", () => ctx.editable?.setAttr("radius", slider.value));

	pop.createDiv({
		cls: "mica-appearance-hint",
		text: "Saved into this block's header — travels with the note.",
	});
}

// ---------------------------------------------------------------------------
// Nodes, regions, insert zones
// ---------------------------------------------------------------------------

interface NodesOpts {
	insert?: boolean;
	autoOpen?: boolean;
}

function renderNodes(nodes: MicaNode[], el: HTMLElement, ctx: RenderCtx, path: number[], opts: NodesOpts = {}): void {
	let i = 0;
	let opened = false;
	let rendered = 0;
	while (i < nodes.length) {
		if (nodes[i].kind === "leaf") {
			let j = i;
			let md = "";
			while (j < nodes.length && nodes[j].kind === "leaf") {
				md += (nodes[j] as Leaf).text;
				j++;
			}
			const auto: boolean = Boolean(opts.autoOpen) && !opened;
			renderRegion(el, ctx, { path, start: i, end: j, original: md }, auto);
			opened = opened || auto;
			i = j;
		} else {
			if (ctx.editable && rendered > 0) renderInsertZone(el, ctx, path, i);
			renderContainer(nodes[i] as Container, el, ctx, [...path, i]);
			i++;
		}
		rendered++;
	}
	if (ctx.editable && nodes.length === 0) {
		renderRegion(el, ctx, { path, start: 0, end: 0, original: "" }, Boolean(opts.autoOpen) && !opened);
	}
	if (ctx.editable && opts.insert) renderInsertZone(el, ctx, path, nodes.length, true);
}

// What a region click must NOT hijack. Deliberately `.mica-mdeditor` and not
// `.cm-editor`: in Live Preview the whole widget lives inside the NOTE's
// .cm-editor, so matching that would swallow every region click.
const INTERACTIVE = "a, button, input, textarea, .internal-link, .mica-mdeditor";

function renderRegion(el: HTMLElement, ctx: RenderCtx, target: RegionTarget, autoOpen: boolean): void {
	const region = el.createDiv({ cls: "mica-region" });
	paintRegionView(region, ctx, target);

	if (ctx.editable) {
		const guard = (e: Event): boolean => !(e.target as HTMLElement).closest(INTERACTIVE);
		region.addEventListener("click", (e) => {
			if (!guard(e) || region.hasClass("is-editing")) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.ctrlKey || e.metaKey) openLightboxFor(ctx, target);
			else openQuickEdit(region, ctx, target);
		});
		region.addEventListener("contextmenu", (e) => {
			if (region.hasClass("is-editing")) return;
			e.preventDefault();
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle("Edit")
					.setIcon("pencil")
					.onClick(() => openQuickEdit(region, ctx, target)),
			);
			menu.addItem((i) =>
				i
					.setTitle("Edit in lightbox")
					.setIcon("maximize-2")
					.onClick(() => openLightboxFor(ctx, target)),
			);
			menu.showAtMouseEvent(e);
		});
	}

	// A surviving draft for this region reopens the editor seamlessly.
	const draft = ctx.ui?.draft;
	if (ctx.editable && draft && draft.key === draftKey(target)) {
		queueMicrotask(() => openQuickEdit(region, ctx, target, draft.text));
		return;
	}
	if (autoOpen && ctx.editable) queueMicrotask(() => openQuickEdit(region, ctx, target));
}

function paintRegionView(region: HTMLElement, ctx: RenderCtx, target: RegionTarget): void {
	region.empty();
	region.removeClass("is-editing");
	region.toggleClass("is-editable", Boolean(ctx.editable));
	const view = region.createDiv({ cls: "mica-md" });
	if (target.original.trim()) {
		renderMarkdown(target.original, view, ctx);
		if (ctx.editable) {
			const pencil = iconButton(region, "mica-region-pencil", "pencil", "Edit (Ctrl+click for the full editor)");
			pencil.addEventListener("click", (e) => {
				e.stopPropagation();
				if (e.ctrlKey || e.metaKey) openLightboxFor(ctx, target);
				else openQuickEdit(region, ctx, target);
			});
		}
	} else if (ctx.editable) {
		const ghost = view.createDiv({ cls: "mica-ghost" });
		setIcon(ghost.createSpan({ cls: "mica-ghost-icon" }), "pencil-line");
		ghost.createSpan({ cls: "mica-ghost-label", text: "Click to write…" });
	}
}

/**
 * A slim hover zone between siblings: insert tabs / grid / callout / code /
 * text exactly here — the "can't put prose between two groups" fix.
 */
function renderInsertZone(el: HTMLElement, ctx: RenderCtx, path: number[], at: number, tail = false): void {
	const zone = el.createDiv({ cls: `mica-insert-zone ${tail ? "is-tail" : ""}` });
	const line = zone.createDiv({ cls: "mica-insert-line" });
	void line;
	const btn = iconButton(zone, "mica-insert-plus", "plus", "Insert here…");
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Tabs")
				.setIcon("app-window")
				.onClick(() => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "tabs" })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Grid")
				.setIcon("layout-grid")
				.onClick(() => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "grid" })),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Text")
				.setIcon("text")
				.onClick(() => ctx.editable?.apply({ op: "insertLeaf", path, at, text: "\nWrite here…\n" })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Callout")
				.setIcon("megaphone")
				.onClick(() =>
					ctx.editable?.apply({ op: "insertLeaf", path, at, text: "\n> [!note] Title\n> Body\n" }),
				),
		);
		menu.addItem((i) =>
			i
				.setTitle("Code block")
				.setIcon("square-code")
				.onClick(() => ctx.editable?.apply({ op: "insertLeaf", path, at, text: "\n```\ncode\n```\n" })),
		);
		menu.showAtMouseEvent(e);
	});
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

function renderContainer(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	if (node.name === "tabs") {
		renderTabs(node, el, ctx, path);
	} else if (node.name === "grid") {
		renderGrid(node, el, ctx, path);
	} else {
		const box = el.createDiv({ cls: `mica-${node.name}` });
		renderNodes(node.children, box, ctx, path, { autoOpen: takeRegionReveal(ctx, path) });
	}
}

function renderTabs(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-tabs" });
	wrap.setAttribute("data-mica-idx", String(path[path.length - 1] ?? 0));
	const navOuter = wrap.createDiv({ cls: "mica-tab-nav-outer" });
	const nav = navOuter.createDiv({ cls: "mica-tab-nav", attr: { role: "tablist" } });
	nav.setAttribute("data-mica-container", "tab");
	nav.setAttribute("data-path", path.join("."));
	nav.setAttribute("data-len", String(node.children.length));
	nav.setAttribute("data-axis", "x");
	const panels = wrap.createDiv({ cls: "mica-tab-panels" });
	const tabs = node.children
		.map((c, idx) => ({ c, idx }))
		.filter((x) => x.c.kind === "container" && x.c.name === "tab");

	let revealTab = -1;
	const r = ctx.ui?.reveal;
	if (r && r.kind === "tab-edit" && prefixOf(path, r.path)) {
		revealTab = r.path[r.path.length - 1];
		ctx.ui!.reveal = null;
	}
	const pk = pathKey(path);
	let active = revealTab >= 0 ? tabs.findIndex((x) => x.idx === revealTab) : (ctx.ui?.active.get(pk) ?? 0);
	if (active >= tabs.length) active = tabs.length - 1;
	if (active < 0) active = 0;

	const btns: HTMLButtonElement[] = [];
	const panelEls: HTMLElement[] = [];
	const activate = (k: number, focus = false): void => {
		btns.forEach((b, m) => {
			b.toggleClass("is-active", m === k);
			b.setAttribute("aria-selected", String(m === k));
			b.tabIndex = m === k ? 0 : -1;
		});
		panelEls.forEach((p, m) => p.toggleClass("is-active", m === k));
		ctx.ui?.active.set(pk, k);
		if (focus) btns[k]?.focus();
	};

	tabs.forEach((x, k) => {
		const tab = x.c as Container;
		const [display] = splitTitleAttrs(tab.title);
		const icon = titleAttr(tab.title, "icon");
		const chip = nav.createDiv({ cls: "mica-tab-chip" });
		chip.setAttribute("data-mica-idx", String(x.idx));
		const btn = chip.createEl("button", {
			cls: "mica-tab-btn",
			attr: { type: "button", role: "tab", "data-mica-tab": [...path, x.idx].join(",") },
		});
		if (icon) setIcon(btn.createSpan({ cls: "mica-tab-icon" }), icon);
		btn.createSpan({ text: display || `Tab ${k + 1}` });
		btn.addEventListener("click", () => activate(k));

		if (ctx.editable) {
			chip.addClass("mica-chip-editable");
			btn.addEventListener("dblclick", (e) => {
				e.preventDefault();
				startRename(chip, btn, ctx, path, x.idx, display, tab.title);
			});
			iconButton(chip, "mica-chip-x", "x", "Delete tab").addEventListener("click", (e) => {
				e.stopPropagation();
				deleteWithUndo(ctx, { op: "deleteTab", path, index: x.idx }, "Tab deleted");
			});
			chip.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				tabContextMenu(e, ctx, path, x.idx, display);
			});
			makeDraggable(chip, "tab", [...path, x.idx], (op) => ctx.editable?.apply(op), chip);
			// Keyboard reorder: Alt+←/→ moves the focused tab.
			btn.addEventListener("keydown", (e) => {
				if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
				e.preventDefault();
				e.stopPropagation();
				const target = e.key === "ArrowLeft" ? x.idx - 1 : x.idx + 2;
				if (target < 0) return;
				ctx.editable?.apply({ op: "moveNode", from: [...path, x.idx], toParent: path, toIndex: target });
			});
		}
		const panel = panels.createDiv({ cls: "mica-tab-panel", attr: { role: "tabpanel" } });
		const body = panel.createDiv({ cls: "mica-tab-body" });
		markGroupContainer(body, [...path, x.idx], tab.children.length);
		renderNodes(tab.children, body, ctx, [...path, x.idx], { insert: true, autoOpen: revealTab === x.idx });
		btns.push(btn);
		panelEls.push(panel);
	});

	if (ctx.editable) {
		iconButton(nav, "mica-add mica-tab-add", "plus", "Add a tab").addEventListener("click", () =>
			ctx.editable?.apply({ op: "insertTab", path, at: node.children.length }),
		);
		const sticky = navOuter.createDiv({ cls: "mica-tab-nav-sticky" });
		// All-tabs menu (find a tab when the strip overflows).
		if (tabs.length > 5) {
			iconButton(sticky, "mica-head-btn", "chevron-down", "All tabs…").addEventListener("click", (e) => {
				const menu = new Menu();
				tabs.forEach((x, k) => {
					const [display] = splitTitleAttrs((x.c as Container).title);
					menu.addItem((i) =>
						i.setTitle(display || `Tab ${k + 1}`).onClick(() => {
							activate(k, true);
							btns[k]?.scrollIntoView({ inline: "nearest", block: "nearest" });
						}),
					);
				});
				menu.showAtMouseEvent(e);
			});
		}
		const grip = iconButton(sticky, "mica-group-grip", "grip-vertical", "Drag to move this tab group");
		makeDraggable(grip, "group", path, (op) => ctx.editable?.apply(op), wrap);
		iconButton(sticky, "mica-group-x", "trash-2", "Delete tab group").addEventListener("click", (e) => {
			e.stopPropagation();
			deleteWithUndo(ctx, { op: "deleteNode", path }, "Tab group deleted");
		});
	}

	nav.addEventListener("keydown", (ev: KeyboardEvent) => {
		if (ev.altKey) return; // Alt+arrows = reorder (handled on the chip)
		const current = btns.findIndex((b) => b.tabIndex === 0);
		if (current < 0 || !btns.length) return;
		const last = btns.length - 1;
		const next =
			ev.key === "ArrowRight"
				? (current + 1) % btns.length
				: ev.key === "ArrowLeft"
					? (current + last) % btns.length
					: ev.key === "Home"
						? 0
						: ev.key === "End"
							? last
							: -1;
		if (next < 0) return;
		ev.preventDefault();
		activate(next, true);
	});

	if (btns.length) activate(active, revealTab >= 0);
}

function tabContextMenu(e: MouseEvent, ctx: RenderCtx, path: number[], idx: number, display: string): void {
	const menu = new Menu();
	menu.addItem((i) =>
		i
			.setTitle("Rename")
			.setIcon("pencil")
			.onClick(() => {
				const chip = (e.target as HTMLElement).closest(".mica-tab-chip") as HTMLElement | null;
				const btn = chip?.querySelector(".mica-tab-btn") as HTMLElement | null;
				if (chip && btn) startRename(chip, btn, ctx, path, idx, display, display);
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Set icon…")
			.setIcon("smile")
			.onClick(() => {
				const name = window.prompt("Lucide icon name (empty to remove):", "");
				if (name === null) return;
				ctx.editable?.apply({ op: "setTabAttr", path, index: idx, key: "icon", value: name.trim() || null });
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Duplicate")
			.setIcon("copy-plus")
			.onClick(() => ctx.editable?.apply({ op: "duplicateNode", path: [...path, idx] })),
	);
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Delete")
			.setIcon("trash-2")
			.onClick(() => deleteWithUndo(ctx, { op: "deleteTab", path, index: idx }, "Tab deleted")),
	);
	menu.showAtMouseEvent(e);
}

function startRename(
	chip: HTMLElement,
	btn: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	index: number,
	display: string,
	_fullTitle: string,
): void {
	btn.style.display = "none";
	const input = chip.createEl("input", { cls: "mica-rename", attr: { type: "text" } });
	input.value = display;
	input.focus();
	input.select();
	let done = false;
	const commit = (): void => {
		if (done) return;
		done = true;
		ctx.editable?.apply({ op: "renameTab", path, index, title: input.value.trim() || "Tab" });
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			done = true;
			input.remove();
			btn.style.display = "";
		}
	});
	input.addEventListener("blur", commit);
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-grid-wrap" });
	wrap.setAttribute("data-mica-idx", String(path[path.length - 1] ?? 0));
	const grid = wrap.createDiv({ cls: "mica-grid" });
	grid.setAttribute("data-mica-container", "cell");
	grid.setAttribute("data-path", path.join("."));
	grid.setAttribute("data-len", String(node.children.length));
	grid.setAttribute("data-axis", "x");
	const cols = Number(titleAttr(node.title, "cols") ?? "2") || 2;
	grid.style.setProperty("--mica-cols", String(cols));

	node.children.forEach((c, idx) => {
		if (c.kind !== "container" || c.name !== "cell") return;
		const cellPath = [...path, idx];
		const cell = grid.createDiv({ cls: "mica-cell" });
		cell.setAttribute("data-mica-idx", String(idx));
		markGroupContainer(cell, cellPath, c.children.length);
		renderNodes(c.children, cell, ctx, cellPath, { autoOpen: takeRegionReveal(ctx, cellPath) });
		if (ctx.editable) {
			const bar = cell.createDiv({ cls: "mica-cell-bar" });
			const drag = iconButton(bar, "mica-cell-tool", "grip-vertical", "Drag to move this cell");
			makeDraggable(drag, "cell", cellPath, (op) => ctx.editable?.apply(op), cell);
			iconButton(bar, "mica-cell-tool", "x", "Delete cell").addEventListener("click", (e) => {
				e.stopPropagation();
				deleteWithUndo(ctx, { op: "deleteCell", path, index: idx }, "Cell deleted");
			});
		}
	});

	if (ctx.editable) {
		// Ghost tile: add a cell where the next one would land.
		const ghost = grid.createEl("button", {
			cls: "clickable-icon mica-cell-ghost",
			attr: { type: "button", "aria-label": "Add a cell" },
		});
		setIcon(ghost.createSpan(), "plus");
		ghost.addEventListener("click", () =>
			ctx.editable?.apply({ op: "insertCell", path, at: node.children.length }),
		);

		const bar = wrap.createDiv({ cls: "mica-grid-actions" });
		const colsBtn = bar.createEl("button", {
			cls: "mica-cols-chip",
			text: `${cols} col${cols === 1 ? "" : "s"}`,
			attr: { type: "button", "aria-label": "Change column count" },
		});
		colsBtn.addEventListener("click", () => {
			const input = bar.createEl("input", {
				cls: "mica-stepper-input",
				attr: { type: "number", min: "1", max: "24" },
			});
			bar.insertBefore(input, colsBtn);
			colsBtn.style.display = "none";
			input.value = String(cols);
			input.focus();
			input.select();
			let done = false;
			const commit = (): void => {
				if (done) return;
				done = true;
				const v = Math.max(1, Number(input.value) || cols);
				if (v !== cols) ctx.editable?.apply({ op: "setCols", path, cols: v });
				else {
					input.remove();
					colsBtn.style.display = "";
				}
			};
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") commit();
				else if (ev.key === "Escape") {
					done = true;
					input.remove();
					colsBtn.style.display = "";
				}
			});
			input.addEventListener("blur", commit);
		});
		bar.createDiv({ cls: "mica-nav-spacer" });
		const grip = iconButton(bar, "mica-group-grip", "grip-vertical", "Drag to move this grid");
		makeDraggable(grip, "group", path, (op) => ctx.editable?.apply(op), wrap);
		iconButton(bar, "mica-group-x", "trash-2", "Delete grid").addEventListener("click", (e) => {
			e.stopPropagation();
			deleteWithUndo(ctx, { op: "deleteNode", path }, "Grid deleted");
		});
	}
}

/** Destructive ops don't nag with confirms — they offer a one-click Undo. */
function deleteWithUndo(ctx: RenderCtx, op: StructOp, what: string): void {
	const before = ctx.preImage?.();
	ctx.editable?.apply(op);
	if (!before || !ctx.editable) return;
	const frag = document.createDocumentFragment();
	frag.appendChild(document.createTextNode(`${what}. `));
	const undo = document.createElement("button");
	undo.textContent = "Undo";
	undo.className = "mica-undo-btn";
	const notice = new Notice(frag, 8000);
	undo.addEventListener("click", () => {
		ctx.editable?.replaceAll(before);
		notice.hide();
	});
	frag.appendChild(undo);
	notice.setMessage(frag);
}

// ---------------------------------------------------------------------------
// Footer: version chip (auto/manual lives in the chip's menu now)
// ---------------------------------------------------------------------------

function renderFooter(root: HTMLElement, ctx: RenderCtx, chip: ChipInfo): void {
	const bar = root.createDiv({ cls: "mica-footer" });
	const p = chip.plugin;

	if (!p.settings.autoSnapshotEnabled) {
		const save = bar.createEl("button", {
			cls: "mica-save-now",
			text: "Save version",
			attr: { type: "button", "aria-label": "Snapshot the current content now (auto-save is off)" },
		});
		save.addEventListener("click", () => {
			void p.engine.snapshot(chip.file, true);
			new Notice("Mica: version saved.");
		});
	}
	bar.createDiv({ cls: "mica-footer-spacer" });
	if (p.settings.showVersionChip) renderVersionChip(bar, ctx, chip);
}

function renderVersionChip(bar: HTMLElement, ctx: RenderCtx, chip: ChipInfo): void {
	const p = chip.plugin;
	const btn = bar.createEl("button", {
		cls: "mica-chip",
		attr: { type: "button", "aria-label": "Version history" },
	});
	setIcon(btn.createSpan({ cls: "mica-chip-icon" }), "history");
	const count = btn.createSpan({ cls: "mica-chip-count", text: "…" });
	btn.createSpan({ cls: "mica-chip-dot" });
	btn.addEventListener("click", () => new VersionsModal(p, chip.file, chip.blockId).open());
	btn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		const menu = new Menu();
		const on = p.settings.autoSnapshotEnabled;
		menu.addItem((i) =>
			i
				.setTitle(on ? "Switch to manual saving" : "Switch to auto-save")
				.setIcon(on ? "pause" : "play")
				.onClick(async () => {
					p.settings.autoSnapshotEnabled = !on;
					p.engine.resetDebouncers();
					await p.saveSettings();
				}),
		);
		if (on) {
			for (const secs of [2, 5, 10, 30]) {
				menu.addItem((i) =>
					i
						.setTitle(
							`Auto-save after ${secs}s idle${p.settings.snapshotDebounceMs === secs * 1000 ? "  ✓" : ""}`,
						)
						.onClick(async () => {
							p.settings.snapshotDebounceMs = secs * 1000;
							p.engine.resetDebouncers();
							await p.saveSettings();
						}),
				);
			}
		}
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Save version now")
				.setIcon("save")
				.onClick(() => {
					void p.engine.snapshot(chip.file, true);
					new Notice("Mica: version saved.");
				}),
		);
		menu.showAtMouseEvent(e);
	});

	const refresh = async (): Promise<void> => {
		try {
			const state = (await p.engine.state(chip.file))[chip.blockId];
			const n = state?.versions.length ?? 0;
			const sig = contentSignature(chip.content);
			let dirty: boolean;
			if (state?.head) {
				const head = await readObject(p.app.vault, chip.file, state.head);
				dirty = head === null ? true : contentSignature(head) !== sig;
			} else {
				dirty = sig !== contentSignature("");
			}
			count.setText(String(n));
			btn.setAttr(
				"aria-label",
				`Version history — ${n} version${n === 1 ? "" : "s"}${dirty ? ", unsaved changes" : ""}. Right-click for auto-save options.`,
			);
			btn.toggleClass("is-dirty", dirty);
		} catch {
			count.setText("?");
		}
	};
	void refresh();
	ctx.component.register(
		p.engine.onSnapshot((f) => {
			if (f.path !== chip.file.path) return;
			void refresh();
			btn.addClass("mica-pulse");
			window.setTimeout(() => btn.removeClass("mica-pulse"), 550);
		}),
	);
}

// ---------------------------------------------------------------------------

function renderMarkdown(md: string, el: HTMLElement, ctx: RenderCtx): void {
	if (!md.trim()) return;
	void MarkdownRenderer.render(ctx.app, md, el.createDiv({ cls: "mica-md-inner" }), ctx.sourcePath, ctx.component);
}
