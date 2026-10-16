import { TFile } from "obsidian";
import type MicaPlugin from "../main";
import { ensureNoteStore, storeRoot, isLiveNote } from "../storage/store";
import { ensureIds, scanBlocksView } from "../wasm/bridge";

/** Prepare the shared source-backed note anchor under the existing note queue. */
export async function ensureNoteId(plugin: MicaPlugin, file: TFile): Promise<string> {
	return plugin.engine.withFileLock(file, async () => {
		const root = storeRoot(plugin.app.vault);
		return (await ensureNoteStore(root, file, await root.vault.read(file))).store.noteId;
	});
}

/** Ensure every ` ```mica ` block carries an `id=`. Returns true if the note changed. */
export async function ensureBlockIds(plugin: MicaPlugin, file: TFile): Promise<boolean> {
	if (!isLiveNote(file)) throw new Error("Mica: managed storage is not a live note");
	return plugin.engine.withFileLock(file, async () => {
		const initial = await plugin.app.vault.read(file);
		if (!scanBlocksView(initial).some((block) => !block.id)) return false;

		let changed = false;
		await plugin.app.vault.process(file, (doc) => {
			const next = ensureIds(doc);
			changed = next !== doc;
			return next;
		});
		return changed;
	});
}
