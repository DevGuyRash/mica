import { MarkdownRenderChild, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { parseBlock, scanBlocksView, type BlockView } from "../wasm/bridge";
import { renderCst, type ChipInfo } from "../ui/blockShell";
import { getBlockUi } from "./blockUiState";
import { noteBasenameFromPath, unnamedBlockOrdinals } from "../identity/blockLabel";
import { copyOptionsFromSettings } from "../ui/copyPayload";
import { isManagedPath } from "../wasm/bridge";
import { storeRoot } from "../storage/store";

interface CachedBlock {
	block: BlockView;
	unnamedOrdinal: number;
}

interface SectionCache {
	text: string;
	lineStarts: readonly number[];
	blocksByStart: ReadonlyMap<number, CachedBlock>;
}

// Section info exposes a line number in the whole note. Keep one bounded index
// so a note with many blocks gets one line walk and one WASM scan, total.
let sectionCache: SectionCache | null = null;

/**
 * Reading view: register the ` ```mica ` code-block processor. Obsidian calls
 * this once per block (and virtualizes offscreen blocks); we parse the content
 * in Rust and render the same shell Live Preview uses — read-only, but with
 * the header, navigator, versions, and the SAME per-block UI state, so the
 * active tab survives flipping between reading and editing modes.
 */
export function registerReadingRenderer(plugin: MicaPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor("mica", (source, el, ctx) => {
		if (isManagedPath(ctx.sourcePath, storeRoot(plugin.app.vault).paths.root)) {
			// History objects are data; they must not mount live editing/history controls.
			el.createEl("pre", { text: source });
			return;
		}
		const child = new MarkdownRenderChild(el);
		ctx.addChild(child);

		// The processor receives only the inner source; the block id and attrs
		// live on the fence header line, recovered from the current section text.
		const info = ctx.getSectionInfo(el);
		const located = info ? blockAtLine(info.text, info.lineStart) : undefined;
		const block = located?.block;
		const id = block?.id ?? undefined;
		const attrs = block ? Object.fromEntries(block.attrs) : {};
		const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);

		let chip: ChipInfo | undefined;
		if (id && file instanceof TFile) {
			chip = { plugin, file, blockId: id, content: source };
		}

		// Share tab/collapse state with Live Preview via the same key.
		const ui = id ? getBlockUi(plugin, id) : undefined;

		try {
			renderCst(parseBlock(source), el, {
				app: plugin.app,
				sourcePath: ctx.sourcePath,
				component: child,
				chip,
				ui,
				blockAttrs: attrs,
				blockNamePresentation: {
					noteBasename: file instanceof TFile ? file.basename : noteBasenameFromPath(ctx.sourcePath),
					unnamedOrdinal: located?.unnamedOrdinal ?? 1,
				},
				headerMode: plugin.settings.blockHeaderMode,
				copyOptions: () => copyOptionsFromSettings(plugin.settings),
				entityActionLayout: plugin.settings.entityActionLayout,
				showTabActionMenuOnHover: plugin.settings.showTabActionMenuOnHover,
				longBlockControls: plugin.settings.longBlockControls,
				dockCopyTargetMode: plugin.settings.dockCopyTargetMode,
				dockActionLayout: plugin.settings.dockActionLayout,
				hiddenSectionActions: new Set(plugin.settings.hiddenSectionActions),
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

/**
 * Resolve one section line through the Rust scanner's exact header grammar.
 * The local single-slot index keeps the scanner's immutable block aliases and
 * avoids O(note × blocks) line walks as Obsidian invokes each processor.
 */
function blockAtLine(text: string, line: number): CachedBlock | undefined {
	if (!sectionCache || sectionCache.text !== text) {
		const lineStarts = [0];
		let pos = 0;
		while ((pos = text.indexOf("\n", pos)) >= 0) {
			lineStarts.push(++pos);
		}
		const blocks = scanBlocksView(text);
		const ordinals = unnamedBlockOrdinals(blocks.map((block) => block.name));
		sectionCache = {
			text,
			lineStarts,
			blocksByStart: new Map(
				blocks.map((block, index) => [block.start, { block, unnamedOrdinal: ordinals[index] ?? 1 }]),
			),
		};
	}
	const start = sectionCache.lineStarts[line];
	return start === undefined ? undefined : sectionCache.blocksByStart.get(start);
}
