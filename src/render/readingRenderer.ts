import { MarkdownRenderChild, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { parseBlock } from "../wasm/bridge";
import { renderCst, type BlockUi, type ChipInfo } from "../ui/blockShell";

/**
 * Reading view: register the ` ```mica ` code-block processor. Obsidian calls
 * this once per block (and virtualizes offscreen blocks); we parse the content
 * in Rust and render the same shell Live Preview uses — read-only, but with
 * the header, navigator, versions, and the SAME per-block UI state, so the
 * active tab survives flipping between reading and editing modes.
 */
export function registerReadingRenderer(plugin: MicaPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("mica", (source, el, ctx) => {
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);

		// The processor receives only the inner source; the block id and attrs
		// live on the fence header line, recovered via the section info (read
		// fresh — never cached).
		const info = ctx.getSectionInfo(el);
		const header = info?.text.split("\n")[info.lineStart] ?? "";
		const id = header.match(/\bid=([^\s`"]+)/)?.[1];
		const attrs: Record<string, string> = {};
		for (const m of header.matchAll(/(\w[\w-]*)=(?:"([^"]*)"|(\S+))/g)) {
			attrs[m[1]] = m[2] ?? m[3] ?? "";
		}

		let chip: ChipInfo | undefined;
		if (plugin.settings.showVersionChip) {
			const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (id && file instanceof TFile) {
				chip = { plugin, file, blockId: id, content: source };
			}
		}

		// Share tab/collapse state with Live Preview via the same key.
		let ui: BlockUi | undefined;
		if (id) {
			ui = plugin.micaUi.get(id);
			if (!ui) {
				ui = { active: new Map(), reveal: null, draft: null, collapsed: false, folded: new Set() };
				plugin.micaUi.set(id, ui);
			}
		}

		try {
			renderCst(parseBlock(source), el, {
				app: plugin.app,
				sourcePath: ctx.sourcePath,
				component: child,
				chip,
				ui,
				blockAttrs: attrs,
				headerMode: plugin.settings.blockHeaderMode,
			});
		} catch (e) {
			// A render error must never blank the block — show it and keep the source.
			console.error("Mica: reading render failed", e);
			el.createEl("pre", {
				cls: "mica-render-error",
				text: `Mica render error: ${e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e)}`,
			});
		}
	});
}
