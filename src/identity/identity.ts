import { TFile } from "obsidian";
import type MicaPlugin from "../main";
import { ensureIds, newId } from "../wasm/bridge";

/**
 * Ensure the note has a stable `mica-id` in frontmatter (written via
 * `processFrontMatter`, so it never clobbers an existing `uuid`). Returns the id.
 */
export async function ensureNoteId(plugin: MicaPlugin, file: TFile): Promise<string> {
	let id = "";
	await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		if (typeof fm["mica-id"] !== "string" || !fm["mica-id"]) {
			fm["mica-id"] = newId();
		}
		id = fm["mica-id"] as string;
	});
	return id;
}

/** Ensure every ` ```mica ` block carries an `id=`. Returns true if the note changed. */
export async function ensureBlockIds(plugin: MicaPlugin, file: TFile): Promise<boolean> {
	const doc = await plugin.app.vault.read(file);
	const next = ensureIds(doc);
	if (next === doc) return false;
	await plugin.app.vault.modify(file, next);
	return true;
}
