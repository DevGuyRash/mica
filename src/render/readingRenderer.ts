import { MarkdownRenderChild, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { parseBlock } from "../wasm/bridge";
import { renderCst, type ChipInfo } from "./layoutEngine";

/**
 * Reading view: register the ` ```mica ` code-block processor. Obsidian calls
 * this once per block (and virtualizes offscreen blocks); we parse the content
 * in Rust and render interactive, read-only tabs/grids plus the version chip.
 */
export function registerReadingRenderer(plugin: MicaPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("mica", (source, el, ctx) => {
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);

		let chip: ChipInfo | undefined;
		if (plugin.settings.showVersionChip) {
			// The processor receives only the inner source; the block id lives on
			// the fence header line, recovered via the section info (read fresh —
			// never cached).
			const info = ctx.getSectionInfo(el);
			const header = info?.text.split("\n")[info.lineStart] ?? "";
			const id = header.match(/\bid=([^\s`"]+)/)?.[1];
			const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (id && file instanceof TFile) {
				chip = { plugin, file, blockId: id, content: source };
			}
		}

		renderCst(parseBlock(source), el, {
			app: plugin.app,
			sourcePath: ctx.sourcePath,
			component: child,
			chip,
		});
	});
}
