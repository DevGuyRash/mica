import { MarkdownRenderChild } from "obsidian";
import type MicaPlugin from "../main";
import { parseBlock } from "../wasm/bridge";
import { renderCst } from "./layoutEngine";

/**
 * Reading view: register the ` ```mica ` code-block processor. Obsidian calls
 * this once per block (and virtualizes offscreen blocks); we parse the content
 * in Rust and render interactive, read-only tabs/grids.
 */
export function registerReadingRenderer(plugin: MicaPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("mica", (source, el, ctx) => {
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);
		renderCst(parseBlock(source), el, {
			app: plugin.app,
			sourcePath: ctx.sourcePath,
			component: child,
		});
	});
}
