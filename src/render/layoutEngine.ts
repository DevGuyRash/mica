import { App, Component, MarkdownRenderer, Notice, TFile } from "obsidian";
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
	renderNodes(cst.children, el, ctx, [], { insert: true, autoOpen });
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
	let anyRegion = false;
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
			anyRegion = true;
			i = j;
		} else {
			renderContainer(nodes[i] as Container, el, ctx, [...path, i]);
			i++;
		}
	}
	// A ghost region so an empty or all-structure container still has somewhere
	// to write prose.
	if (ctx.editable && !anyRegion) {
		renderRegion(el, ctx, path, nodes.length, nodes.length, "", Boolean(opts.autoOpen) && !opened);
	}
	if (ctx.editable && opts.insert) renderInsert(el, ctx, path, nodes.length);
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
	paintRegionView(region, ctx, path, start, end, md);
	if (autoOpen) queueMicrotask(() => openRegionEditor(region, ctx, path, start, end, md));
}

function paintRegionView(
	region: HTMLElement,
	ctx: RenderCtx,
	path: number[],
	start: number,
	end: number,
	md: string,
): void {
	region.empty();
	region.removeClass("is-editing");
	region.toggleClass("is-editable", Boolean(ctx.editable));
	const view = region.createDiv({ cls: "mica-md" });
	if (md.trim()) {
		renderMarkdown(md, view, ctx);
	} else if (ctx.editable) {
		view.createDiv({ cls: "mica-ghost", text: "Click to write…" });
	}
	if (!ctx.editable) return;
	region
		.createEl("button", { cls: "mica-region-edit", text: "✎", attr: { type: "button", "aria-label": "Edit text" } })
		.addEventListener("click", (e) => {
			e.stopPropagation();
			openRegionEditor(region, ctx, path, start, end, md);
		});
	region.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		if (t.closest("a, button, input, textarea, .internal-link")) return;
		openRegionEditor(region, ctx, path, start, end, md);
	});
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
	const fit = (): void => {
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight + 2}px`;
	};
	if (ctx.editorAutosize ?? true) ta.addEventListener("input", fit);
	const restore = (): void => paintRegionView(region, ctx, path, start, end, original);
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
	const nav = wrap.createDiv({ cls: "mica-tab-nav", attr: { role: "tablist" } });
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
			btn.addEventListener("dblclick", (e) => {
				e.preventDefault();
				startRename(chip, btn, ctx, path, x.idx, tab.title);
			});
			chip.createEl("button", {
				cls: "mica-chip-x",
				text: "×",
				attr: { type: "button", "aria-label": "Delete tab", title: "Delete tab" },
			}).addEventListener("click", (e) => {
				e.stopPropagation();
				ctx.editable?.apply({ op: "deleteTab", path, index: x.idx });
			});
		}
		const panel = panels.createDiv({ cls: "mica-tab-panel", attr: { role: "tabpanel" } });
		renderTabBody(tab, panel, ctx, [...path, x.idx], revealTab === k);
		btns.push(btn);
		panelEls.push(panel);
	});

	if (ctx.editable) {
		const at = tabs[active] ? tabs[active].idx + 1 : node.children.length;
		nav.createEl("button", {
			cls: "mica-add",
			text: "+",
			attr: { type: "button", "aria-label": "Add tab", title: "Add a tab after this one" },
		}).addEventListener("click", () => ctx.editable?.apply({ op: "insertTab", path, at }));
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
			cell.createEl("button", {
				cls: "mica-cell-x",
				text: "×",
				attr: { type: "button", "aria-label": "Delete cell", title: "Delete cell" },
			}).addEventListener("click", (e) => {
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
			attr: { type: "button", title: "Add a cell" },
		}).addEventListener("click", () => ctx.editable?.apply({ op: "insertCell", path, at: node.children.length }));
	}
}

function stepper(bar: HTMLElement, label: string, value: number, onChange: (n: number) => void): void {
	const s = bar.createDiv({ cls: "mica-stepper" });
	s.createEl("span", { cls: "mica-stepper-label", text: label });
	s.createEl("button", {
		cls: "mica-step",
		text: "−",
		attr: { type: "button", "aria-label": "Fewer columns" },
	}).addEventListener("click", () => onChange(Math.max(1, value - 1)));
	s.createEl("span", { cls: "mica-stepper-val", text: String(value) });
	s.createEl("button", {
		cls: "mica-step",
		text: "+",
		attr: { type: "button", "aria-label": "More columns" },
	}).addEventListener("click", () => onChange(value + 1));
}

/** A quiet, contextual "insert a group here" affordance at the end of a region. */
function renderInsert(el: HTMLElement, ctx: RenderCtx, path: number[], at: number): void {
	const bar = el.createDiv({ cls: "mica-insert" });
	bar.createEl("button", {
		cls: "mica-insert-btn",
		text: "+ Tabs",
		attr: { type: "button", title: "Insert a tab group here" },
	}).addEventListener("click", () => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "tabs" }));
	bar.createEl("button", {
		cls: "mica-insert-btn",
		text: "+ Grid",
		attr: { type: "button", title: "Insert a grid here" },
	}).addEventListener("click", () => ctx.editable?.apply({ op: "insertGroup", path, at, kind: "grid" }));
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
		text: on ? `⏺ Auto · ${secs(p)}s` : "⏸ Manual",
		attr: { type: "button", title: on ? "Auto-save is on. Click for manual." : "Manual. Click to auto-save." },
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
			attr: { type: "button", title: "Change interval" },
		});
		iv.addEventListener("click", () => editInterval(bar, iv, p, repaint));
	} else {
		bar.createEl("button", {
			cls: "mica-save-now",
			text: "Save version",
			attr: { type: "button", title: "Snapshot the current content now" },
		}).addEventListener("click", () => {
			void p.engine.snapshot(chip.file, true);
			new Notice("Mica: version saved.");
		});
	}

	bar.createDiv({ cls: "mica-footer-spacer" });
	if (p.settings.showVersionChip) renderVersionChip(bar, ctx, chip);
}

function editInterval(bar: HTMLElement, iv: HTMLElement, plugin: MicaPlugin, repaint: () => void): void {
	iv.style.display = "none";
	const input = bar.createEl("input", { cls: "mica-auto-input", attr: { type: "number", min: "1", max: "60" } });
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
	const btn = bar.createEl("button", {
		cls: "mica-chip",
		text: "v…",
		attr: { type: "button", "aria-label": "Version history" },
	});
	btn.addEventListener("click", () => new DiffModal(chip.plugin, chip.file, chip.blockId).open());
	const refresh = async (): Promise<void> => {
		try {
			const state = (await chip.plugin.engine.state(chip.file))[chip.blockId];
			const count = state?.versions.length ?? 0;
			const sig = contentSignature(chip.content);
			let dirty: boolean;
			if (state?.head) {
				const head = await readObject(chip.plugin.app.vault, chip.file, state.head);
				dirty = head === null ? true : contentSignature(head) !== sig;
			} else {
				dirty = sig !== contentSignature("");
			}
			btn.setText(`v${count}${dirty ? " ●" : ""}`);
			btn.toggleClass("is-dirty", dirty);
		} catch {
			btn.setText("v?");
		}
	};
	void refresh();
	// Refresh when this file is snapshotted so the dirty dot clears itself.
	ctx.component.register(
		chip.plugin.engine.onSnapshot((f) => {
			if (f.path === chip.file.path) void refresh();
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
