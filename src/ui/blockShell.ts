import { App, Component, Menu, MarkdownRenderer, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { contentSignature, serializeCst, type Cst, type MicaNode } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import type { Reveal, StructOp } from "../cst/ops";
import { makeDraggable } from "./dnd";
import { draftKey, openLightboxFor, openQuickEdit, type RegionTarget } from "./quickEdit";
import { openCalloutEditor, parseCallout } from "./calloutEditor";
import { calloutCatalog } from "./calloutCatalog";
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
	/** Folded sections/groups (keys: `r:<path>:<start>` and `n:<path>`). */
	folded: Set<string>;
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
	/** Internal: repaint the whole block without a doc change (folds). */
	rerenderBlock?: () => void;
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
	ctx.rerenderBlock = () => rerender(cst, el, ctx);

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
	el.setAttribute("data-mica-wrap", attrs["wrap"] === "off" ? "off" : "on");
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

	// Wrap toggle: wrap long lines everywhere in the block, or let regions
	// scroll horizontally. Persisted as a fence attr, travels with the note.
	if (ctx.editable) {
		const wrapped = (ctx.blockAttrs?.["wrap"] ?? "on") !== "off";
		const wrapBtn = iconButton(
			head,
			"mica-head-btn",
			wrapped ? "wrap-text" : "arrow-right-from-line",
			wrapped ? "Long lines wrap (click: scroll instead)" : "Long lines scroll (click: wrap instead)",
		);
		wrapBtn.setAttribute("aria-pressed", String(wrapped));
		wrapBtn.addEventListener("click", () => ctx.editable?.setAttr("wrap", wrapped ? "off" : null));
	}

	// Navigator.
	iconButton(head, "mica-head-btn", "list-tree", "Block navigator").addEventListener("click", (e) => {
		openNavigator(cst, el, ctx, e);
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
const regionFoldKey = (path: number[], start: number): string => `r:${path.join(",")}:${start}`;
const nodeFoldKey = (path: number[]): string => `n:${path.join(",")}`;

function toggleFold(ctx: RenderCtx, key: string): void {
	if (!ctx.ui) return;
	if (ctx.ui.folded.has(key)) ctx.ui.folded.delete(key);
	else ctx.ui.folded.add(key);
	ctx.rerenderBlock?.();
}

/** A folded group/section renders as one slim, expandable bar. */
function renderFoldBar(
	host: HTMLElement,
	ctx: RenderCtx,
	key: string,
	icon: string,
	summary: string,
	drag?: { path: number[]; region?: { start: number; end: number }; itemEl: HTMLElement },
): void {
	host.addClass("is-folded");
	const bar = host.createDiv({ cls: "mica-fold-bar" });
	const ico = bar.createSpan({ cls: "mica-fold-ico" });
	setIcon(ico, "chevron-right");
	const kindIco = bar.createSpan({ cls: "mica-fold-kind" });
	setIcon(kindIco, icon);
	bar.createSpan({ cls: "mica-fold-text", text: summary });
	bar.setAttribute("aria-label", "Unfold");
	bar.addEventListener("click", (e) => {
		e.stopPropagation();
		toggleFold(ctx, key);
	});
	if (ctx.editable && drag) {
		bar.createDiv({ cls: "mica-footer-spacer" });
		// The unfold toggle mirrors the fold button's corner, so the cursor
		// that just folded lands directly on the control that reverses it.
		iconButton(bar, "mica-minitool", "chevrons-up-down", "Unfold").addEventListener("click", (e) => {
			e.stopPropagation();
			toggleFold(ctx, key);
		});
		const grip = iconButton(bar, "mica-region-grip mica-fold-grip", "grip-vertical", "Drag to move");
		grip.addEventListener("click", (e) => e.stopPropagation());
		makeDraggable(
			grip,
			drag.region
				? { kind: "region", fromPath: drag.path, region: drag.region }
				: { kind: "group", fromPath: drag.path },
			drag.path,
			(op) => ctx.editable?.apply(op),
			drag.itemEl,
		);
	}
}

/** The one-line summary a folded thing shows. */
function foldSummary(text: string): string {
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t) return t.length > 64 ? `${t.slice(0, 64)}…` : t;
	}
	return "(empty)";
}

function rerender(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.empty();
	el.removeClass("is-collapsed");
	renderCst(cst, el, ctx);
}

/** The tree popover: jump to any tab/cell; shows per-tab word counts. */
function openNavigator(cst: Cst, root: HTMLElement, ctx: RenderCtx, e: MouseEvent): void {
	const menu = new Menu();
	const ICONS: Record<string, string> = {
		tabs: "app-window",
		tab: "corner-down-right",
		grid: "layout-grid",
		cell: "square",
	};
	const addSection = (parent: number[], u: { start: number; end: number; md: string }, depth: number): void => {
		if (!u.md.trim()) return;
		const pad = "    ".repeat(depth);
		const callout = parseCallout(u.md);
		let icon = "text";
		let label: string;
		if (callout) {
			icon = calloutCatalog(ctx.app).find((t) => t.id === callout.type || t.aliases.includes(callout.type))?.icon ?? "megaphone";
			label = callout.title || `[!${callout.type}]`;
		} else if (u.md.trimStart().startsWith("\u0060\u0060\u0060")) {
			icon = "square-code";
			label = u.md.trimStart().slice(3).split("\n")[0].trim() || "code";
		} else {
			label = foldSummary(u.md);
			if (label.length > 34) label = `${label.slice(0, 34)}…`;
		}
		menu.addItem((item) => {
			item.setTitle(`${pad}${label}`);
			item.setIcon(icon);
			item.onClick(() => revealNode(ctx, root, { path: parent, kind: "region", start: u.start }));
		});
	};
	const walk = (nodes: MicaNode[], path: number[], depth: number): void => {
		let i = 0;
		while (i < nodes.length) {
			const n = nodes[i];
			if (n.kind === "leaf") {
				const units = leafUnits(nodes, i);
				for (const u of units) addSection(path, u, depth);
				i = units.length ? units[units.length - 1].end : i + 1;
				continue;
			}
			const p = [...path, i];
			if (n.name === "tab" || n.name === "cell" || n.name === "tabs" || n.name === "grid") {
				const [display] = splitTitleAttrs(n.title);
				const words = wordCount(n.children);
				menu.addItem((item) => {
					item.setTitle(`${"    ".repeat(depth)}${display || n.name}${words ? `  ·  ${words}w` : ""}`);
					item.setIcon(ICONS[n.name] ?? "square");
					item.onClick(() => revealNode(ctx, root, { path: p, kind: n.name }));
				});
			}
			walk(n.children, p, depth + 1);
			i++;
		}
	};
	walk(cst.children, [], 0);
	menu.showAtMouseEvent(e);
}

function wordCount(nodes: MicaNode[]): number {
	let n = 0;
	for (const c of nodes) {
		if (c.kind === "leaf") n += (c.text.match(/\S+/g) ?? []).length;
		else n += wordCount(c.children);
	}
	return n;
}

/**
 * Take the reader TO a node: activate every ancestor tab, scroll it into
 * view, and flash its bounds so the eye lands where the click meant.
 */
interface RevealSpec {
	path: number[];
	kind: string;
	/** Region targets: the unit's start index within `path`'s children. */
	start?: number;
}

function revealNode(ctx: RenderCtx, root: HTMLElement, spec: RevealSpec): void {
	// Folded ancestors (or a folded target) hide the destination entirely —
	// unfold first, re-render, THEN locate elements in the fresh DOM.
	if (ctx.ui) {
		let changed = false;
		for (let depth = 1; depth <= spec.path.length; depth++) {
			if (ctx.ui.folded.delete(nodeFoldKey(spec.path.slice(0, depth)))) changed = true;
		}
		if (spec.kind !== "region" && ctx.ui.folded.delete(nodeFoldKey(spec.path))) changed = true;
		if (spec.start !== undefined && ctx.ui.folded.delete(regionFoldKey(spec.path, spec.start))) changed = true;
		if (changed) ctx.rerenderBlock?.();
	}
	// Activate the ancestor tab chain (chips carry their comma-joined path).
	for (let depth = 1; depth <= spec.path.length; depth++) {
		const prefix = spec.path.slice(0, depth);
		const chip = root.querySelector<HTMLElement>(`.mica-tab-btn[data-mica-tab="${prefix.join(",")}"]`);
		chip?.click();
	}
	const dotted = spec.path.join(".");
	let target: HTMLElement | null;
	if (spec.kind === "region" && spec.start !== undefined) {
		// Structural membership: the unit's element is the [data-mica-idx]
		// whose nearest container is the region's parent container.
		const parent = root.querySelector<HTMLElement>(`[data-mica-container="group"][data-path="${dotted}"]`);
		target =
			parent
				? (Array.from(parent.querySelectorAll<HTMLElement>(`[data-mica-idx="${spec.start}"]`)).find(
						(k) => k.parentElement?.closest("[data-mica-container]") === parent,
					) ?? null)
				: null;
	} else if (spec.kind === "tab") {
		// Tabs highlight their BODY (the panel content).
		target =
			root.querySelector<HTMLElement>(`[data-mica-container="group"][data-path="${dotted}"]`) ??
			root.querySelector<HTMLElement>(`[data-mica-node="${dotted}"]`);
	} else {
		target =
			root.querySelector<HTMLElement>(`[data-mica-node="${dotted}"]`) ??
			root.querySelector<HTMLElement>(`[data-path="${dotted}"]`);
	}
	if (!target) return;
	target.scrollIntoView({ block: "center", behavior: "smooth" });
	target.addClass("mica-flash");
	window.setTimeout(() => target.removeClass("mica-flash"), 1400);
}

/** Per-block appearance popover — writes fence attrs via the edit hooks. */
/** The block's effective accent as #rrggbb (for the color input's initial). */
function resolveAccentHex(el: HTMLElement): string {
	const probe = el.createSpan();
	probe.style.color = "var(--mica-accent)";
	const rgb = getComputedStyle(probe).color;
	probe.remove();
	const m = rgb.match(/\d+/g);
	if (!m || m.length < 3) return "#8b5cf6";
	return `#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, "0")).join("")}`;
}

function openAppearance(el: HTMLElement, ctx: RenderCtx): void {
	el.querySelector(".mica-appearance")?.remove();
	const pop = el.createDiv({ cls: "mica-appearance" });
	// Every close path releases the document listener — a segment click must
	// not leave it armed until the next stray pointerdown.
	const done = (): void => {
		pop.remove();
		document.removeEventListener("pointerdown", onOut, true);
	};
	function onOut(ev: PointerEvent): void {
		if (!pop.contains(ev.target as Node)) done();
	}
	document.addEventListener("pointerdown", onOut, true);

	pop.createDiv({ cls: "mica-appearance-title", text: "This block's appearance" });

	// Accent. An override here SHADOWS the global setting for this block —
	// say so explicitly, or the global control looks broken.
	const overridden = Boolean(ctx.blockAttrs?.["accent"]);
	const accentRow = pop.createDiv({ cls: "mica-appearance-row" });
	accentRow.createSpan({ text: "Accent" });
	if (overridden) accentRow.createSpan({ cls: "mica-appearance-override", text: "overrides global" });
	const color = accentRow.createEl("input", { attr: { type: "color" } });
	color.value = ctx.blockAttrs?.["accent"] ?? resolveAccentHex(el);
	color.addEventListener("change", () => ctx.editable?.setAttr("accent", color.value));
	const clearAccent = iconButton(
		accentRow,
		`mica-head-btn ${overridden ? "is-override" : ""}`,
		"rotate-ccw",
		overridden ? "Remove this block's override (follow the global accent)" : "Follow the theme accent",
	);
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

/**
 * Split a leaf RUN starting at `from` into display units: leading spacing +
 * one content leaf + trailing spacing per unit. The renderer's regions and
 * the navigator's section rows both derive from this, so their `start`
 * indices (= `data-mica-idx`) can never disagree.
 */
function leafUnits(nodes: MicaNode[], from: number): { start: number; end: number; md: string }[] {
	const isLeaf = (n: number): boolean => n < nodes.length && nodes[n].kind === "leaf";
	const isWs = (n: number): boolean => isLeaf(n) && !(nodes[n] as Leaf).text.trim();
	const units: { start: number; end: number; md: string }[] = [];
	let i = from;
	while (isLeaf(i)) {
		let j = i;
		while (isWs(j)) j++;
		if (isLeaf(j)) j++;
		while (isWs(j)) j++;
		let md = "";
		for (let k = i; k < j; k++) md += (nodes[k] as Leaf).text;
		units.push({ start: i, end: j, md });
		i = j;
	}
	return units;
}

function renderNodes(nodes: MicaNode[], el: HTMLElement, ctx: RenderCtx, path: number[], opts: NodesOpts = {}): void {
	let i = 0;
	let opened = false;
	while (i < nodes.length) {
		if (nodes[i].kind === "leaf") {
			// The parser splits callouts and code fences into their own leaves;
			// each becomes its own region (grip + pencil). Whitespace-only
			// leaves glue to the PRECEDING unit so spacing between sections
			// never renders as a phantom empty region.
			for (const u of leafUnits(nodes, i)) {
				if (ctx.editable && u.start > 0) renderInsertZone(el, ctx, path, u.start);
				const auto: boolean = Boolean(opts.autoOpen) && !opened;
				renderRegion(
					el,
					ctx,
					{ path, start: u.start, end: u.end, original: u.md },
					auto,
					u.start === 0 && u.end === nodes.length,
				);
				opened = opened || auto;
				i = u.end;
			}
		} else {
			// Insert-between zones — including BEFORE the first section.
			if (ctx.editable) renderInsertZone(el, ctx, path, i);
			renderContainer(nodes[i] as Container, el, ctx, [...path, i]);
			i++;
		}
	}
	if (ctx.editable && nodes.length === 0) {
		renderRegion(el, ctx, { path, start: 0, end: 0, original: "" }, Boolean(opts.autoOpen) && !opened);
	}
	// Append-at-end is available EVERYWHERE there is already content.
	if (ctx.editable && nodes.length > 0) renderInsertZone(el, ctx, path, nodes.length, true);
}

/**
 * The one "insert something here" menu: prose, callout, code, tabs, or grid.
 * `onText` lets empty regions open their editor instead of inserting a stub.
 */
function showInsertMenu(ctx: RenderCtx, path: number[], at: number, e: MouseEvent, onText?: () => void): void {
	const menu = new Menu();
	menu.addItem((i) =>
		i
			.setTitle("Text")
			.setIcon("text")
			.onClick(() => {
				if (onText) onText();
				else ctx.editable?.apply({ op: "insertLeaf", path, at, text: "\nWrite here…\n" });
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Callout")
			.setIcon("megaphone")
			.onClick(() => ctx.editable?.apply({ op: "insertLeaf", path, at, text: "\n> [!note] Title\n> Body\n" })),
	);
	menu.addItem((i) =>
		i
			.setTitle("Code block")
			.setIcon("square-code")
			.onClick(() =>
				ctx.editable?.apply({
					op: "insertLeaf",
					path,
					at,
					text: "\n\u0060\u0060\u0060\ncode\n\u0060\u0060\u0060\n",
				}),
			),
	);
	menu.addSeparator();
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
	menu.showAtMouseEvent(e);
}

/**
 * Insert a cell at flow position `at`, choosing its content type — used by the
 * "+" tile and the vertical column strips. `extra` appends context items
 * (e.g. "New column").
 */
function showCellTypeMenu(
	ctx: RenderCtx,
	gridPath: number[],
	at: number,
	e: MouseEvent,
	extra?: (menu: Menu) => void,
): void {
	const menu = new Menu();
	const addCellWith = (follow?: StructOp): void => {
		ctx.editable?.apply({ op: "insertCell", path: gridPath, at });
		// The second op targets the fresh cell; each dispatch re-scans the live
		// document, so chaining is corruption-proof.
		if (follow) window.setTimeout(() => ctx.editable?.apply(follow), 0);
	};
	menu.addItem((i) =>
		i
			.setTitle("Text")
			.setIcon("text")
			.onClick(() => {
				if (ctx.ui) ctx.ui.reveal = { path: [...gridPath, at], kind: "region-edit" };
				ctx.editable?.apply({ op: "insertCell", path: gridPath, at });
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Callout")
			.setIcon("megaphone")
			.onClick(() =>
				addCellWith({ op: "insertLeaf", path: [...gridPath, at], at: 0, text: "\n> [!note] Title\n> Body\n" }),
			),
	);
	menu.addItem((i) =>
		i
			.setTitle("Code block")
			.setIcon("square-code")
			.onClick(() =>
				addCellWith({
					op: "insertLeaf",
					path: [...gridPath, at],
					at: 0,
					text: "\n\u0060\u0060\u0060\ncode\n\u0060\u0060\u0060\n",
				}),
			),
	);
	menu.addSeparator();
	menu.addItem((i) =>
		i
			.setTitle("Tabs")
			.setIcon("app-window")
			.onClick(() => addCellWith({ op: "insertGroup", path: [...gridPath, at], at: 0, kind: "tabs" })),
	);
	menu.addItem((i) =>
		i
			.setTitle("Grid (nested)")
			.setIcon("layout-grid")
			.onClick(() => addCellWith({ op: "insertGroup", path: [...gridPath, at], at: 0, kind: "grid" })),
	);
	extra?.(menu);
	menu.showAtMouseEvent(e);
}

// What a region click must NOT hijack. Deliberately `.mica-mdeditor` and not
// `.cm-editor`: in Live Preview the whole widget lives inside the NOTE's
// .cm-editor, so matching that would swallow every region click.
const INTERACTIVE = "a, button, input, textarea, .internal-link, .mica-mdeditor";

function renderRegion(
	el: HTMLElement,
	ctx: RenderCtx,
	target: RegionTarget,
	autoOpen: boolean,
	sole = false,
): void {
	const region = el.createDiv({ cls: `mica-region ${sole ? "is-sole" : ""}` });
	if (target.start < target.end) region.setAttribute("data-mica-idx", String(target.start));
	paintRegionView(region, ctx, target);

	if (ctx.editable) {
		const guard = (e: Event): boolean => !(e.target as HTMLElement).closest(INTERACTIVE);
		region.addEventListener("click", (e) => {
			if (!guard(e) || region.hasClass("is-editing")) return;
			e.preventDefault();
			e.stopPropagation();
			if (region.hasClass("is-folded")) {
				toggleFold(ctx, regionFoldKey(target.path, target.start));
				return;
			}
			if (!target.original.trim()) {
				// Empty space offers the full palette (text / callout / code / groups).
				showInsertMenu(ctx, target.path, target.start, e, () => openQuickEdit(region, ctx, target));
				return;
			}
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
			if (parseCallout(target.original)) {
				menu.addItem((i) =>
					i
						.setTitle("Edit callout (structured)…")
						.setIcon("megaphone")
						.onClick(() => openCalloutEditor(ctx, target)),
				);
			}
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
	const fkey = regionFoldKey(target.path, target.start);
	if (ctx.ui?.folded.has(fkey) && target.original.trim()) {
		renderFoldBar(region, ctx, fkey, "text", foldSummary(target.original), {
			path: target.path,
			region: { start: target.start, end: target.end },
			itemEl: region,
		});
		return;
	}
	region.removeClass("is-folded");
	const view = region.createDiv({ cls: "mica-md" });
	if (target.original.trim()) {
		renderMarkdown(target.original, view, ctx);
		if (ctx.editable) {
			// One hover tool: the grip. Clicking the text edits; the pencil was
			// a redundant second path to the same action.
			const tools = region.createDiv({ cls: "mica-region-tools" });
			const grip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag to move · click text to edit");
			grip.addEventListener("click", (e) => e.stopPropagation());
			makeDraggable(
				grip,
				{ kind: "region", fromPath: target.path, region: { start: target.start, end: target.end } },
				target.path,
				(op) => ctx.editable?.apply(op),
				region,
			);
			if (parseCallout(target.original)) {
				iconButton(tools, "mica-minitool", "maximize-2", "Edit callout (type, title, body)").addEventListener(
					"click",
					(e) => {
						e.stopPropagation();
						openCalloutEditor(ctx, target);
					},
				);
			}
			iconButton(tools, "mica-minitool", "chevrons-down-up", "Fold this section").addEventListener(
				"click",
				(e) => {
					e.stopPropagation();
					toggleFold(ctx, fkey);
				},
			);
			iconButton(tools, "mica-minitool mica-region-x", "x", "Delete this section").addEventListener(
				"click",
				(e) => {
					e.stopPropagation();
					deleteWithUndo(
						ctx,
						{
							op: "saveRegion",
							path: target.path,
							start: target.start,
							end: target.end,
							expected: target.original,
							text: "",
						},
						"Section deleted",
					);
				},
			);
		}
	} else if (ctx.editable) {
		const ghost = view.createDiv({ cls: "mica-ghost" });
		setIcon(ghost.createSpan({ cls: "mica-ghost-icon" }), "plus");
		ghost.createSpan({ cls: "mica-ghost-label", text: "Add…" });
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
		showInsertMenu(ctx, path, at, e);
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
	wrap.setAttribute("data-mica-node", path.join("."));
	const tkey = nodeFoldKey(path);
	if (ctx.ui?.folded.has(tkey)) {
		const n = node.children.filter((c) => c.kind === "container" && c.name === "tab").length;
		renderFoldBar(wrap, ctx, tkey, "app-window", `Tabs · ${n}`, { path, itemEl: wrap });
		return;
	}
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
		// A freshly inserted tab is ACTIVATED but never auto-opens an editor —
		// its empty body offers the "+ Add…" menu instead.
		renderNodes(tab.children, body, ctx, [...path, x.idx], { insert: true });
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
		iconButton(sticky, "mica-minitool mica-group-fold", "chevrons-down-up", "Fold this tab group").addEventListener(
			"click",
			(e) => {
				e.stopPropagation();
				toggleFold(ctx, tkey);
			},
		);
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

/**
 * Draggable dividers between grid columns. Dragging rebalances the two
 * adjacent columns' fr fractions live; release persists `colw` into the
 * grid's header via the shared reducer (double-click resets to equal).
 */
/** Write the grid's row template: per-row MIN heights, `null` = content. */
function applyRowTemplate(grid: HTMLElement, rows: (number | null)[]): void {
	if (rows.some((h) => h !== null)) {
		grid.style.gridTemplateRows = rows.map((h) => (h ? `minmax(${h}px, auto)` : "auto")).join(" ");
	} else {
		grid.style.removeProperty("grid-template-rows");
	}
}

/** Serialize row heights for the header attr (trailing autos trimmed). */
function rowhValue(rows: (number | null)[]): string | null {
	const trimmed = [...rows];
	while (trimmed.length && trimmed[trimmed.length - 1] === null) trimmed.pop();
	if (!trimmed.length) return null;
	return trimmed.map((h) => (h === null ? "auto" : String(h))).join(",");
}

function mountGridResizers(
	grid: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	cols: number,
	widths: number[],
	rowHeights: (number | null)[],
): void {
	const strips: HTMLElement[] = [];
	const rowStrips: HTMLElement[] = [];
	// The direct cells are fixed for this mount — any structural change
	// re-renders the whole block — so query once, not per layout pass.
	const cells = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .mica-cell"));
	const rowCount = Math.ceil(cells.length / cols);
	const layout = (): void => {
		if (!grid.isConnected) return;
		const g = grid.getBoundingClientRect();
		// Roll the rect reads: boundary b shares cells[b] with boundary b+1.
		let right = cells[0]?.getBoundingClientRect();
		for (let b = 1; b < cols; b++) {
			const strip = strips[b - 1];
			const left = right;
			right = cells[b]?.getBoundingClientRect();
			if (!left || !right || right.left <= left.right - 1) {
				strip.style.display = "none"; // boundary has no cells yet
				continue;
			}
			strip.style.display = "";
			strip.style.left = `${(left.right + right.left) / 2 - g.left - 4}px`;
		}
		// Row boundaries: the first cell of each row carries the row's box.
		for (let r = 0; r + 1 < rowCount; r++) {
			const strip = rowStrips[r];
			const above = cells[r * cols]?.getBoundingClientRect();
			const below = cells[(r + 1) * cols]?.getBoundingClientRect();
			if (!above || !below || below.top <= above.bottom - 1) {
				strip.style.display = "none";
				continue;
			}
			strip.style.display = "";
			strip.style.top = `${(above.bottom + below.top) / 2 - g.top - 4}px`;
		}
	};
	const live = (w: number[]): void => {
		grid.style.gridTemplateColumns = w.map((x) => `minmax(0, ${x.toFixed(3)}fr)`).join(" ");
	};

	for (let b = 1; b < cols && cells.length > 1; b++) {
		const strip = grid.createDiv({ cls: "mica-col-resizer" });
		strip.createDiv({ cls: "mica-col-resizer-line" });
		strips.push(strip);
		strip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			// Reset ONLY this pair: both take their average share; if that makes
			// every column equal again, drop the attr entirely.
			const w = [...widths];
			const avg = (w[b - 1] + w[b]) / 2;
			w[b - 1] = avg;
			w[b] = avg;
			const rounded = w.map((x) => Math.round(x * 100) / 100);
			const uniform = rounded.every((x) => Math.abs(x - rounded[0]) < 0.03);
			ctx.editable?.apply({
				op: "setGroupAttr",
				path,
				key: "colw",
				value: uniform ? null : rounded.join(","),
			});
		});
		strip.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const startX = down.clientX;
			const startW = [...widths];
			const total = startW.reduce((a, x) => a + x, 0);
			const frPerPx = total / Math.max(1, grid.clientWidth);
			let lastW = startW;
			const move = (e: PointerEvent): void => {
				// Clamp so neither neighbour shrinks below 0.15fr.
				const raw = (e.clientX - startX) * frPerPx;
				const dFr = Math.max(-(startW[b - 1] - 0.15), Math.min(startW[b] - 0.15, raw));
				const w = [...startW];
				w[b - 1] = startW[b - 1] + dFr;
				w[b] = startW[b] - dFr;
				lastW = w;
				live(w);
				layout();
			};
			const up = (e: PointerEvent): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				if (e.type !== "pointerup" || Math.abs(e.clientX - startX) < 3) return;
				widths.splice(0, widths.length, ...lastW);
				const rounded = lastW.map((x) => Math.round(x * 100) / 100);
				const uniform = rounded.every((x) => Math.abs(x - rounded[0]) < 0.03);
				ctx.editable?.apply({
					op: "setGroupAttr",
					path,
					key: "colw",
					value: uniform ? null : rounded.join(","),
				});
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		});
	}
	// Row dividers: dragging sets the UPPER row's minimum height in px.
	for (let r = 0; r + 1 < rowCount; r++) {
		const strip = grid.createDiv({ cls: "mica-row-resizer" });
		strip.createDiv({ cls: "mica-row-resizer-line" });
		rowStrips.push(strip);
		strip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			rowHeights[r] = null;
			ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: rowhValue(rowHeights) });
		});
		strip.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const startY = down.clientY;
			const startH = rowHeights[r] ?? Math.round(cells[r * cols]?.getBoundingClientRect().height ?? 80);
			let lastH: number | null = null;
			const move = (e: PointerEvent): void => {
				lastH = Math.max(40, Math.round(startH + (e.clientY - startY)));
				const live = [...rowHeights];
				live[r] = lastH;
				applyRowTemplate(grid, live);
				layout();
			};
			const up = (e: PointerEvent): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				if (e.type !== "pointerup" || lastH === null || Math.abs(e.clientY - startY) < 3) return;
				rowHeights[r] = lastH;
				ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: rowhValue(rowHeights) });
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		});
	}

	// Track layout: cells resize as content changes; keep dividers glued.
	const ro = new ResizeObserver(() => layout());
	ro.observe(grid);
	// Every edit rebuilds the block into a fresh element; disconnect with the
	// component or each repaint stacks a live observer on a detached grid.
	ctx.component.register(() => ro.disconnect());
	window.requestAnimationFrame(layout);
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-grid-wrap" });
	wrap.setAttribute("data-mica-idx", String(path[path.length - 1] ?? 0));
	wrap.setAttribute("data-mica-node", path.join("."));
	const gkey = nodeFoldKey(path);
	if (ctx.ui?.folded.has(gkey)) {
		const cells = node.children.filter((c) => c.kind === "container" && c.name === "cell").length;
		renderFoldBar(wrap, ctx, gkey, "layout-grid", `Grid · ${cells} cell${cells === 1 ? "" : "s"}`, {
			path,
			itemEl: wrap,
		});
		return;
	}
	const grid = wrap.createDiv({ cls: "mica-grid" });
	grid.setAttribute("data-mica-container", "cell");
	grid.setAttribute("data-path", path.join("."));
	grid.setAttribute("data-len", String(node.children.length));
	grid.setAttribute("data-axis", "x");
	grid.setAttribute("data-cols", String(Number(titleAttr(node.title, "cols") ?? "2") || 2));
	const cols = Number(titleAttr(node.title, "cols") ?? "2") || 2;
	grid.style.setProperty("--mica-cols", String(cols));
	// Per-column fractions (fence-persisted via the shared reducer).
	const colwRaw = (titleAttr(node.title, "colw") ?? "")
		.split(",")
		.map(Number)
		.filter((n) => Number.isFinite(n) && n > 0);
	const widths = colwRaw.length === cols ? colwRaw : new Array<number>(cols).fill(1);
	if (colwRaw.length === cols) {
		grid.style.gridTemplateColumns = widths.map((w) => `minmax(0, ${w}fr)`).join(" ");
	}
	// Per-row MIN heights ("rowh=140,auto,200"): rows can be spaced out but
	// never clip content (minmax(Xpx, auto)).
	const rowHeights: (number | null)[] = (titleAttr(node.title, "rowh") ?? "")
		.split(",")
		.map((t) => {
			const n = Number(t);
			return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
		});
	applyRowTemplate(grid, rowHeights);

	node.children.forEach((c, idx) => {
		if (c.kind !== "container" || c.name !== "cell") return;
		const cellPath = [...path, idx];
		const cell = grid.createDiv({ cls: "mica-cell" });
		cell.setAttribute("data-mica-idx", String(idx));
		cell.setAttribute("data-mica-node", cellPath.join("."));
		markGroupContainer(cell, cellPath, c.children.length);
		renderNodes(c.children, cell, ctx, cellPath, { autoOpen: takeRegionReveal(ctx, cellPath) });
		if (ctx.editable) {
			// Vertical column strip on the cell's left edge: insert a cell (typed)
			// at this flow position — the "add to the left" affordance.
			const colzone = cell.createDiv({ cls: "mica-cell-colzone" });
			colzone.createDiv({ cls: "mica-colzone-line" });
			const colplus = iconButton(colzone, "mica-colzone-plus", "plus", "Insert a cell here (column-wise)");
			colplus.addEventListener("click", (e) => {
				e.stopPropagation();
				showCellTypeMenu(ctx, path, idx, e);
			});
			const bar = cell.createDiv({ cls: "mica-cell-bar" });
			const drag = iconButton(bar, "mica-cell-tool", "grip-vertical", "Drag to move this cell");
			makeDraggable(drag, "cell", cellPath, (op) => ctx.editable?.apply(op), cell);
			iconButton(bar, "mica-cell-tool", "maximize-2", "Edit this cell in the full editor").addEventListener(
				"click",
				(e) => {
					e.stopPropagation();
					openLightboxFor(ctx, {
						path: cellPath,
						start: 0,
						end: c.children.length,
						original: serializeCst({ children: c.children }),
					});
				},
			);
			iconButton(bar, "mica-cell-tool", "x", "Delete cell").addEventListener("click", (e) => {
				e.stopPropagation();
				deleteWithUndo(ctx, { op: "deleteCell", path, index: idx }, "Cell deleted");
			});
		}
	});

	if (ctx.editable) {
		const tools = wrap.createDiv({ cls: "mica-grid-tools" });
		iconButton(tools, "mica-minitool", "chevrons-down-up", "Fold this grid").addEventListener("click", (e) => {
			e.stopPropagation();
			toggleFold(ctx, gkey);
		});
		const topGrip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag to move this grid");
		topGrip.addEventListener("click", (e) => e.stopPropagation());
		makeDraggable(topGrip, "group", path, (op) => ctx.editable?.apply(op), wrap);
		iconButton(tools, "mica-minitool mica-region-x", "x", "Delete grid").addEventListener("click", (e) => {
			e.stopPropagation();
			deleteWithUndo(ctx, { op: "deleteNode", path }, "Grid deleted");
		});

		// Grid resizers: dividers between columns (fr shares) and rows (min px).
		mountGridResizers(grid, ctx, path, cols, widths, rowHeights);

		// Ghost tile: add a cell where the next one would land.
		const ghost = grid.createEl("button", {
			cls: "clickable-icon mica-cell-ghost",
			attr: { type: "button", "aria-label": "Add a cell (choose its content)" },
		});
		setIcon(ghost.createSpan(), "plus");
		ghost.addEventListener("click", (e) => {
			showCellTypeMenu(ctx, path, node.children.length, e);
		});

		// Right-edge strip: append a cell, or grow the grid by a column.
		const endzone = grid.createDiv({ cls: "mica-grid-colzone-end" });
		endzone.createDiv({ cls: "mica-colzone-line" });
		const endplus = iconButton(endzone, "mica-colzone-plus", "plus", "Add a cell or a new column");
		endplus.addEventListener("click", (e) => {
			e.stopPropagation();
			showCellTypeMenu(ctx, path, node.children.length, e, (menu) => {
				menu.addSeparator();
				menu.addItem((i) =>
					i
						.setTitle(`New column (${cols} → ${cols + 1})`)
						.setIcon("columns-3")
						.onClick(() => ctx.editable?.apply({ op: "setCols", path, cols: cols + 1 })),
				);
			});
		});

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
