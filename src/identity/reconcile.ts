import { TFile, TFolder } from "obsidian";
import type MicaPlugin from "../main";
import {
	reconcileIndexes,
	scanBlocksView,
	type ContentRef,
	type ReconcileAction,
	type SidecarRef,
} from "../wasm/bridge";
import { readEventsAt, sidecarDir } from "../storage/sidecar";

async function gatherContent(plugin: MicaPlugin): Promise<ContentRef[]> {
	const refs: ContentRef[] = [];
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (file.path.includes(".mica/")) continue;
		for (const b of scanBlocksView(await plugin.app.vault.read(file))) {
			if (b.id) refs.push({ block: b.id, note: file.path });
		}
	}
	return refs;
}

function sidecarFolders(plugin: MicaPlugin): TFolder[] {
	return plugin.app.vault
		.getAllLoadedFiles()
		.filter((f): f is TFolder => f instanceof TFolder && f.path.endsWith(".mica"));
}

async function gatherSidecar(plugin: MicaPlugin): Promise<SidecarRef[]> {
	const refs: SidecarRef[] = [];
	for (const folder of sidecarFolders(plugin)) {
		const events = await readEventsAt(plugin.app.vault, `${folder.path}/ledger.jsonl`);
		for (const block of new Set(events.map((e) => e.block))) {
			refs.push({ block, sidecar: folder.path });
		}
	}
	return refs;
}

export interface RepairReport {
	actions: ReconcileAction[];
	rehomed: { from: string; to: string }[];
}

/**
 * Reconcile the vault: classify inconsistencies, and rehome any sidecar whose
 * note moved away (identity is the UUID, so we match by block id, not path).
 */
export async function repair(plugin: MicaPlugin): Promise<RepairReport> {
	const vault = plugin.app.vault;
	const content = await gatherContent(plugin);
	const actions = reconcileIndexes(content, await gatherSidecar(plugin));

	const noteByBlock = new Map<string, string>();
	for (const c of content) noteByBlock.set(c.block, c.note);

	const rehomed: { from: string; to: string }[] = [];
	for (const folder of sidecarFolders(plugin)) {
		const events = await readEventsAt(vault, `${folder.path}/ledger.jsonl`);
		const notePath = events.map((e) => noteByBlock.get(e.block)).find((n): n is string => Boolean(n));
		if (!notePath) continue;
		const note = vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) continue;
		const expected = sidecarDir(note);
		if (expected !== folder.path && !vault.getAbstractFileByPath(expected)) {
			await vault.rename(folder, expected).catch(() => undefined);
			rehomed.push({ from: folder.path, to: expected });
		}
	}
	return { actions, rehomed };
}
