import { TFile } from "obsidian";
import type MicaPlugin from "../main";
import { hashContent, migrateTabs, newId, type LedgerEvent } from "../wasm/bridge";
import { appendEvents, ensureSidecar, writeObject } from "../storage/sidecar";
import { ensureNoteId } from "../identity/identity";

export interface MigrateFileReport {
	path: string;
	blocks: number;
	versionsImported: number;
	/** Content hash of the whole-note backup object (absent on dry run). */
	backup?: string;
	dryRun: boolean;
}

/**
 * Convert one note's legacy ` ```tabs ` blocks to Mica. Lossless and recoverable:
 * the entire original note is stored as a content-addressed object BEFORE any
 * write, versioned callouts inside tab bodies are imported as labeled history
 * (backdated so they sort before the migrated head), and the head is snapshotted
 * last. Returns null when the note has nothing convertible.
 */
export async function migrateFile(plugin: MicaPlugin, file: TFile, dryRun: boolean): Promise<MigrateFileReport | null> {
	const vault = plugin.app.vault;
	const original = await vault.read(file);
	const result = migrateTabs(original, plugin.settings.versionCalloutTypes);
	if (!result.changed) return null;

	const versionsImported = result.blocks.reduce((n, b) => n + b.versions.length, 0);
	if (dryRun) {
		return { path: file.path, blocks: result.blocks.length, versionsImported, dryRun: true };
	}

	await ensureSidecar(vault, file);
	const backup = hashContent(original);
	await writeObject(vault, file, backup, original);

	await vault.modify(file, result.doc);
	await ensureNoteId(plugin, file);

	// Import archived callouts as real, labeled versions — backdated one second
	// apart so the (ts, eid) fold orders them before the head snapshot below.
	const events: LedgerEvent[] = [];
	const now = Date.now();
	for (const block of result.blocks) {
		const n = block.versions.length;
		for (let i = 0; i < n; i++) {
			const v = block.versions[i];
			const hash = hashContent(v.content);
			await writeObject(vault, file, hash, v.content);
			events.push({
				type: "add-version",
				eid: newId(),
				ts: now - (n - i) * 1000,
				block: block.id,
				hash,
				label: v.label,
				origin: `migrated:${v.status}`,
			});
		}
	}
	await appendEvents(vault, file, events);
	await plugin.engine.snapshot(file); // head becomes the newest version

	return { path: file.path, blocks: result.blocks.length, versionsImported, backup, dryRun: false };
}

/** Migrate every markdown note in the vault (sidecars excluded). */
export async function migrateVault(plugin: MicaPlugin, dryRun: boolean): Promise<MigrateFileReport[]> {
	const reports: MigrateFileReport[] = [];
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (file.path.includes(".mica/")) continue;
		const report = await migrateFile(plugin, file, dryRun);
		if (report) reports.push(report);
	}
	return reports;
}
