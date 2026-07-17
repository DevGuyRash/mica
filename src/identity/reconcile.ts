import { TFile, TFolder } from "obsidian";
import type MicaPlugin from "../main";
import {
	newId,
	reconcileIndexes,
	scanBlocksView,
	type ContentRef,
	type LedgerEvent,
	type ReconcileAction,
	type SidecarRef,
} from "../wasm/bridge";
import { appendEvents, ensureSidecar, readEventsAt, readObject, sidecarDir, writeObject } from "../storage/sidecar";

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

interface IndexedSidecar {
	readonly folder: TFolder;
	readonly events: readonly LedgerEvent[];
	readonly blocks: ReadonlySet<string>;
}

async function gatherSidecars(plugin: MicaPlugin): Promise<IndexedSidecar[]> {
	const sidecars: IndexedSidecar[] = [];
	for (const folder of sidecarFolders(plugin)) {
		const events = await readEventsAt(plugin.app.vault, `${folder.path}/ledger.jsonl`);
		sidecars.push({ folder, events, blocks: new Set(events.map((event) => event.block)) });
	}
	return sidecars;
}

function sidecarRefs(sidecars: readonly IndexedSidecar[]): SidecarRef[] {
	return sidecars.flatMap(({ folder, blocks }) =>
		[...blocks].map((block) => ({ block, sidecar: folder.path })),
	);
}

export interface RepairReport {
	actions: ReconcileAction[];
	rehomed: { from: string; to: string }[];
	/** Duplicated block ids forked: the copy got a fresh id + cloned history. */
	forked: { block: string; note: string; freshId: string }[];
	/** Fully orphaned sidecar folders moved into the graveyard. */
	buried: string[];
}

/**
 * Reconcile the vault: classify inconsistencies, and rehome any sidecar whose
 * note moved away (identity is the UUID, so we match by block id, not path).
 */
export async function repair(plugin: MicaPlugin): Promise<RepairReport> {
	const vault = plugin.app.vault;
	const content = await gatherContent(plugin);
	const sidecars = await gatherSidecars(plugin);
	const actions = reconcileIndexes(content, sidecarRefs(sidecars));
	const sidecarByPath = new Map(sidecars.map((sidecar) => [sidecar.folder.path, sidecar]));
	const keeperByBlock = new Map<string, string>();
	for (const action of actions) {
		if (action.kind === "duplicate-block") {
			keeperByBlock.set(action.block, pickKeeper(plugin, action.block, action.notes, sidecarByPath));
		}
	}

	const noteByBlock = new Map<string, string>();
	for (const ref of content) noteByBlock.set(ref.block, keeperByBlock.get(ref.block) ?? ref.note);

	const rehomed: { from: string; to: string }[] = [];
	const buried: string[] = [];
	for (const { folder, events, blocks } of sidecars) {
		let notePath: string | undefined;
		for (const block of blocks) {
			notePath = noteByBlock.get(block);
			if (notePath) break;
		}
		if (!notePath) {
			// No live note references ANY of this folder's blocks: the note is
			// gone. History is never deleted — it moves to the graveyard.
			const from = folder.path;
			if (events.length && (await buryFolder(plugin, folder))) buried.push(from);
			continue;
		}
		const note = vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) continue;
		const expected = sidecarDir(note);
		if (expected !== folder.path && !vault.getAbstractFileByPath(expected)) {
			const from = folder.path;
			// Forking below reads history from the keeper's co-located sidecar, so
			// a failed rehome must stop the repair before any ids are rewritten.
			await vault.rename(folder, expected);
			rehomed.push({ from, to: expected });
		}
	}

	// A copied note duplicates block ids: every copy beyond the keeper gets a
	// FRESH id and a cloned history, so both notes keep their full timeline.
	const forked: { block: string; note: string; freshId: string }[] = [];
	for (const a of actions) {
		if (a.kind !== "duplicate-block") continue;
		const keeper = keeperByBlock.get(a.block) ?? a.notes[0];
		for (const notePath of a.notes) {
			if (notePath === keeper) continue;
			const fresh = await forkBlock(plugin, a.block, keeper, notePath);
			if (fresh) forked.push({ block: a.block, note: notePath, freshId: fresh });
		}
	}
	return { actions, rehomed, forked, buried };
}

/** The note that keeps a duplicated block id: the one whose own sidecar
 *  already holds the block's history; ties broken by path order. */
function pickKeeper(
	plugin: MicaPlugin,
	block: string,
	notes: string[],
	sidecarByPath: ReadonlyMap<string, IndexedSidecar>,
): string {
	const sorted = [...new Set(notes)].sort();
	for (const notePath of sorted) {
		const note = plugin.app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) continue;
		if (sidecarByPath.get(sidecarDir(note))?.blocks.has(block)) return notePath;
	}
	return sorted[0];
}

/** Give a COPY of a block a fresh id and clone the keeper's history for it. */
async function forkBlock(
	plugin: MicaPlugin,
	block: string,
	keeperPath: string,
	copyPath: string,
): Promise<string | null> {
	const vault = plugin.app.vault;
	const copy = vault.getAbstractFileByPath(copyPath);
	const keeper = vault.getAbstractFileByPath(keeperPath);
	if (!(copy instanceof TFile)) return null;
	const fresh = newId();

	// Rewrite the block id in the copy's fence header (first occurrence).
	const doc = await vault.read(copy);
	const next = doc.replace(`id=${block}`, `id=${fresh}`);
	if (next === doc) return null;
	await vault.modify(copy, next);

	// Clone the keeper's history under the fresh id into the COPY's sidecar.
	if (keeper instanceof TFile) {
		const events = (await readEventsAt(vault, `${sidecarDir(keeper)}/ledger.jsonl`)).filter(
			(e) => e.block === block,
		);
		if (events.length) {
			await ensureSidecar(vault, copy);
			for (const hash of new Set(events.map((event) => event.hash))) {
				const body = await readObject(vault, keeper, hash);
				if (body !== null) await writeObject(vault, copy, hash, body);
			}
			await appendEvents(
				vault,
				copy,
				events.map((e) => ({ ...e, eid: newId(), block: fresh })),
			);
		}
	}
	return fresh;
}

/** Move a fully orphaned sidecar folder under `.mica-graveyard/` (adapter
 *  level — dot-folders are invisible to the vault index, which is the point). */
async function buryFolder(plugin: MicaPlugin, folder: TFolder): Promise<boolean> {
	const adapter = plugin.app.vault.adapter;
	try {
		await adapter.mkdir(".mica-graveyard").catch(() => undefined);
		const stamp = Date.now();
		await adapter.rename(folder.path, `.mica-graveyard/${folder.name}-${stamp}`);
		return true;
	} catch {
		return false;
	}
}
