import { App, Component, MarkdownRenderer, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { hashContent, serializeCst, type Cst, type MicaNode } from "../wasm/bridge";
import { DiffModal } from "../diff/diffModal";

/** Hooks that make a rendered block editable (Live Preview only). */
export interface EditHooks {
	/**
	 * Persist a tab's new source. `path` locates the tab node in the CST and
	 * `expectedTitle` lets the writer verify the node hasn't changed identity
	 * underneath the editor before replacing anything.
	 */
	save: (path: number[], expectedTitle: string, newText: string) => void;
	/** Append a new tab to the tab group at `tabsPath`. */
	addTab?: (tabsPath: number[]) => void;
	/** Append a new cell to the grid at `gridPath`. */
	addCell?: (gridPath: number[]) => void;
	/** Append a new top-level group to the block. */
	addGroup?: (kind: "tabs" | "grid") => void;
}

/** Everything the version chip needs to show state and open history. */
export interface ChipInfo {
	plugin: MicaPlugin;
	file: TFile;
	blockId: string;
	content: string;
}

export interface RenderCtx {
	app: App;
	sourcePath: string;
	component: Component;
	editable?: EditHooks;
	chip?: ChipInfo;
	/** Live Preview only: grow the inline editor with content (default true). */
	editorAutosize?: boolean;
}

type Container = Extract<MicaNode, { kind: "container" }>;

/** Render a parsed block into `el`. Shared by reading view and Live Preview. */
export function renderCst(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.addClass("mica");
	renderNodes(cst.children, el, ctx, []);
	if (ctx.editable?.addGroup) renderBlockToolbar(el, ctx);
	if (ctx.chip) renderChip(el, ctx.chip);
}

function mkAddButton(parent: HTMLElement, label: string, tooltip: string, onClick: () => void): HTMLElement {
	const b = parent.createEl("button", {
		cls: "mica-add-btn",
		text: label,
		attr: { type: "button", "aria-label": tooltip, title: tooltip },
	});
	b.addEventListener("click", onClick);
	return b;
}

function renderBlockToolbar(el: HTMLElement, ctx: RenderCtx): void {
	const bar = el.createDiv({ cls: "mica-block-toolbar" });
	mkAddButton(bar, "+ Tab group", "Add a tab group to this block", () => ctx.editable?.addGroup?.("tabs"));
	mkAddButton(bar, "+ Grid", "Add a grid to this block", () => ctx.editable?.addGroup?.("grid"));
}

function renderChip(root: HTMLElement, chip: ChipInfo): void {
	const bar = root.createDiv({ cls: "mica-chipbar" });
	const btn = bar.createEl("button", {
		cls: "mica-chip",
		text: "v…",
		attr: { type: "button", "aria-label": "Version history" },
	});
	btn.addEventListener("click", () => new DiffModal(chip.plugin, chip.file, chip.blockId).open());
	void (async () => {
		try {
			const state = (await chip.plugin.engine.state(chip.file))[chip.blockId];
			const count = state?.versions.length ?? 0;
			const dirty = state?.head
				? hashContent(chip.content) !== state.head && hashContent(`${chip.content}\n`) !== state.head
				: true;
			btn.setText(`v${count}${dirty ? " ●" : ""}`);
			btn.toggleClass("is-dirty", dirty);
		} catch {
			btn.setText("v?");
		}
	})();
}

function renderNodes(nodes: MicaNode[], el: HTMLElement, ctx: RenderCtx, basePath: number[]): void {
	let i = 0;
	while (i < nodes.length) {
		const node = nodes[i];
		if (node.kind === "leaf") {
			let md = "";
			while (i < nodes.length) {
				const n = nodes[i];
				if (n.kind !== "leaf") break;
				md += n.text;
				i++;
			}
			renderMarkdown(md, el, ctx);
			continue;
		}
		renderContainer(node, el, ctx, [...basePath, i]);
		i++;
	}
}

function renderContainer(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	if (node.name === "tabs") {
		renderTabs(node, el, ctx, path);
	} else if (node.name === "grid") {
		renderGrid(node, el, ctx, path);
	} else {
		renderNodes(node.children, el.createDiv({ cls: `mica-${node.name}` }), ctx, path);
	}
}

function renderTabs(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const wrap = el.createDiv({ cls: "mica-tabs" });
	const nav = wrap.createDiv({ cls: "mica-tab-nav", attr: { role: "tablist" } });
	const panels = wrap.createDiv({ cls: "mica-tab-panels" });
	const btns: HTMLButtonElement[] = [];
	const panelEls: HTMLElement[] = [];
	const activate = (k: number, focus = false): void => {
		btns.forEach((b, m) => {
			b.toggleClass("is-active", m === k);
			b.setAttribute("aria-selected", String(m === k));
			b.tabIndex = m === k ? 0 : -1;
		});
		panelEls.forEach((p, m) => p.toggleClass("is-active", m === k));
		if (focus) btns[k]?.focus();
	};

	node.children.forEach((c, idx) => {
		if (c.kind !== "container" || c.name !== "tab") return;
		const k = btns.length;
		const btn = nav.createEl("button", {
			cls: "mica-tab-btn",
			text: c.title || `Tab ${k + 1}`,
			attr: { type: "button", role: "tab" },
		});
		const panel = panels.createDiv({ cls: "mica-tab-panel", attr: { role: "tabpanel" } });
		renderTabBody(c, panel, ctx, [...path, idx]);
		btn.addEventListener("click", () => activate(k));
		btns.push(btn);
		panelEls.push(panel);
	});

	if (ctx.editable?.addTab) {
		mkAddButton(nav, "+", "Add a tab", () => ctx.editable?.addTab?.(path));
	}

	nav.addEventListener("keydown", (ev: KeyboardEvent) => {
		const current = btns.findIndex((b) => b.tabIndex === 0);
		if (current < 0) return;
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

	if (btns.length) activate(0);
}

function renderTabBody(tab: Container, panel: HTMLElement, ctx: RenderCtx, tabPath: number[]): void {
	panel.empty();
	renderNodes(tab.children, panel.createDiv({ cls: "mica-tab-body" }), ctx, tabPath);
	if (ctx.editable) {
		const bar = panel.createDiv({ cls: "mica-tab-actions" });
		bar.createEl("button", { cls: "mica-edit-btn", text: "✎ Edit", attr: { type: "button" } }).addEventListener(
			"click",
			() => openInlineEditor(tab, panel, ctx, tabPath),
		);
	}
}

function openInlineEditor(tab: Container, panel: HTMLElement, ctx: RenderCtx, tabPath: number[]): void {
	panel.empty();
	const ta = panel.createEl("textarea", { cls: "mica-edit-area" });
	ta.value = serializeCst({ children: tab.children });
	const save = (): void => ctx.editable?.save(tabPath, tab.title, ta.value);
	const cancel = (): void => renderTabBody(tab, panel, ctx, tabPath);
	// Grow with content; CSS `max-height` caps it and then it scrolls, and the
	// resize handle lets you drag it larger/smaller within those bounds.
	const fit = (): void => {
		ta.style.height = "auto";
		ta.style.height = `${ta.scrollHeight + 2}px`;
	};
	if (ctx.editorAutosize ?? true) ta.addEventListener("input", fit);
	ta.addEventListener("keydown", (ev) => {
		if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") {
			ev.preventDefault();
			save();
		} else if (ev.key === "Escape") {
			ev.preventDefault();
			cancel();
		}
	});
	const bar = panel.createDiv({ cls: "mica-tab-actions" });
	bar.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } }).addEventListener("click", save);
	bar.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", cancel);
	fit();
	ta.focus();
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const grid = el.createDiv({ cls: "mica-grid" });
	grid.style.setProperty("--mica-cols", parseAttr(node.title, "cols") ?? "2");
	node.children.forEach((c, idx) => {
		if (c.kind === "container" && c.name === "cell") {
			renderNodes(c.children, grid.createDiv({ cls: "mica-cell" }), ctx, [...path, idx]);
		}
	});
	if (ctx.editable?.addCell) {
		const bar = el.createDiv({ cls: "mica-grid-actions" });
		mkAddButton(bar, "+ Cell", "Add a grid cell", () => ctx.editable?.addCell?.(path));
	}
}

function renderMarkdown(md: string, el: HTMLElement, ctx: RenderCtx): void {
	if (!md.trim()) return;
	void MarkdownRenderer.render(ctx.app, md, el.createDiv({ cls: "mica-md" }), ctx.sourcePath, ctx.component);
}

function parseAttr(title: string, key: string): string | null {
	const m = title.match(new RegExp(`\\b${key}=([^\\s}]+)`));
	return m ? m[1] : null;
}
