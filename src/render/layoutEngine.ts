import { App, Component, MarkdownRenderer } from "obsidian";
import { serializeCst, type Cst, type MicaNode } from "../wasm/bridge";

/** Hooks that make a rendered block editable (Live Preview only). */
export interface EditHooks {
	/** Persist a tab's new source; `path` locates the tab node in the CST. */
	save: (path: number[], newText: string) => void;
}

export interface RenderCtx {
	app: App;
	sourcePath: string;
	component: Component;
	editable?: EditHooks;
}

type Container = Extract<MicaNode, { kind: "container" }>;

/** Render a parsed block into `el`. Shared by reading view and Live Preview. */
export function renderCst(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.addClass("mica");
	renderNodes(cst.children, el, ctx, []);
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
	const btns: HTMLElement[] = [];
	const panelEls: HTMLElement[] = [];
	const activate = (k: number): void => {
		btns.forEach((b, m) => b.toggleClass("is-active", m === k));
		panelEls.forEach((p, m) => p.toggleClass("is-active", m === k));
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
	ta.rows = Math.min(24, ta.value.split("\n").length + 1);
	const bar = panel.createDiv({ cls: "mica-tab-actions" });
	bar.createEl("button", { cls: "mod-cta", text: "Save", attr: { type: "button" } }).addEventListener("click", () => {
		ctx.editable?.save(tabPath, ta.value);
	});
	bar.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () => {
		renderTabBody(tab, panel, ctx, tabPath);
	});
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx, path: number[]): void {
	const grid = el.createDiv({ cls: "mica-grid" });
	grid.style.setProperty("--mica-cols", parseAttr(node.title, "cols") ?? "2");
	node.children.forEach((c, idx) => {
		if (c.kind === "container" && c.name === "cell") {
			renderNodes(c.children, grid.createDiv({ cls: "mica-cell" }), ctx, [...path, idx]);
		}
	});
}

function renderMarkdown(md: string, el: HTMLElement, ctx: RenderCtx): void {
	if (!md.trim()) return;
	void MarkdownRenderer.render(ctx.app, md, el.createDiv({ cls: "mica-md" }), ctx.sourcePath, ctx.component);
}

function parseAttr(title: string, key: string): string | null {
	const m = title.match(new RegExp(`\\b${key}=([^\\s}]+)`));
	return m ? m[1] : null;
}
