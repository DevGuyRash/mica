import { App, Component, MarkdownRenderer } from "obsidian";
import type { Cst, MicaNode } from "../wasm/bridge";

/** Everything the renderer needs to draw a block and render nested markdown. */
export interface RenderCtx {
	app: App;
	sourcePath: string;
	component: Component;
}

type Container = Extract<MicaNode, { kind: "container" }>;

/** Render a parsed block into `el`. Shared by reading view and Live Preview. */
export function renderCst(cst: Cst, el: HTMLElement, ctx: RenderCtx): void {
	el.addClass("mica");
	renderNodes(cst.children, el, ctx);
}

function renderNodes(nodes: MicaNode[], el: HTMLElement, ctx: RenderCtx): void {
	let i = 0;
	while (i < nodes.length) {
		const node = nodes[i];
		if (node.kind === "leaf") {
			// Group consecutive leaves so markdown stays coherent within a block.
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
		renderContainer(node, el, ctx);
		i++;
	}
}

function renderContainer(node: Container, el: HTMLElement, ctx: RenderCtx): void {
	if (node.name === "tabs") {
		renderTabs(node, el, ctx);
	} else if (node.name === "grid") {
		renderGrid(node, el, ctx);
	} else {
		// `tab`/`cell` outside their parent, or an unknown directive: render inline.
		renderNodes(node.children, el.createDiv({ cls: `mica-${node.name}` }), ctx);
	}
}

function renderTabs(node: Container, el: HTMLElement, ctx: RenderCtx): void {
	const tabs = node.children.filter((c): c is Container => c.kind === "container" && c.name === "tab");
	const wrap = el.createDiv({ cls: "mica-tabs" });
	const nav = wrap.createDiv({ cls: "mica-tab-nav", attr: { role: "tablist" } });
	const panels = wrap.createDiv({ cls: "mica-tab-panels" });
	const btns: HTMLElement[] = [];
	const panelEls: HTMLElement[] = [];

	const activate = (k: number): void => {
		btns.forEach((b, m) => b.toggleClass("is-active", m === k));
		panelEls.forEach((p, m) => p.toggleClass("is-active", m === k));
	};

	tabs.forEach((tab, k) => {
		const btn = nav.createEl("button", {
			cls: "mica-tab-btn",
			text: tab.title || `Tab ${k + 1}`,
			attr: { type: "button", role: "tab" },
		});
		const panel = panels.createDiv({ cls: "mica-tab-panel", attr: { role: "tabpanel" } });
		renderNodes(tab.children, panel, ctx);
		btn.addEventListener("click", () => activate(k));
		btns.push(btn);
		panelEls.push(panel);
	});

	if (tabs.length) activate(0);
}

function renderGrid(node: Container, el: HTMLElement, ctx: RenderCtx): void {
	const grid = el.createDiv({ cls: "mica-grid" });
	grid.style.setProperty("--mica-cols", parseAttr(node.title, "cols") ?? "2");
	for (const c of node.children) {
		if (c.kind === "container" && c.name === "cell") {
			renderNodes(c.children, grid.createDiv({ cls: "mica-cell" }), ctx);
		}
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
