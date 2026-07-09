import { App, Component, MarkdownRenderer, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { contentSignature, type Cst, type MicaNode } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import type { Reveal, StructOp } from "../cst/ops";
import { DiffModal } from "../diff/diffModal";

/** The single hook a rendered block uses to mutate itself (Live Preview only). */
export interface EditHooks {
	apply: (op: StructOp) => void;
}

/** Everything the footer needs to show version state and toggle auto-save. */
export interface ChipInfo {
	plugin: MicaPlugin;
	file: TFile;
	blockId: string;
	content: string;
}

/**
 * UI state that must survive the widget being rebuilt after every edit: which
 * tab is active in each group, and a one-shot focus target set right before a
 * structural op re-renders the block.
 */
export interface BlockUi {
	active: Map<string, number>;
	reveal: Reveal | null;
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
}

type Container = Extract<MicaNode, { kind: "container" }>;
type Leaf = Extract<MicaNode, { kind: "leaf" }>;

/** A square icon button (Lucide via setIcon) with an accessible label. */
function iconButton(parent: HTMLElement, cls: string, icon: string, label: string): HTMLButtonElement {
	// aria-label alone drives Obsidian's own tooltip (portal-mounted, escapes the
	// nav's overflow clip). Adding `title` would stack a second, janky native
	// tooltip on top — so we deliberately don't set it.
	const b = parent.createEl("button", { cls, attr: { type: "button", "aria-label": label } });
	setIcon(b, icon);
	return b;
}

const pathKey = (path: number[]): string => path.join(",");
const samePath = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const prefixOf = (parent: number[], child: number[]): boolean =>
	child.length === parent.length + 1 && parent.every((x, i) => x === child[i]);

/** Consume a one-shot region-edit reveal if it targets `path`. */
function takeRegionReveal(ctx: RenderCtx, path: number[]): boolean {
	const r = ctx.ui?.reveal;
	if (r && r.kind === "region-edit" && samePath(r.path, path)) {
		ctx.ui!.reveal = null;
		return true;
	}
	return false;
}

/** Render a parsed block into `el`. Shared by reading view and Live Preview. */
export function renderCst(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.addClass("mica");
	const autoOpen = takeRegionReveal(ctx, []);
	// Only offer a block-root "+ insert a group" when the block has no group yet
	// (to bootstrap an empty block). Once a tabs/grid exists, adding tabs happens
	// in the nav and nesting happens inside a tab — so there's no confusing second
	// insert below the group.
	const rootInsert = !cst.children.some((c) => c.kind === "container");
	renderNodes(cst.children, el, ctx, [], { insert: rootInsert, autoOpen });
	if (ctx.chip) renderFooter(el, ctx, ctx.chip);
}

// ---------------------------------------------------------------------------
// Content regions (inline click-to-edit; never shows structural directives)
// ---------------------------------------------------------------------------

interface NodesOpts {
	insert?: boolean;
	autoOpen?: boolean;
}

function renderNodes(nodes: MicaNode[], el: HTMLElement, ctx: RenderCtx, path: number[], opts: NodesOpts = {}): void {
	let i = 0;
	let opened = false;
	while (i < nodes.length) {
		if (nodes[i].kind === "leaf") {
			let j = i;
			let md = "";
			while (j < nodes.length && nodes[j].kind === "leaf") {
				md += (nodes[j] as Leaf).text;
				j++;
			}
			const auto: boolean = Boolean(opts.autoOpen) && !opened;
			renderRegion(el, ctx, path, i, j, md, auto);
			opened = opened || auto;
			i = j;
		} else {
			renderContainer(nodes[i] as Container, el, ctx, [...path, i]);
			i++;
		}
	}
	// Only a TRULY empty container gets a "click to write" ghost. A container
	// whose children are all nested groups (e.g. the block root holding one tabs
	// group) is NOT empty and must not sprout a stray write box below the group.
	if (ctx.editable && nodes.length === 0) {
		renderRegion(el, ctx, path, 0, 0, "", Boolean(opts.autoOpen) && !opened);
	}
	if (ctx.editable && opts.insert) renderInsert(el, ctx, path, nodes.length);
}

const INTERACTIVE = "a, button, input, textarea, .internal-link";

// --- Drag and drop --------------------------------------------------------
// One drag at a time, so a module-level payload is enough (dataTransfer can't
// be read during dragover). Carries the dragged node's absolute path + kind.
interface DragState {
	from: number[];
	kind: "tab" | "cell";
}
let micaDrag: DragState | null = null;

/** Make `el` a drag source that carries the node at `fromPath`. */
function makeDraggable(el: HTMLElement, fromPath: number[], kind: "tab" | "cell"): void {
	el.setAttribute("draggable", "true");
	el.addEventListener("dragstart", (e) => {
		micaDrag = { from: fromPath, kind };
		el.addClass("mica-dragging");
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", "mica"); // some engines need data to start a drag
		}
		e.stopPropagation();
	});
	el.addEventListener("dragend", () => {
		micaDrag = null;
		el.removeClass("mica-dragging");
	});
}

const DROP_SIDES = ["mica-drop-before", "mica-drop-after", "mica-drop-above", "mica-drop-below"] as const;

/**
 * Make `el` accept a dragged node of `kind`, dropping it into `parentPath` at
 * `selfIndex`. Cells and tabs are both a single ordered list under the hood, so
 * a drop is always an *insert-between* (reorder), never a swap — the grid just
 * reflows the list into its columns afterward.
 *
 * Tabs are a 1-D horizontal strip, so only left/right (before/after) is
 * meaningful. Cells wrap into rows, so we pick whichever axis the pointer is
 * most decisively on and show the drop-line on that edge: aim at a cell's left
 * or top to land *before* it, its right or bottom to land *after* it. That's
 * what makes "drag a cell up" work — you aim at the destination cell in the row
 * above, and the line snaps to the edge you're pointing at.
 */
function makeDropTarget(
	el: HTMLElement,
	ctx: RenderCtx,
	kind: "tab" | "cell",
	parentPath: number[],
	selfIndex: number,
): void {
	const clear = (): void => DROP_SIDES.forEach((c) => el.removeClass(c));
	el.addEventListener("dragover", (e) => {
		if (!micaDrag || micaDrag.kind !== kind) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
		const r = el.getBoundingClientRect();
		clear();
		if (kind === "tab") {
			el.addClass(e.clientX > r.left + r.width / 2 ? "mica-drop-after" : "mica-drop-before");
			return;
		}
		// Cell: dominant-axis. Normalize the pointer offset from the cell centre so
		// a wide-but-short cell doesn't bias everything horizontal.
		const dx = (e.clientX - (r.left + r.width / 2)) / (r.width || 1);
		const dy = (e.clientY - (r.top + r.height / 2)) / (r.height || 1);
		if (Math.abs(dx) >= Math.abs(dy)) el.addClass(dx > 0 ? "mica-drop-after" : "mica-drop-before");
		else el.addClass(dy > 0 ? "mica-drop-below" : "mica-drop-above");
	});
	el.addEventListener("dragleave", clear);
	el.addEventListener("drop", (e) => {
		if (!micaDrag || micaDrag.kind !== kind) return;
		e.preventDefault();
		e.stopPropagation();
		// "after"/"below" in reading order → insert one slot later.
		const after = el.hasClass("mica-drop-after") || el.hasClass("mica-drop-below");
		const toIndex = after ? selfIndex + 1 : selfIndex;
		const from = micaDrag.from;
		clear();
		micaDrag = null;
		ctx.editable?.apply({ op: "moveNode", from, toParent: parentPath, toIndex });
	});
}

function renderRegion(
	el: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	start: number,
	end: number,
	md: string,
	autoOpen: boolean,
): void {
	const region = el.createDiv({ cls: "mica-region" });
	paintRegionView(region, ctx, md);
	// Attach the open-on-click handlers ONCE (not in paintRegionView, which reruns
	// on cancel) and keep the events off CodeMirror — a click reaching CM would
	// move the caret into the block and flip Live Preview to raw source.
	if (ctx.editable) {
		const guard = (e: Event): boolean => !(e.target as HTMLElement).closest(INTERACTIVE);
		region.addEventListener("mousedown", (e) => {
			if (guard(e)) e.stopPropagation();
		});
		region.addEventListener("click", (e) => {
			if (!guard(e)) return;
			e.preventDefault();
			e.stopPropagation();
			openRegionEditor(region, ctx, path, start, end, md);
		});
	}
	if (autoOpen) queueMicrotask(() => openRegionEditor(region, ctx, path, start, end, md));
}

function paintRegionView(region: HTMLElement, ctx: RenderCtx, md: string): void {
	region.empty();
	region.removeClass("is-editing");
	region.toggleClass("is-editable", Boolean(ctx.editable));
	const view = region.createDiv({ cls: "mica-md" });
	if (md.trim()) {
		renderMarkdown(md, view, ctx);
	} else if (ctx.editable) {
		const ghost = view.createDiv({ cls: "mica-ghost" });
		setIcon(ghost.createSpan({ cls: "mica-ghost-icon" }), "pencil-line");
		ghost.createSpan({ cls: "mica-ghost-label", text: "Click to write…" });
	}
	// Clicking anywhere in the region opens the editor (wired once in
	// renderRegion) — no separate pencil affordance.
}

function openRegionEditor(
	region: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	start: number,
	end: number,
	original: string,
): void {
	if (region.hasClass("is-editing")) return;
	region.empty();
	region.removeClass("is-editable");
	region.addClass("is-editing");
	const ta = region.createEl("textarea", { cls: "mica-edit-area" });
	ta.value = original;
	ta.addEventListener("mousedown", (e) => e.stopPropagation()); // keep clicks off CM
	const fit = (): void => {
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight + 2}px`;
	};
	if (ctx.editorAutosize ?? true) ta.addEventListener("input", fit);
	const restore = (): void => paintRegionView(region, ctx, original);
	const commit = (explicit: boolean): void => {
		const val = ta.value;
		if (val === original) return restore();
		// Poka-yoke: a click-away (not an explicit save) never wipes existing prose.
		if (!explicit && val.trim() === "" && original.trim() !== "") return restore();
		ctx.editable?.apply({ op: "saveRegion", path, start, end, expected: original, text: val });
	};
	ta.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
			e.preventDefault();
			commit(true);
		} else if (e.key === "Escape") {
			e.preventDefault();
			restore();
		}
	});
	ta.addEventListener("blur", () => commit(false));
	const bar = region.createDiv({ cls: "mica-region-actions" });
	// mousedown + preventDefault so the button acts before the textarea blur fires.
	bar.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } }).addEventListener(
		"mousedown",
		(e) => {
			e.preventDefault();
			commit(true);
		},
	);
	bar.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("mousedown", (e) => {
		e.preventDefault();
		restore();
	});
	fit();
	ta.focus();
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
	// The nav-outer holds both the scrollable chips area and the sticky controls so
	// that + / spacer / × never scroll off-screen when there are many tabs.
	const navOuter = wrap.createDiv({ cls: "mica-tab-nav-outer" });
	const nav = navOuter.createDiv({ cls: "mica-tab-nav", attr: { role: "tablist" } });
	const panels = wrap.createDiv({ cls: "mica-tab-panels" });
	const tabs = node.children
		.map((c, idx) => ({ c, idx }))
		.filter((x) => x.c.kind === "container" && x.c.name === "tab");

	// A tab-edit reveal (from having just inserted a tab) wins over remembered state.
	let revealTab = -1;
	const r = ctx.ui?.reveal;
	if (r && r.kind === "tab-edit" && prefixOf(path, r.path)) {
		revealTab = r.path[r.path.length - 1];
		ctx.ui!.reveal = null;
	}
	const pk = pathKey(path);
	let active = revealTab >= 0 ? revealTab : (ctx.ui?.active.get(pk) ?? 0);
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
		const chip = nav.createDiv({ cls: "mica-tab-chip" });
		const btn = chip.createEl("button", {
			cls: "mica-tab-btn",
			text: tab.title || `Tab ${k + 1}`,
			attr: { type: "button", role: "tab" },
		});
		btn.addEventListener("click", () => activate(k));
		if (ctx.editable) {
			chip.addClass("mica-chip-editable"); // reserves button right-padding for the ×
			btn.addEventListener("dblclick", (e) => {
				e.preventDefault();
				startRename(chip, btn, ctx, path, x.idx, tab.title);
			});
			iconButton(chip, "mica-chip-x", "x", "Delete tab").addEventListener("click", (e) => {
				e.stopPropagation();
				ctx.editable?.apply({ op: "deleteTab", path, index: x.idx });
			});
			makeDraggable(chip, [...path, x.idx], "tab"); // drag to reorder / move between groups
			makeDropTarget(chip, ctx, "tab", path, x.idx);
		}
		const panel = panels.createDiv({ cls: "mica-tab-panel", attr: { role: "tabpanel" } });
		renderTabBody(tab, panel, ctx, [...path, x.idx], revealTab === k);
		btns.push(btn);
		panelEls.push(panel);
	});

	if (ctx.editable) {
		// The "+" sits right after the last tab (inside the scrollable row), so it is
		// always next to the rightmost tab; when tabs overflow it scrolls with them.
		iconButton(nav, "mica-add mica-tab-add", "plus", "Add a tab").addEventListener("click", () =>
			ctx.editable?.apply({ op: "insertTab", path, at: node.children.length }),
		);
		// The group-delete × stays sticky so it's reachable no matter how many tabs.
		const sticky = navOuter.createDiv({ cls: "mica-tab-nav-sticky" });
		mkGroupDelete(sticky, ctx, node, path, "tab group");
	}

	nav.addEventListener("keydown", (ev: KeyboardEvent) => {
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

function startRename(
	chip: HTMLElement,
	btn: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	index: number,
	title: string,
): void {
	btn.style.display = "none";
	const input = chip.createEl("input", { cls: "mica-rename", attr: { type: "text" } });
	input.value = title;
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

function renderTabBody(tab: Container, panel: HTMLElement, ctx: RenderCtx, tabPath: number[], autoOpen: boolean): void {
	const body = panel.createDiv({ cls: "mica-tab-body" });
	renderNodes(tab.children, body, ctx, tabPath, { insert: true, autoOpen });
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-grid-wrap" });
	const grid = wrap.createDiv({ cls: "mica-grid" });
	const cols = Number(parseAttr(node.title, "cols") ?? "2") || 2;
	grid.style.setProperty("--mica-cols", String(cols));
	node.children.forEach((c, idx) => {
		if (c.kind !== "container" || c.name !== "cell") return;
		const cellPath = [...path, idx];
		const cell = grid.createDiv({ cls: "mica-cell" });
		renderNodes(c.children, cell, ctx, cellPath, { autoOpen: takeRegionReveal(ctx, cellPath) });
		if (ctx.editable) {
			// Drag handle keeps dragging from fighting click-to-edit; the cell is the
			// drop target (reorder within, or move across, grids).
			const drag = iconButton(cell, "mica-cell-drag", "grip-vertical", "Drag to move this cell");
			makeDraggable(drag, cellPath, "cell");
			makeDropTarget(cell, ctx, "cell", path, idx);
			iconButton(cell, "mica-cell-x", "x", "Delete cell").addEventListener("click", (e) => {
				e.stopPropagation();
				ctx.editable?.apply({ op: "deleteCell", path, index: idx });
			});
		}
	});
	if (ctx.editable) {
		const bar = wrap.createDiv({ cls: "mica-grid-actions" });
		stepper(bar, "Columns", cols, (n) => ctx.editable?.apply({ op: "setCols", path, cols: n }));
		bar.createEl("button", {
			cls: "mica-add",
			text: "+ Cell",
			attr: { type: "button", "aria-label": "Add a cell" },
		}).addEventListener("click", () => ctx.editable?.apply({ op: "insertCell", path, at: node.children.length }));
		bar.createDiv({ cls: "mica-nav-spacer" });
		mkGroupDelete(bar, ctx, node, path, "grid");
	}
}

function stepper(bar: HTMLElement, label: string, value: number, onChange: (n: number) => void): void {
	const s = bar.createDiv({ cls: "mica-stepper" });
	s.createEl("span", { cls: "mica-stepper-label", text: label });
	iconButton(s, "mica-step", "minus", "Fewer columns").addEventListener("click", () =>
		onChange(Math.max(1, value - 1)),
	);
	// The number is clickable — type a value directly instead of only ± .
	const val = s.createEl("button", {
		cls: "mica-stepper-val",
		text: String(value),
		attr: { type: "button", "aria-label": "Click to type a value" },
	});
	val.addEventListener("click", () => {
		const input = s.createEl("input", { cls: "mica-stepper-input", attr: { type: "number", min: "1", max: "24" } });
		s.insertBefore(input, val);
		val.style.display = "none";
		input.value = String(value);
		input.focus();
		input.select();
		let done = false;
		const commit = (): void => {
			if (done) return;
			done = true;
			onChange(Math.max(1, Number(input.value) || value));
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				done = true;
				input.remove();
				val.style.display = "";
			}
		});
		input.addEventListener("blur", commit);
	});
	iconButton(s, "mica-step", "plus", "More columns").addEventListener("click", () => onChange(value + 1));
}

/** True if any descendant leaf carries non-empty prose. */
function nodeHasContent(node: MicaNode): boolean {
	if (node.kind === "leaf") return node.text.trim().length > 0;
	return node.children.some(nodeHasContent);
}

/** A hover-revealed "×" that deletes a whole group; confirms first if non-empty. */
function mkGroupDelete(host: HTMLElement, ctx: RenderCtx, node: Container, path: number[], label: string): void {
	iconButton(host, "mica-group-x", "trash-2", `Delete ${label}`).addEventListener("click", (e) => {
		e.stopPropagation();
		if (nodeHasContent(node) && !window.confirm(`Delete this ${label} and everything in it?`)) return;
		ctx.editable?.apply({ op: "deleteNode", path });
	});
}

/** A quiet, contextual "+" that reveals "Tabs / Grid" — inserts a group here. */
function renderInsert(el: HTMLElement, ctx: RenderCtx, path: number[], at: number): void {
	const bar = el.createDiv({ cls: "mica-insert" });
	const toggle = iconButton(bar, "mica-insert-toggle", "plus", "Insert a tab group or grid here");
	const menu = bar.createDiv({ cls: "mica-insert-menu" });
	menu.createEl("button", {
		cls: "mica-insert-btn",
		text: "Tabs",
		attr: { type: "button", "aria-label": "Insert a tab group here" },
	}).addEventListener("click", () => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "tabs" }));
	menu.createEl("button", {
		cls: "mica-insert-btn",
		text: "Grid",
		attr: { type: "button", "aria-label": "Insert a grid here" },
	}).addEventListener("click", () => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "grid" }));
	toggle.addEventListener("click", () => bar.toggleClass("is-open", !bar.hasClass("is-open")));
}

// ---------------------------------------------------------------------------
// Footer: auto-save toggle + version chip
// ---------------------------------------------------------------------------

function renderFooter(root: HTMLElement, ctx: RenderCtx, chip: ChipInfo): void {
	const bar = root.createDiv({ cls: "mica-footer" });
	const paint = (): void => {
		bar.empty();
		buildFooter(bar, ctx, chip, paint);
	};
	paint();
}

const secs = (plugin: MicaPlugin): number => Math.round(plugin.settings.snapshotDebounceMs / 1000);

function buildFooter(bar: HTMLElement, ctx: RenderCtx, chip: ChipInfo, repaint: () => void): void {
	const p = chip.plugin;
	const on = p.settings.autoSnapshotEnabled;

	const pill = bar.createEl("button", {
		cls: `mica-auto ${on ? "is-on" : "is-off"}`,
		text: on ? "Auto" : "Manual", // the state color is a CSS dot (::before), not an emoji
		attr: {
			type: "button",
			"aria-label": on ? "Auto-save is on. Click for manual." : "Manual. Click to auto-save.",
		},
	});
	pill.addEventListener("click", async () => {
		p.settings.autoSnapshotEnabled = !on;
		p.engine.resetDebouncers();
		await p.saveSettings();
		repaint();
	});

	if (on) {
		const iv = bar.createEl("button", {
			cls: "mica-auto-secs",
			text: `${secs(p)}s`,
			attr: { type: "button", "aria-label": "Change interval" },
		});
		iv.addEventListener("click", () => editInterval(bar, iv, p, repaint));
	} else {
		bar.createEl("button", {
			cls: "mica-save-now",
			text: "Save version",
			attr: { type: "button", "aria-label": "Snapshot the current content now" },
		}).addEventListener("click", () => {
			void p.engine.snapshot(chip.file, true);
			new Notice("Mica: version saved.");
		});
	}

	bar.createDiv({ cls: "mica-footer-spacer" });
	if (p.settings.showVersionChip) renderVersionChip(bar, ctx, chip);
}

function editInterval(bar: HTMLElement, iv: HTMLElement, plugin: MicaPlugin, repaint: () => void): void {
	const input = bar.createEl("input", { cls: "mica-auto-input", attr: { type: "number", min: "1", max: "60" } });
	// Show the input WHERE the interval chip is, not at the far end of the bar.
	iv.insertAdjacentElement("afterend", input);
	iv.style.display = "none";
	input.value = String(secs(plugin));
	input.focus();
	input.select();
	let done = false;
	const commit = async (): Promise<void> => {
		if (done) return;
		done = true;
		const v = Math.min(60, Math.max(1, Number(input.value) || secs(plugin)));
		plugin.settings.snapshotDebounceMs = v * 1000;
		plugin.engine.resetDebouncers();
		await plugin.saveSettings();
		repaint();
	};
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void commit();
		} else if (e.key === "Escape") {
			done = true;
			input.remove();
			iv.style.display = "";
		}
	});
	input.addEventListener("blur", () => void commit());
}

function renderVersionChip(bar: HTMLElement, ctx: RenderCtx, chip: ChipInfo): void {
	const btn = bar.createEl("button", { cls: "mica-chip", attr: { type: "button", "aria-label": "Version history" } });
	setIcon(btn.createSpan({ cls: "mica-chip-icon" }), "history");
	const count = btn.createSpan({ cls: "mica-chip-count", text: "…" });
	btn.createSpan({ cls: "mica-chip-dot" }); // dirty indicator (shown via .is-dirty)
	btn.addEventListener("click", () => new DiffModal(chip.plugin, chip.file, chip.blockId).open());
	const refresh = async (): Promise<void> => {
		try {
			const state = (await chip.plugin.engine.state(chip.file))[chip.blockId];
			const n = state?.versions.length ?? 0;
			const sig = contentSignature(chip.content);
			let dirty: boolean;
			if (state?.head) {
				const head = await readObject(chip.plugin.app.vault, chip.file, state.head);
				dirty = head === null ? true : contentSignature(head) !== sig;
			} else {
				dirty = sig !== contentSignature("");
			}
			count.setText(String(n));
			btn.setAttr(
				"aria-label",
				`Version history — ${n} version${n === 1 ? "" : "s"}${dirty ? ", unsaved changes" : ""}`,
			);
			btn.toggleClass("is-dirty", dirty);
		} catch {
			count.setText("?");
		}
	};
	void refresh();
	// Refresh when this file is snapshotted (so the dirty dot clears) and give the
	// chip a brief pulse to confirm a version just landed.
	ctx.component.register(
		chip.plugin.engine.onSnapshot((f) => {
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

function parseAttr(title: string, key: string): string | null {
	const m = title.match(new RegExp(`\\b${key}=([^\\s}]+)`));
	return m ? m[1] : null;
}
