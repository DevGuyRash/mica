import { App, Component, Menu, MarkdownRenderer, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { parseBlock, contentSignature, serializeCst, type Cst, type MicaNode } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import type { Reveal, StructOp } from "../cst/ops";
import { makeDraggable } from "./dnd";
import { draftKey, openLightboxFor, openQuickEdit, type RegionTarget } from "./quickEdit";
import { openCalloutEditor, openCalloutEditorFor, parseCallout } from "./calloutEditor";
import { dedentNested, findNestedCallouts, requoteOnce, spliceLines } from "./nestedCallouts";
import { calloutCatalog } from "./calloutCatalog";
import { EditorLightbox } from "./lightbox";
import { VersionsModal } from "./versionsModal";
import { copyNodes, copyText, type CopyOptions } from "./copyPayload";

/** The hooks a rendered block uses to mutate itself (Live Preview only). */
export interface EditHooks {
	/** Original document position used only to order ID-less block batches from
	 * bottom to top; every individual batch still re-scans before dispatch. */
	order: number;
	/** True only when the live document accepted and dispatched the op. */
	apply: (op: StructOp) => boolean;
	/** Apply a batch against one fresh CST and dispatch once. A rejected member
	 * rejects the whole batch, which keeps multi-editor Save all-or-nothing. */
	applyMany: (ops: readonly StructOp[]) => boolean;
	/** Replace the whole block content (undo toasts, whole-block edits). */
	replaceAll: (expected: string, content: string) => boolean;
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
	draft: { key: string; text: string; expected: string } | null;
	collapsed: boolean;
	/** Folded sections/groups (keys: `r:<path>:<start>` and `n:<path>`). */
	folded: Set<string>;
	/** Persist the fold set (folds survive restarts). Set by the host. */
	persistFolds?: () => void;
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
	/** Read the current clipboard preferences when a copy button is pressed. */
	copyOptions?: () => CopyOptions;
	/** The block's current content — captured before destructive ops for Undo. */
	preImage?: () => string;
	/** Internal: repaint one region back to view mode after a cancel. */
	repaintRegion?: (region: HTMLElement, target: RegionTarget) => void;
	/** Internal: repaint the whole block without a doc change (folds). */
	rerenderBlock?: () => void;
	/** Internal: the block's root children — ancestry checks for unified
	 * gap menus ("Below the tabs group…"). Set by renderCst. */
	rootNodes?: MicaNode[];
	/** Internal owner/pass split: repainting unloads every observer/listener
	 * registered by the previous render before installing the next pass. */
	renderPassOwner?: Component;
	renderPass?: Component;
}

type Container = Extract<MicaNode, { kind: "container" }>;
type Leaf = Extract<MicaNode, { kind: "leaf" }>;

let closeActiveNavigator: (() => void) | null = null;

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

type CopyTarget = { nodes: readonly MicaNode[] } | { text: string };

interface CopyControl {
	kind: "block" | "tabs" | "tab" | "grid" | "cell" | "text" | "callout" | "code" | "nested-callout";
	label: string;
	notice: string;
	path?: readonly number[];
	target: CopyTarget | (() => CopyTarget);
}

function clipboardText(ctx: RenderCtx, target: CopyTarget): string {
	const options = ctx.copyOptions?.() ?? { includeMicaSyntax: false, includeOuterContainer: false };
	return "nodes" in target ? copyNodes(target.nodes, options) : copyText(target.text, options);
}

function copyTarget(ctx: RenderCtx, control: CopyControl): void {
	const target = typeof control.target === "function" ? control.target() : control.target;
	const text = clipboardText(ctx, target);
	if (!text) {
		new Notice("Nothing to copy.");
		return;
	}
	void navigator.clipboard.writeText(text).then(
		() => new Notice(control.notice),
		() => new Notice("Couldn't access the clipboard."),
	);
}

function copyButton(parent: HTMLElement, ctx: RenderCtx, cls: string, control: CopyControl): HTMLButtonElement {
	const button = iconButton(parent, `mica-copy-btn ${cls}`, "copy", control.label);
	button.dataset.micaCopyKind = control.kind;
	if (control.path) button.dataset.micaCopyPath = control.path.join(".");
	button.addEventListener("pointerdown", (event) => event.stopPropagation());
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		copyTarget(ctx, control);
	});
	return button;
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
	if (!ctx.renderPassOwner) {
		const pass = new Component();
		ctx.component.addChild(pass);
		renderCst(cst, el, { ...ctx, component: pass, renderPassOwner: ctx.component, renderPass: pass });
		return;
	}
	el.addClass("mica");
	el.setAttribute("data-mica-mode", ctx.editable ? "edit" : "read");
	applyBlockAttrs(el, ctx.blockAttrs ?? {});

	// A repaint closure so collapse and cancels can redraw without a doc change.
	ctx.repaintRegion = (region, target) => paintRegionView(region, ctx, target);
	ctx.rerenderBlock = () => rerender(cst, el, ctx);
	ctx.rootNodes = cst.children;

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
				const t = e.target as HTMLElement;
				if (t.closest("a, .internal-link")) return;
				// Our stopPropagation starves Obsidian's document-level
				// menu-close listener: menus opened from the widget would
				// linger (and stack) until Esc. Close them ourselves. The
				// synthetic events skip "pointerdown" so the click-outside
				// editor handler (pointerdown-only) never miscounts a
				// widget-internal click as outside.
				if (type === "pointerdown" && document.querySelector("body > .menu")) {
					for (const evt of ["mousedown", "click"] as const) {
						document.body.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
					}
				}
				e.stopPropagation();
				// A TRUSTED mousedown on text-less chrome (empty regions, cell
				// padding, bars, strips) lets the browser place the native
				// caret at the nearest EDITABLE position — which is outside
				// this contenteditable=false widget, i.e. in the outer
				// document INSIDE the block's range: the block then flips to
				// raw source. stopPropagation cannot stop a native default
				// action — only preventDefault can. Allow the default only
				// where it means something: rendered prose (text selection)
				// and real inputs/editors (focus).
				if (
					type === "mousedown" &&
					!t.closest('.mica-md, input, textarea, [contenteditable="true"], .mica-mdeditor')
				) {
					e.preventDefault();
					// Belt AND suspenders: some trusted-input paths (WebDriver
					// focus steps, browser quirks) plant the caret in chrome
					// regardless. A later DOM mutation would relocate it and
					// CodeMirror would sync it as an in-block cursor. Evict it.
					queueMicrotask(() => {
						const s = window.getSelection();
						if (s?.anchorNode && el.contains(s.anchorNode)) s.removeAllRanges();
					});
				}
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
	// Structural outlines: absent attr = follow the global setting (body class).
	if (attrs["outline"]) el.setAttribute("data-mica-outline", attrs["outline"]);
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

	copyButton(head, ctx, "mica-head-btn", {
		kind: "block",
		label: "Copy block contents",
		notice: "Block copied.",
		target: { nodes: cst.children },
	});

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
							onSave: (value) => {
								if (!ctx.editable?.replaceAll(serializeCst(cst), value)) {
									new Notice(
										"Mica: the block changed while the editor was open. Your edit was not applied.",
									);
									return false;
								}
								return true;
							},
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
				.setTitle("Copy block contents")
				.setIcon("copy")
				.onClick(() =>
					copyTarget(ctx, {
						kind: "block",
						label: "Copy block contents",
						notice: "Block copied.",
						target: { nodes: cst.children },
					}),
				),
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
					.onClick(() => void saveVersionNow(chip.plugin, chip.file)),
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
	ctx.ui.persistFolds?.();
	ctx.rerenderBlock?.();
}

/** A folded group/section renders as one slim, expandable bar. */
function renderFoldBar(
	host: HTMLElement,
	ctx: RenderCtx,
	key: string,
	icon: string,
	summary: string,
	drag?: {
		path: number[];
		region?: { start: number; end: number };
		itemEl: HTMLElement;
		text?: string;
		copy?: CopyControl;
	},
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
	if (drag?.copy || (ctx.editable && drag)) {
		bar.createDiv({ cls: "mica-footer-spacer" });
		if (drag?.copy) copyButton(bar, ctx, "mica-minitool", drag.copy);
	}
	if (ctx.editable && drag) {
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
				? { kind: "region", fromPath: drag.path, region: drag.region, text: drag.text }
				: { kind: "group", fromPath: drag.path, text: drag.text },
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

function regionCopyControl(target: RegionTarget): CopyControl {
	const isCallout = Boolean(parseCallout(target.original));
	const isCode = /^(?: {0,3})(?:`{3,}|~{3,})/.test(target.original);
	const kind = isCallout ? "callout" : isCode ? "code" : "text";
	return {
		kind,
		label: kind === "callout" ? "Copy callout" : kind === "code" ? "Copy code block" : "Copy text section",
		notice: kind === "callout" ? "Callout copied." : kind === "code" ? "Code block copied." : "Section copied.",
		path: [...target.path, target.start],
		target: { text: target.original },
	};
}

function rerender(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	if (ctx.renderPass && ctx.renderPassOwner) ctx.renderPassOwner.removeChild(ctx.renderPass);
	el.empty();
	el.removeClass("is-collapsed");
	renderCst(cst, el, {
		...ctx,
		component: ctx.renderPassOwner ?? ctx.component,
		renderPassOwner: undefined,
		renderPass: undefined,
	});
}

/** The tree popover: jump to any tab/cell; shows per-tab word counts. */
interface NavRow {
	kind: "container" | "region";
	path: number[];
	parentPath: number[];
	/** CST index within the parent (containers: own idx; regions: start). */
	index: number;
	/** Regions: one past the unit's last child index. */
	end?: number;
	/** The parent's child-list length (for end-of-parent drops). */
	parentLen: number;
	revealKind: string;
	el: HTMLElement;
}

/**
 * The block navigator: a tree popover of every container and section. Click
 * reveals (unfolding + switching tabs as needed); dragging a row reorders it
 * among its SIBLINGS — drop before a sibling, or after the parent's last row.
 */
function openNavigator(cst: Cst, root: HTMLElement, ctx: RenderCtx, e: MouseEvent): void {
	closeActiveNavigator?.();
	// Body-level + fixed: never clipped by the block, and it SURVIVES the
	// block re-renders that reveal/unfold trigger — so it stays open while
	// the user jumps between several targets. Outside click / Esc closes.
	const pop = document.body.createDiv({ cls: "mica-popover mica-navpop" });
	const left = Math.min(Math.max(8, e.clientX - 260), window.innerWidth - 348);
	const top = Math.min(e.clientY + 12, window.innerHeight - 120);
	pop.style.left = `${left}px`;
	pop.style.top = `${top}px`;
	pop.style.maxHeight = `${Math.max(120, window.innerHeight - top - 16)}px`;
	let closed = false;
	const dismiss = (): void => {
		if (closed) return;
		closed = true;
		pop.remove();
		document.removeEventListener("pointerdown", onOut, true);
		document.removeEventListener("keydown", onKey, true);
		if (closeActiveNavigator === dismiss) closeActiveNavigator = null;
	};
	closeActiveNavigator = dismiss;
	(ctx.renderPassOwner ?? ctx.component).register(dismiss);
	const onOut = (ev: PointerEvent): void => {
		if (!pop.contains(ev.target as Node)) dismiss();
	};
	const onKey = (ev: KeyboardEvent): void => {
		if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			dismiss();
		}
	};
	document.addEventListener("pointerdown", onOut, true);
	document.addEventListener("keydown", onKey, true);

	const ICONS: Record<string, string> = {
		tabs: "app-window",
		tab: "corner-down-right",
		grid: "layout-grid",
		cell: "square",
	};
	const rows: NavRow[] = [];

	const addRow = (depth: number, icon: string, label: string, count: number, nav: Omit<NavRow, "el">): void => {
		const el = pop.createDiv({ cls: "mica-nav-row" });
		el.style.paddingLeft = `${8 + depth * 16}px`;
		const ico = el.createSpan({ cls: "mica-nav-ico" });
		setIcon(ico, icon);
		el.createSpan({ cls: "mica-nav-label", text: label });
		if (count) el.createSpan({ cls: "mica-nav-count", text: `${count}w` });
		const row: NavRow = { ...nav, el };
		rows.push(row);
		wireNavRow(row, rows, ctx, root, dismiss);
	};

	const addSection = (
		parent: number[],
		parentLen: number,
		u: { start: number; end: number; md: string },
		depth: number,
	): void => {
		if (!u.md.trim()) return;
		const callout = parseCallout(u.md);
		let icon = "text";
		let label: string;
		if (callout) {
			icon =
				calloutCatalog(ctx.app).find((t) => t.id === callout.type || t.aliases.includes(callout.type))?.icon ??
				"megaphone";
			label = callout.title || `[!${callout.type}]`;
		} else if (u.md.trimStart().startsWith("\u0060\u0060\u0060")) {
			icon = "square-code";
			label = u.md.trimStart().slice(3).split("\n")[0].trim() || "code";
		} else {
			label = foldSummary(u.md);
			if (label.length > 34) label = `${label.slice(0, 34)}…`;
		}
		addRow(depth, icon, label, 0, {
			kind: "region",
			path: parent,
			parentPath: parent,
			index: u.start,
			end: u.end,
			parentLen,
			revealKind: "region",
		});
	};

	const walk = (nodes: MicaNode[], path: number[], depth: number): void => {
		let i = 0;
		while (i < nodes.length) {
			const n = nodes[i];
			if (n.kind === "leaf") {
				const units = leafUnits(nodes, i);
				for (const u of units) addSection(path, nodes.length, u, depth);
				i = units.length ? units[units.length - 1].end : i + 1;
				continue;
			}
			const p = [...path, i];
			if (n.name === "tab" || n.name === "cell" || n.name === "tabs" || n.name === "grid") {
				const [display] = splitTitleAttrs(n.title);
				addRow(depth, ICONS[n.name] ?? "square", display || n.name, wordCount(n.children), {
					kind: "container",
					path: p,
					parentPath: path,
					index: i,
					parentLen: nodes.length,
					revealKind: n.name,
				});
			}
			walk(n.children, p, depth + 1);
			i++;
		}
	};
	walk(cst.children, [], 0);
	if (!rows.length) pop.createDiv({ cls: "mica-pop-empty", text: "Nothing here yet" });
}

/** Click = reveal; drag (5px threshold) = reorder among same-parent rows. */
function wireNavRow(row: NavRow, rows: NavRow[], ctx: RenderCtx, root: HTMLElement, dismiss: () => void): void {
	// A keyboard path for the one structural affordance that lacked one:
	// Tab reaches rows, Enter/Space reveals, arrows walk the tree.
	row.el.setAttribute("role", "button");
	row.el.tabIndex = 0;
	row.el.addEventListener("keydown", (ke: KeyboardEvent) => {
		if (ke.key === "Enter" || ke.key === " ") {
			ke.preventDefault();
			for (const r of rows) r.el.removeClass("is-current");
			row.el.addClass("is-current");
			revealNode(ctx, root, {
				path: row.path,
				kind: row.revealKind,
				start: row.kind === "region" ? row.index : undefined,
			});
			return;
		}
		if (ke.key === "ArrowDown" || ke.key === "ArrowUp") {
			ke.preventDefault();
			const i = rows.indexOf(row);
			rows[i + (ke.key === "ArrowDown" ? 1 : -1)]?.el.focus();
		}
	});
	row.el.addEventListener("pointerdown", (down: PointerEvent) => {
		if (down.button !== 0) return;
		down.preventDefault();
		const startX = down.clientX;
		const startY = down.clientY;
		let dragging = false;
		let target: { row: NavRow; after: boolean } | null = null;
		const pk = row.parentPath.join(".");
		const siblings = rows.filter((r) => r.parentPath.join(".") === pk);
		const last = siblings[siblings.length - 1];

		const clearMarks = (): void => {
			for (const r of siblings) r.el.removeClass("mica-nav-dropbefore", "mica-nav-dropafter");
		};
		const isNoop = (t: { row: NavRow; after: boolean }): boolean => {
			const toIndex = t.after ? t.row.parentLen : t.row.index;
			if (row.kind === "region") return toIndex >= row.index && toIndex <= (row.end ?? row.index);
			return toIndex === row.index || toIndex === row.index + 1;
		};

		const home = row.el.getBoundingClientRect();
		const move = (ev: PointerEvent): void => {
			if (!dragging) {
				if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
				dragging = true;
				row.el.addClass("mica-nav-dragging");
			}
			clearMarks();
			target = null;
			// Home zone: wiggling within the row's own bounds offers nothing.
			if (
				ev.clientX >= home.left &&
				ev.clientX <= home.right &&
				ev.clientY >= home.top &&
				ev.clientY <= home.bottom
			)
				return;
			let bestDist = Number.POSITIVE_INFINITY;
			for (const r of siblings) {
				const rect = r.el.getBoundingClientRect();
				const mid = rect.top + rect.height / 2;
				const after = r === last && ev.clientY > mid;
				const cand = { row: r, after };
				if (isNoop(cand)) continue;
				const gapY = after ? rect.bottom : rect.top;
				const dist = Math.abs(ev.clientY - gapY);
				if (dist < bestDist) {
					bestDist = dist;
					target = cand;
				}
			}
			if (target) target.row.el.addClass(target.after ? "mica-nav-dropafter" : "mica-nav-dropbefore");
		};
		const onEsc = (ke: KeyboardEvent): void => {
			if (ke.key !== "Escape") return;
			ke.preventDefault();
			ke.stopPropagation();
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
			window.removeEventListener("keydown", onEsc, true);
			clearMarks();
			row.el.removeClass("mica-nav-dragging");
			dragging = false;
			target = null;
		};
		window.addEventListener("keydown", onEsc, true);
		const up = (ev: PointerEvent): void => {
			window.removeEventListener("pointermove", move, true);
			window.removeEventListener("pointerup", up, true);
			window.removeEventListener("pointercancel", up, true);
			window.removeEventListener("keydown", onEsc, true);
			clearMarks();
			row.el.removeClass("mica-nav-dragging");
			if (!dragging) {
				// Plain click: reveal (unfold + switch tabs) but STAY OPEN —
				// the user may want to jump to several things in a row.
				for (const r of rows) r.el.removeClass("is-current");
				row.el.addClass("is-current");
				revealNode(ctx, root, {
					path: row.path,
					kind: row.revealKind,
					start: row.kind === "region" ? row.index : undefined,
				});
				return;
			}
			if (ev.type !== "pointerup" || !target) return;
			const toIndex = target.after ? target.row.parentLen : target.row.index;
			dismiss();
			if (row.kind === "region") {
				ctx.editable?.apply({
					op: "moveRegion",
					path: row.parentPath,
					start: row.index,
					end: row.end ?? row.index + 1,
					toParent: row.parentPath,
					toIndex,
				});
			} else {
				ctx.editable?.apply({
					op: "moveNode",
					from: row.path,
					toParent: row.parentPath,
					toIndex,
				});
			}
		};
		window.addEventListener("pointermove", move, true);
		window.addEventListener("pointerup", up, true);
		window.addEventListener("pointercancel", up, true);
	});
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
		if (changed) {
			ctx.ui.persistFolds?.();
			ctx.rerenderBlock?.();
		}
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
		target = parent
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
	return `#${m
		.slice(0, 3)
		.map((x) => Number(x).toString(16).padStart(2, "0"))
		.join("")}`;
}

function openAppearance(el: HTMLElement, ctx: RenderCtx): void {
	const existing = el.querySelector(".mica-appearance") as (HTMLElement & { micaClose?: () => void }) | null;
	if (existing?.micaClose) existing.micaClose();
	else existing?.remove();
	const pop = el.createDiv({ cls: "mica-appearance" }) as HTMLElement & { micaClose?: () => void };
	// Every close path releases the document listener — a segment click must
	// not leave it armed until the next stray pointerdown.
	let closed = false;
	const done = (): void => {
		if (closed) return;
		closed = true;
		pop.remove();
		document.removeEventListener("pointerdown", onOut, true);
		document.removeEventListener("keydown", onEsc, true);
	};
	pop.micaClose = done;
	ctx.component.register(done);
	function onOut(ev: PointerEvent): void {
		if (!pop.contains(ev.target as Node)) done();
	}
	function onEsc(ev: KeyboardEvent): void {
		if (ev.key === "Escape") {
			ev.preventDefault();
			ev.stopPropagation();
			done();
		}
	}
	document.addEventListener("pointerdown", onOut, true);
	document.addEventListener("keydown", onEsc, true);

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
	seg("Outlines", "outline", [
		["", "Default"],
		["on", "On"],
		["off", "Off"],
	]);

	const radiusRow = pop.createDiv({ cls: "mica-appearance-row" });
	radiusRow.createSpan({ text: "Radius" });
	const radiusOverridden = Boolean(ctx.blockAttrs?.["radius"]);
	if (radiusOverridden) radiusRow.createSpan({ cls: "mica-appearance-override", text: "overrides global" });
	const slider = radiusRow.createEl("input", { attr: { type: "range", min: "0", max: "20", step: "1" } });
	// Seed from the EFFECTIVE radius (the block override, else the resolved
	// global) — a literal default would misrepresent unoverridden blocks.
	const effectiveRadius = parseFloat(getComputedStyle(el).getPropertyValue("--mica-radius"));
	slider.value = ctx.blockAttrs?.["radius"] ?? String(Number.isFinite(effectiveRadius) ? effectiveRadius : 10);
	slider.addEventListener("change", () => ctx.editable?.setAttr("radius", slider.value));
	const clearRadius = iconButton(
		radiusRow,
		`mica-head-btn ${radiusOverridden ? "is-override" : ""}`,
		"rotate-ccw",
		radiusOverridden ? "Remove this block's override (follow the global radius)" : "Follows the global radius",
	);
	clearRadius.addEventListener("click", () => ctx.editable?.setAttr("radius", null));

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
	let lastContainerEl: HTMLElement | null = null;
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
			lastContainerEl = null;
		} else {
			// Insert-between zones — including BEFORE the first section.
			if (ctx.editable) renderInsertZone(el, ctx, path, i);
			renderContainer(nodes[i] as Container, el, ctx, [...path, i]);
			lastContainerEl = el.lastElementChild as HTMLElement | null;
			i++;
		}
	}
	if (ctx.editable && nodes.length === 0) {
		renderRegion(el, ctx, { path, start: 0, end: 0, original: "" }, Boolean(opts.autoOpen) && !opened);
	}
	// Append-at-end is available EVERYWHERE there is already content — except
	// when this container ends with a tabs group whose every panel already
	// carries its own tail zone: two stacked lines in one visual gap read as
	// competing affordances. The inner line's menu still reaches this level
	// ("Below the tabs group…"). "Every panel" because tab switches toggle
	// classes without a re-render — any panel can become the visible one.
	const panels = lastContainerEl?.classList.contains("mica-tabs")
		? Array.from(lastContainerEl.querySelectorAll(":scope > .mica-tab-panels > .mica-tab-panel"))
		: [];
	const innerOwnsGap = panels.length > 0 && panels.every((p) => p.querySelector(".mica-insert-zone.is-tail"));
	if (ctx.editable && nodes.length > 0 && !innerOwnsGap) renderInsertZone(el, ctx, path, nodes.length, true);
}

/**
 * The one "insert something here" menu: prose, callout, code, tabs, or grid.
 * `onText` lets empty regions open their editor instead of inserting a stub.
 */
function showInsertMenu(
	ctx: RenderCtx,
	path: number[],
	at: number,
	e: MouseEvent,
	onText?: () => void,
	tail = false,
): void {
	const menu = new Menu();
	menu.addItem((i) =>
		i
			.setTitle("Text")
			.setIcon("text")
			.onClick(() => {
				if (onText) onText();
				else ctx.editable?.apply({ op: "insertLeaf", path, at, text: "Write here…\n" });
			}),
	);
	menu.addItem((i) =>
		i
			.setTitle("Callout")
			.setIcon("megaphone")
			.onClick(() => ctx.editable?.apply({ op: "insertLeaf", path, at, text: "> [!note] Title\n> Body\n" })),
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
					text: "\u0060\u0060\u0060\ncode\n\u0060\u0060\u0060\n",
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
	// A tab body's tail zone owns the visual gap BELOW its whole tabs group
	// (that level's own zone is suppressed to keep one line per gap) — reach
	// the outer level from here. Chained menus handle nested tabs naturally.
	if (tail && path.length >= 2) {
		const groupPath = path.slice(0, -1);
		const group = nodeAtPath(ctx.rootNodes ?? [], groupPath);
		if (group?.kind === "container" && group.name === "tabs") {
			const parentPath = groupPath.slice(0, -1);
			const parent = parentPath.length ? nodeAtPath(ctx.rootNodes ?? [], parentPath) : null;
			const siblings = parentPath.length
				? parent?.kind === "container"
					? parent.children
					: null
				: (ctx.rootNodes ?? null);
			const gIdx = groupPath[groupPath.length - 1];
			if (siblings && gIdx === siblings.length - 1) {
				menu.addSeparator();
				menu.addItem((i) =>
					i
						.setTitle("Below the tabs group…")
						.setIcon("corner-down-right")
						.onClick(() => showInsertMenu(ctx, parentPath, gIdx + 1, e, undefined, true)),
				);
			}
		}
	}
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
				addCellWith({ op: "insertLeaf", path: [...gridPath, at], at: 0, text: "> [!note] Title\n> Body\n" }),
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
					text: "\u0060\u0060\u0060\ncode\n\u0060\u0060\u0060\n",
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

function renderRegion(el: HTMLElement, ctx: RenderCtx, target: RegionTarget, autoOpen: boolean, sole = false): void {
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
		queueMicrotask(() => openQuickEdit(region, ctx, { ...target, original: draft.expected }, draft.text));
		return;
	}
	if (autoOpen && ctx.editable) queueMicrotask(() => openQuickEdit(region, ctx, target));
}

/**
 * Callouts nested INSIDE a callout are text, not structure — but they still
 * deserve tools. Each rendered `.callout .callout` is zipped (document
 * order) with its source line range; edit/delete/drag all run as guarded
 * text surgery on the parent region.
 */
function wireNestedCallouts(view: HTMLElement, ctx: RenderCtx, target: RegionTarget): void {
	const nested = findNestedCallouts(target.original);
	if (!nested.length) return;
	const rendered = Array.from(view.querySelectorAll<HTMLElement>(".callout .callout"));
	nested.forEach((nc, i) => {
		const el = rendered[i];
		if (!el) return;
		el.addClass("mica-nested-callout");
		const tools = el.createDiv({ cls: "mica-region-tools mica-nested-tools" });
		const stop = (e: Event): void => e.stopPropagation();
		const nestedText = (): string => dedentNested(target.original, nc);
		copyButton(tools, ctx, "mica-minitool", {
			kind: "nested-callout",
			label: "Copy nested callout",
			notice: "Nested callout copied.",
			path: [...target.path, target.start, i],
			target: () => ({ text: nestedText() }),
		});
		if (!ctx.editable) return;

		const grip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag this callout out");
		grip.addEventListener("click", stop);
		const without = (): string => spliceLines(target.original, nc.startLine, nc.endLine, null);
		makeDraggable(
			grip,
			{
				kind: "region",
				fromPath: target.path,
				text: nestedText,
				virtualSplice: {
					path: target.path,
					start: target.start,
					end: target.end,
					expected: target.original,
					without,
					insertCount: () => parseBlock(nestedText()).children.length,
				},
			},
			target.path,
			(op) => ctx.editable?.apply(op),
			el,
		);

		iconButton(tools, "mica-minitool", "maximize-2", "Edit this callout (type, title, body)").addEventListener(
			"click",
			(e) => {
				e.stopPropagation();
				const parsed = parseCallout(nestedText());
				if (!parsed) return;
				openCalloutEditorFor(ctx, parsed, (rebuilt) => {
					const next = spliceLines(target.original, nc.startLine, nc.endLine, requoteOnce(rebuilt).trimEnd());
					if (next === target.original) return;
					const accepted =
						ctx.editable?.apply({
							op: "saveRegion",
							path: target.path,
							start: target.start,
							end: target.end,
							expected: target.original,
							text: next,
						}) ?? false;
					if (!accepted)
						new Notice("Mica: the callout changed while you were editing. Your edit is still open.");
					return accepted;
				});
			},
		);

		iconButton(tools, "mica-minitool mica-region-x", "x", "Delete this callout").addEventListener("click", (e) => {
			e.stopPropagation();
			deleteWithUndo(
				ctx,
				{
					op: "saveRegion",
					path: target.path,
					start: target.start,
					end: target.end,
					expected: target.original,
					text: without(),
				},
				"Nested callout deleted",
			);
		});
	});
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
			text: target.original,
			copy: regionCopyControl(target),
		});
		return;
	}
	region.removeClass("is-folded");
	const view = region.createDiv({ cls: "mica-md" });
	if (target.original.trim()) {
		renderMarkdown(target.original, view, ctx);
		const tools = region.createDiv({ cls: "mica-region-tools" });
		copyButton(tools, ctx, "mica-minitool", regionCopyControl(target));
		if (ctx.editable) {
			// One hover tool: the grip. Clicking the text edits; the pencil was
			// a redundant second path to the same action.
			const grip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag to move · click text to edit");
			grip.addEventListener("click", (e) => e.stopPropagation());
			makeDraggable(
				grip,
				{
					kind: "region",
					fromPath: target.path,
					region: { start: target.start, end: target.end },
					text: target.original,
				},
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
		wireNestedCallouts(view, ctx, target);
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
		showInsertMenu(ctx, path, at, e, undefined, tail);
	});
}

/** The node at a root-relative child-index path (null when it dead-ends). */
function nodeAtPath(nodes: MicaNode[], path: number[]): MicaNode | null {
	let cur: MicaNode | null = null;
	let list = nodes;
	for (const idx of path) {
		cur = list[idx] ?? null;
		if (!cur) return null;
		list = cur.kind === "container" ? cur.children : [];
	}
	return cur;
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
		renderFoldBar(wrap, ctx, tkey, "app-window", `Tabs · ${n}`, {
			path,
			itemEl: wrap,
			text: serializeCst({ children: [node] }),
			copy: {
				kind: "tabs",
				label: "Copy tab group contents",
				notice: "Tab group copied.",
				path,
				target: { nodes: [node] },
			},
		});
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
		chip.addClass("mica-chip-copyable");
		chip.setAttribute("data-mica-idx", String(x.idx));
		const btn = chip.createEl("button", {
			cls: "mica-tab-btn",
			attr: { type: "button", role: "tab", "data-mica-tab": [...path, x.idx].join(",") },
		});
		if (icon) setIcon(btn.createSpan({ cls: "mica-tab-icon" }), icon);
		btn.createSpan({ text: display || `Tab ${k + 1}` });
		btn.addEventListener("click", () => activate(k));
		copyButton(chip, ctx, "mica-chip-copy", {
			kind: "tab",
			label: `Copy tab “${display || `Tab ${k + 1}`}” contents`,
			notice: "Tab copied.",
			path: [...path, x.idx],
			target: { nodes: [tab] },
		});

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
	}
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
	copyButton(sticky, ctx, "mica-minitool", {
		kind: "tabs",
		label: "Copy tab group contents",
		notice: "Tab group copied.",
		path,
		target: { nodes: [node] },
	});
	if (ctx.editable) {
		iconButton(sticky, "mica-minitool mica-group-fold", "chevrons-down-up", "Fold this tab group").addEventListener(
			"click",
			(e) => {
				e.stopPropagation();
				toggleFold(ctx, tkey);
			},
		);
		const grip = iconButton(sticky, "mica-group-grip", "grip-vertical", "Drag to move this tab group");
		makeDraggable(
			grip,
			{ kind: "group", fromPath: path, text: serializeCst({ children: [node] }) },
			path,
			(op) => ctx.editable?.apply(op),
			wrap,
		);
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
	const stop = (): void => document.removeEventListener("pointerdown", onOutside, true);
	const commit = (): void => {
		if (done) return;
		done = true;
		stop();
		ctx.editable?.apply({ op: "renameTab", path, index, title: input.value.trim() || "Tab" });
	};
	// Clicking a non-focusable surface never fires blur — commit explicitly.
	const onOutside = (ev: PointerEvent): void => {
		if (ev.target !== input) commit();
	};
	document.addEventListener("pointerdown", onOutside, true);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			done = true;
			stop();
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
	let layoutHandles: () => void = () => {};
	const layout = (): void => {
		if (!grid.isConnected) return;
		layoutHandles();
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

	// The ⊕ pill is the ONE click-to-add target; the strip itself only ever
	// resizes (drag) or resets (double-click) — a bare strip click did both
	// jobs before and the first click of a double-click inserted a column.
	// Activation is pointer-captured with a movement tolerance: a native
	// click dies when the pointer drifts a few pixels between down and up,
	// which read as "the button just didn't trigger".
	const plusPill = (strip: HTMLElement, tip: string, run: () => void): void => {
		const pill = iconButton(strip, "mica-boundary-plus", "plus", tip);
		// Pointer-gesture activation: capture keeps the pointerup on the pill
		// so a few pixels of drift still count as a click (a native click
		// dies on any drift — "the button just didn't trigger"), while >8px
		// is a deliberate move and does nothing. The click handler is only
		// the programmatic fallback (a real gesture already ran or was a
		// drift-reject; either way the click must not double-fire).
		let pointerGesture = false;
		let ran = false;
		pill.addEventListener("click", (e) => {
			e.stopPropagation(); // edge strips also listen for click
			if (!pointerGesture && !ran) run();
			pointerGesture = false;
			ran = false;
		});
		pill.addEventListener("pointerdown", (e) => {
			pointerGesture = true;
			ran = false;
			e.stopPropagation(); // never arm the strip's resize
			e.preventDefault();
			try {
				pill.setPointerCapture(e.pointerId);
			} catch {
				// Synthetic events carry no active pointer — capture is moot.
			}
			const sx = e.clientX;
			const sy = e.clientY;
			const up = (ue: PointerEvent): void => {
				pill.removeEventListener("pointerup", up);
				if (Math.hypot(ue.clientX - sx, ue.clientY - sy) <= 8) {
					ran = true;
					run();
				}
			};
			pill.addEventListener("pointerup", up);
		});
	};

	for (let b = 1; b < cols && cells.length > 1; b++) {
		const strip = grid.createDiv({ cls: "mica-col-resizer" });
		strip.createDiv({ cls: "mica-col-resizer-line" });
		strip.setAttribute("aria-label", "Drag: resize · double-click: reset widths · ⊕/right-click: new column");
		plusPill(strip, "New column here", () => ctx.editable?.apply({ op: "insertColumn", path, at: b }));
		strips.push(strip);
		const resetPair = (): void => {
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
		};
		strip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			resetPair();
		});
		strip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle("New column here")
					.setIcon("plus")
					.onClick(() => ctx.editable?.apply({ op: "insertColumn", path, at: b })),
			);
			menu.addItem((i) => i.setTitle("Reset this pair's widths").setIcon("undo-2").onClick(resetPair));
			menu.addItem((i) =>
				i
					.setTitle("Distribute all widths evenly")
					.setIcon("columns-3")
					.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "colw", value: null })),
			);
			menu.showAtMouseEvent(e);
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
				document.body.addClass("mica-handle-dragging"); // one gesture, one visual
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
			const onEsc = (ke: KeyboardEvent): void => {
				if (ke.key !== "Escape") return;
				ke.preventDefault();
				ke.stopPropagation();
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				live(startW);
				layout();
			};
			window.addEventListener("keydown", onEsc, true);
			const up = (e: PointerEvent): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				const moved = Math.abs(e.clientX - startX) >= 5;
				if (e.type !== "pointerup" || !moved) {
					live(startW); // sub-threshold wiggle: snap back, commit nothing
					layout();
					return;
				}
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
		strip.setAttribute("aria-label", "Drag: resize · double-click: reset heights · ⊕/right-click: new row");
		plusPill(strip, "New row here", () => ctx.editable?.apply({ op: "insertRow", path, atRow: r + 1 }));
		rowStrips.push(strip);
		const resetRowPair = (): void => {
			rowHeights[r] = null;
			rowHeights[r + 1] = null;
			ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: rowhValue(rowHeights) });
		};
		strip.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			resetRowPair();
		});
		strip.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			menu.addItem((i) =>
				i
					.setTitle("New row here")
					.setIcon("plus")
					.onClick(() => ctx.editable?.apply({ op: "insertRow", path, atRow: r + 1 })),
			);
			menu.addItem((i) => i.setTitle("Reset this pair's heights").setIcon("undo-2").onClick(resetRowPair));
			menu.addItem((i) =>
				i
					.setTitle("Distribute all heights evenly")
					.setIcon("rows-3")
					.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: null })),
			);
			menu.showAtMouseEvent(e);
		});
		strip.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const startY = down.clientY;
			// The divider moves BETWEEN the pair: the upper row takes what the
			// lower gives (each floors at 40px / its content height).
			const measured = (row: number): number =>
				Math.round(cells[row * cols]?.getBoundingClientRect().height ?? 80);
			const startA = rowHeights[r] ?? measured(r);
			const startB = rowHeights[r + 1] ?? measured(r + 1);
			let lastA: number | null = null;
			let lastB: number | null = null;
			const move = (e: PointerEvent): void => {
				document.body.addClass("mica-handle-dragging");
				const dy = e.clientY - startY;
				lastA = Math.max(40, Math.round(startA + dy));
				lastB = Math.max(40, Math.round(startB - dy));
				const live = [...rowHeights];
				live[r] = lastA;
				live[r + 1] = lastB;
				applyRowTemplate(grid, live);
				layout();
			};
			const onEsc = (ke: KeyboardEvent): void => {
				if (ke.key !== "Escape") return;
				ke.preventDefault();
				ke.stopPropagation();
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				applyRowTemplate(grid, rowHeights);
				layout();
			};
			window.addEventListener("keydown", onEsc, true);
			const up = (e: PointerEvent): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", up, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				const movedRow = Math.abs(e.clientY - startY) >= 5;
				if (e.type !== "pointerup" || lastA === null || !movedRow) {
					applyRowTemplate(grid, rowHeights); // wiggle: snap back
					layout();
					return;
				}
				rowHeights[r] = lastA;
				rowHeights[r + 1] = lastB;
				ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: rowhValue(rowHeights) });
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", up, true);
		});
	}

	// Edge strips: one-click add at the grid's four edges (no resize there,
	// so the whole strip stays clickable alongside its pill).
	const edge = (cls: string, tip: string, run: () => void): void => {
		const strip = grid.createDiv({ cls: `mica-edge-add ${cls}` });
		strip.setAttribute("aria-label", tip);
		strip.createDiv({ cls: "mica-col-resizer-line mica-edge-line" });
		plusPill(strip, tip, run);
		strip.addEventListener("click", (e) => {
			e.stopPropagation();
			run();
		});
	};
	edge("is-left", "New column on the left", () => ctx.editable?.apply({ op: "insertColumn", path, at: 0 }));
	edge("is-right", "New column on the right", () => ctx.editable?.apply({ op: "insertColumn", path, at: cols }));
	edge("is-top", "New row on top", () => ctx.editable?.apply({ op: "insertRow", path, atRow: 0 }));
	edge("is-bottom", "New row at the bottom", () => ctx.editable?.apply({ op: "insertRow", path, atRow: rowCount }));

	layoutHandles = mountGridHandles(grid, ctx, path, cols, rowCount, cells);

	// Track layout: cells resize as content changes; keep dividers glued.
	const ro = new ResizeObserver(() => layout());
	ro.observe(grid);
	// Every edit rebuilds the block into a fresh element; disconnect with the
	// component or each repaint stacks a live observer on a detached grid.
	ctx.component.register(() => ro.disconnect());
	window.requestAnimationFrame(layout);
}

/**
 * Excel-style structure handles: a slim pill at each column's top and each
 * row's left. Click opens the structural menu (insert / move / delete /
 * distribute); dragging ≥5px reorders the whole column/row with a live
 * indicator at the landing boundary; Escape cancels the drag.
 */
function mountGridHandles(
	grid: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	cols: number,
	rowCount: number,
	cells: HTMLElement[],
): () => void {
	const indicator = grid.createDiv({ cls: "mica-handle-indicator" });
	const colHandles: HTMLElement[] = [];
	const rowHandles: HTMLElement[] = [];

	const colMenu = (c: number, e: MouseEvent): void => {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Insert column left")
				.setIcon("between-vertical-end")
				.onClick(() => ctx.editable?.apply({ op: "insertColumn", path, at: c })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Insert column right")
				.setIcon("between-vertical-start")
				.onClick(() => ctx.editable?.apply({ op: "insertColumn", path, at: c + 1 })),
		);
		if (c > 0)
			menu.addItem((i) =>
				i
					.setTitle("Move left")
					.setIcon("arrow-left")
					.onClick(() => ctx.editable?.apply({ op: "moveColumn", path, from: c, to: c - 1 })),
			);
		if (c + 1 < cols)
			menu.addItem((i) =>
				i
					.setTitle("Move right")
					.setIcon("arrow-right")
					.onClick(() => ctx.editable?.apply({ op: "moveColumn", path, from: c, to: c + 1 })),
			);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Distribute widths evenly")
				.setIcon("columns-3")
				.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "colw", value: null })),
		);
		if (cols > 1)
			menu.addItem((i) =>
				i
					.setTitle("Delete column")
					.setIcon("trash-2")
					.onClick(() => deleteWithUndo(ctx, { op: "deleteColumn", path, at: c }, "Column deleted")),
			);
		menu.showAtMouseEvent(e);
	};

	const rowMenu = (r: number, e: MouseEvent): void => {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Insert row above")
				.setIcon("between-horizontal-end")
				.onClick(() => ctx.editable?.apply({ op: "insertRow", path, atRow: r })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Insert row below")
				.setIcon("between-horizontal-start")
				.onClick(() => ctx.editable?.apply({ op: "insertRow", path, atRow: r + 1 })),
		);
		if (r > 0)
			menu.addItem((i) =>
				i
					.setTitle("Move up")
					.setIcon("arrow-up")
					.onClick(() => ctx.editable?.apply({ op: "moveRow", path, from: r, to: r - 1 })),
			);
		if (r + 1 < rowCount)
			menu.addItem((i) =>
				i
					.setTitle("Move down")
					.setIcon("arrow-down")
					.onClick(() => ctx.editable?.apply({ op: "moveRow", path, from: r, to: r + 1 })),
			);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Distribute heights evenly")
				.setIcon("rows-3")
				.onClick(() => ctx.editable?.apply({ op: "setGroupAttr", path, key: "rowh", value: null })),
		);
		menu.addItem((i) =>
			i
				.setTitle("Delete row")
				.setIcon("trash-2")
				.onClick(() => deleteWithUndo(ctx, { op: "deleteRow", path, atRow: r }, "Row deleted")),
		);
		menu.showAtMouseEvent(e);
	};

	// The cells of column c / row r — tinted while their handle drags so the
	// user sees WHAT is moving, not just where it lands.
	const memberCells = (axis: "x" | "y", idx: number): HTMLElement[] =>
		cells.filter((_, i) => (axis === "x" ? i % cols === idx : Math.floor(i / cols) === idx));

	/** Wire one handle: click = menu, drag ≥5px = reorder with indicator. */
	const wire = (
		handle: HTMLElement,
		from: number,
		count: number,
		axis: "x" | "y",
		menuAt: (e: MouseEvent) => void,
		commit: (to: number) => void,
		indicate: (boundary: number) => void,
	): void => {
		handle.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			menuAt(e);
		});
		handle.addEventListener("pointerdown", (down) => {
			if (down.button !== 0) return;
			down.preventDefault();
			down.stopPropagation();
			const start = axis === "x" ? down.clientX : down.clientY;
			const movers = memberCells(axis, from);
			let target = from;
			let dragging = false;
			const boundaries = (): number[] => {
				// Boundary k = leading edge of slot k (slot `count` = trailing edge).
				const out: number[] = [];
				for (let k = 0; k < count; k++) {
					const el = axis === "x" ? cells[k] : cells[k * cols];
					const rect = el?.getBoundingClientRect();
					out.push(rect ? (axis === "x" ? rect.left : rect.top) : Number.POSITIVE_INFINITY);
				}
				const lastEl = axis === "x" ? cells[count - 1] : cells[(count - 1) * cols];
				const lastRect = lastEl?.getBoundingClientRect();
				out.push(lastRect ? (axis === "x" ? lastRect.right : lastRect.bottom) : Number.POSITIVE_INFINITY);
				return out;
			};
			const move = (e: PointerEvent): void => {
				const pos = axis === "x" ? e.clientX : e.clientY;
				if (!dragging && Math.abs(pos - start) < 5) return;
				dragging = true;
				document.body.addClass("mica-handle-dragging");
				handle.addClass("is-dragging");
				movers.forEach((m) => m.addClass("mica-move-source"));
				const bs = boundaries();
				// The slot whose span holds the pointer (clamped to the lattice).
				let t = count - 1;
				for (let k = 0; k < count; k++) {
					if (pos < bs[k + 1]) {
						t = k;
						break;
					}
				}
				target = t;
				indicate(t > from ? t + 1 : t);
			};
			const finish = (): void => {
				window.removeEventListener("pointermove", move, true);
				window.removeEventListener("pointerup", up, true);
				window.removeEventListener("pointercancel", cancel, true);
				window.removeEventListener("keydown", onEsc, true);
				document.body.removeClass("mica-handle-dragging");
				handle.removeClass("is-dragging");
				movers.forEach((m) => m.removeClass("mica-move-source"));
				indicator.style.display = "none";
			};
			const onEsc = (ke: KeyboardEvent): void => {
				if (ke.key !== "Escape") return;
				ke.preventDefault();
				ke.stopPropagation();
				finish();
			};
			const cancel = (): void => finish();
			const up = (e: PointerEvent): void => {
				const wasDragging = dragging;
				finish();
				if (!wasDragging) {
					menuAt(e); // a plain click: the structural menu
					return;
				}
				if (target !== from) commit(target);
			};
			window.addEventListener("pointermove", move, true);
			window.addEventListener("pointerup", up, true);
			window.addEventListener("pointercancel", cancel, true);
			window.addEventListener("keydown", onEsc, true);
		});
	};

	const g = (): DOMRect => grid.getBoundingClientRect();
	for (let c = 0; c < cols; c++) {
		const handle = grid.createEl("button", {
			cls: "clickable-icon mica-col-handle",
			attr: { type: "button", "aria-label": "Column: drag to move · click for menu" },
		});
		setIcon(handle, "grip-horizontal");
		handle.setAttribute("data-col", String(c));
		colHandles.push(handle);
		wire(
			handle,
			c,
			cols,
			"x",
			(e) => colMenu(c, e),
			(to) => ctx.editable?.apply({ op: "moveColumn", path, from: c, to }),
			(b) => {
				const rect = g();
				const edgeEl = b < cols ? cells[b] : cells[cols - 1];
				const er = edgeEl?.getBoundingClientRect();
				if (!er) return;
				const x = (b < cols ? er.left : er.right) - rect.left;
				indicator.style.display = "block";
				indicator.style.left = `${x - 1.5}px`;
				indicator.style.top = "4px";
				indicator.style.width = "3px";
				indicator.style.height = `${rect.height - 8}px`;
			},
		);
	}
	for (let r = 0; r < rowCount; r++) {
		const handle = grid.createEl("button", {
			cls: "clickable-icon mica-row-handle",
			attr: { type: "button", "aria-label": "Row: drag to move · click for menu" },
		});
		setIcon(handle, "grip-vertical");
		handle.setAttribute("data-row", String(r));
		rowHandles.push(handle);
		wire(
			handle,
			r,
			rowCount,
			"y",
			(e) => rowMenu(r, e),
			(to) => ctx.editable?.apply({ op: "moveRow", path, from: r, to }),
			(b) => {
				const rect = g();
				const edgeEl = b < rowCount ? cells[b * cols] : cells[(rowCount - 1) * cols];
				const er = edgeEl?.getBoundingClientRect();
				if (!er) return;
				const y = (b < rowCount ? er.top : er.bottom) - rect.top;
				indicator.style.display = "block";
				indicator.style.top = `${y - 1.5}px`;
				indicator.style.left = "4px";
				indicator.style.height = "3px";
				indicator.style.width = `${rect.width - 8}px`;
			},
		);
	}

	// Handles ride the same layout pass as the boundary strips.
	return (): void => {
		const rect = grid.getBoundingClientRect();
		for (let c = 0; c < cols; c++) {
			const h = colHandles[c];
			const r0 = cells[c]?.getBoundingClientRect();
			if (!r0) {
				h.style.display = "none";
				continue;
			}
			h.style.display = "";
			h.style.left = `${r0.left - rect.left + r0.width / 2}px`;
			h.style.top = `${r0.top - rect.top - 2}px`;
		}
		for (let r = 0; r < rowCount; r++) {
			const h = rowHandles[r];
			const r0 = cells[r * cols]?.getBoundingClientRect();
			if (!r0) {
				h.style.display = "none";
				continue;
			}
			h.style.display = "";
			h.style.top = `${r0.top - rect.top + r0.height / 2}px`;
			h.style.left = `${r0.left - rect.left - 2}px`;
		}
	};
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
			text: serializeCst({ children: [node] }),
			copy: {
				kind: "grid",
				label: "Copy grid contents",
				notice: "Grid copied.",
				path,
				target: { nodes: [node] },
			},
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
	// never clip content (minmax(Xpx, auto)). NEVER emit more tracks than
	// actual rows — a stale longer list (e.g. after a column-count change)
	// would lay out phantom explicit tracks as dead space below the grid.
	const rowCount = Math.max(1, Math.ceil(node.children.length / cols));
	const rowHeights: (number | null)[] = (titleAttr(node.title, "rowh") ?? "")
		.split(",")
		.map((t) => {
			const n = Number(t);
			return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
		})
		.slice(0, rowCount);
	applyRowTemplate(grid, rowHeights);

	node.children.forEach((c, idx) => {
		if (c.kind !== "container" || c.name !== "cell") return;
		const cellPath = [...path, idx];
		const cell = grid.createDiv({ cls: "mica-cell" });
		cell.setAttribute("data-mica-idx", String(idx));
		cell.setAttribute("data-mica-node", cellPath.join("."));
		markGroupContainer(cell, cellPath, c.children.length);
		renderNodes(c.children, cell, ctx, cellPath, { autoOpen: takeRegionReveal(ctx, cellPath) });
		const bar = cell.createDiv({ cls: "mica-cell-bar" });
		if (ctx.editable) {
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
			// Clear, not delete: removing a cell from flow shifts every later
			// cell across columns — geometry changes belong to the row/column
			// handles. An empty cell keeps the lattice true.
			iconButton(bar, "mica-cell-tool", "eraser", "Clear cell").addEventListener("click", (e) => {
				e.stopPropagation();
				deleteWithUndo(ctx, { op: "clearCell", path, index: idx }, "Cell cleared");
			});
		}
		copyButton(bar, ctx, "mica-cell-tool", {
			kind: "cell",
			label: `Copy cell ${idx + 1} contents`,
			notice: "Cell copied.",
			path: cellPath,
			target: { nodes: [c] },
		});
	});

	const tools = wrap.createDiv({ cls: "mica-grid-tools" });
	copyButton(tools, ctx, "mica-minitool", {
		kind: "grid",
		label: "Copy grid contents",
		notice: "Grid copied.",
		path,
		target: { nodes: [node] },
	});
	if (ctx.editable) {
		iconButton(tools, "mica-minitool", "chevrons-down-up", "Fold this grid").addEventListener("click", (e) => {
			e.stopPropagation();
			toggleFold(ctx, gkey);
		});
		const topGrip = iconButton(tools, "mica-region-grip", "grip-vertical", "Drag to move this grid");
		topGrip.addEventListener("click", (e) => e.stopPropagation());
		makeDraggable(
			topGrip,
			{ kind: "group", fromPath: path, text: serializeCst({ children: [node] }) },
			path,
			(op) => ctx.editable?.apply(op),
			wrap,
		);
		iconButton(tools, "mica-minitool mica-region-x", "x", "Delete grid").addEventListener("click", (e) => {
			e.stopPropagation();
			deleteWithUndo(ctx, { op: "deleteNode", path }, "Grid deleted");
		});

		// Grid resizers: dividers between columns (fr shares) and rows (min px).
		mountGridResizers(grid, ctx, path, cols, widths, rowHeights);

		// Ghost tile: only when the grid is EMPTY or its last row is ragged —
		// full rectangular grids grow via the boundary/edge strips instead.
		if (node.children.length === 0 || node.children.length % cols !== 0) {
			const ghost = grid.createEl("button", {
				cls: "clickable-icon mica-cell-ghost",
				attr: { type: "button", "aria-label": "Add a cell (choose its content)" },
			});
			setIcon(ghost.createSpan(), "plus");
			ghost.addEventListener("click", (e) => {
				showCellTypeMenu(ctx, path, node.children.length, e);
			});
		}

		const bar = wrap.createDiv({ cls: "mica-grid-actions" });
		const colStep = (delta: number, icon: string, label: string): void => {
			iconButton(bar, "mica-minitool mica-col-step", icon, label).addEventListener("click", (e) => {
				e.stopPropagation();
				const next = Math.max(1, Math.min(24, cols + delta));
				if (next !== cols) ctx.editable?.apply({ op: "setCols", path, cols: next });
			});
		};
		colStep(-1, "minus", "One column fewer");
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
		colStep(1, "plus", "One more column");
		bar.createDiv({ cls: "mica-nav-spacer" });
	}
}

/** Destructive ops don't nag with confirms — they offer a one-click Undo. */
function deleteWithUndo(ctx: RenderCtx, op: StructOp, what: string): void {
	const before = ctx.preImage?.();
	if (!before || !ctx.editable || !ctx.editable.apply(op)) return;
	// Capture the immediate post-delete body once. Undo is accepted only while
	// that exact pre-image is still live; later edits must never be overwritten.
	const after = ctx.preImage?.();
	if (after === undefined) return;
	const frag = document.createDocumentFragment();
	frag.appendChild(document.createTextNode(`${what}. `));
	const undo = document.createElement("button");
	undo.textContent = "Undo";
	undo.className = "mica-undo-btn";
	const notice = new Notice(frag, 8000);
	undo.addEventListener("click", () => {
		if (ctx.editable?.replaceAll(after, before)) notice.hide();
		else new Notice("Mica: Undo could not be applied because the block changed again.");
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
		save.addEventListener("click", () => void saveVersionNow(p, chip.file));
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
				.onClick(() => void saveVersionNow(p, chip.file)),
		);
		menu.showAtMouseEvent(e);
	});

	const refresh = async (): Promise<void> => {
		try {
			const state = (await p.engine.state(chip.file))[chip.blockId];
			const n = state?.versions.length ?? 0;
			const sig = contentSignature(chip.content);
			let dirty: boolean;
			let missingObject = false;
			if (state?.head) {
				const head = await readObject(p.app.vault, chip.file, state.head);
				missingObject = head === null;
				dirty = missingObject || contentSignature(head ?? "") !== sig;
			} else {
				dirty = sig !== contentSignature("");
			}
			count.setText(String(n));
			btn.setAttr(
				"aria-label",
				`Version history — ${n} version${n === 1 ? "" : "s"}${
					missingObject ? ", head object missing" : dirty ? ", unsaved changes" : ""
				}. Right-click for auto-save options.`,
			);
			btn.toggleClass("is-dirty", dirty);
		} catch {
			count.setText("?");
			btn.setAttr("aria-label", "Version history unavailable — a history object may be missing or corrupt.");
			btn.addClass("is-dirty");
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

async function saveVersionNow(plugin: MicaPlugin, file: TFile): Promise<void> {
	try {
		await plugin.engine.snapshot(file, true);
		new Notice("Mica: version saved.");
	} catch (error) {
		new Notice(`Mica: save version failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

// ---------------------------------------------------------------------------

function renderMarkdown(md: string, el: HTMLElement, ctx: RenderCtx): void {
	if (!md.trim()) return;
	void MarkdownRenderer.render(ctx.app, md, el.createDiv({ cls: "mica-md-inner" }), ctx.sourcePath, ctx.component);
}
