import { TFile, TFolder } from "obsidian";
import type MicaPlugin from "../main";
import {
	applyBlockEdit,
	newId,
	reconcileIndexes,
	rewriteBlockIdAt,
	scanBlocksView,
	type ContentRef,
	type LedgerEvent,
	type ReconcileAction,
	type SidecarRef,
} from "../wasm/bridge";
import { appendEvents, ensureSidecar, readEventsAt, requireObject, sidecarDir, writeObject } from "../storage/sidecar";
import { orderedLedgerEvents, remintOrderedLedgerEventIds } from "../storage/ledger";

interface ContentOccurrence extends ContentRef {
	readonly start: number;
}

async function gatherContent(plugin: MicaPlugin): Promise<ContentOccurrence[]> {
	const refs: ContentOccurrence[] = [];
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (file.path.includes(".mica/")) continue;
		for (const b of scanBlocksView(await plugin.app.vault.read(file))) {
			if (b.id) refs.push({ block: b.id, note: file.path, start: b.start });
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
	readonly blocks: ReadonlySet<string>;
	readonly hasEvents: boolean;
}

async function gatherSidecars(plugin: MicaPlugin): Promise<IndexedSidecar[]> {
	const sidecars: IndexedSidecar[] = [];
	for (const folder of sidecarFolders(plugin)) {
		const events = await readEventsAt(plugin.app.vault, `${folder.path}/ledger.jsonl`);
		sidecars.push({ folder, blocks: new Set(events.map((event) => event.block)), hasEvents: events.length > 0 });
	}
	return sidecars;
}

function sidecarRefs(sidecars: readonly IndexedSidecar[]): SidecarRef[] {
	return sidecars.flatMap(({ folder, blocks }) => [...blocks].map((block) => ({ block, sidecar: folder.path })));
}

export interface RepairReport {
	actions: ReconcileAction[];
	rehomed: { from: string; to: string }[];
	/** Sidecars intentionally left in place because no single safe target exists. */
	conflicted: { sidecar: string; notes: string[]; reason: "multiple-live-targets" | "destination-exists" }[];
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
	const actions = reconcileIndexes(
		content.map(({ block, note }) => ({ block, note })),
		sidecarRefs(sidecars),
	);
	const sidecarByPath = new Map(sidecars.map((sidecar) => [sidecar.folder.path, sidecar]));
	const occurrencesByBlock = new Map<string, ContentOccurrence[]>();
	for (const occurrence of content) {
		const group = occurrencesByBlock.get(occurrence.block);
		if (group) group.push(occurrence);
		else occurrencesByBlock.set(occurrence.block, [occurrence]);
	}
	const keeperByBlock = new Map<string, ContentOccurrence>();
	const repairOrderByBlock = new Map<string, readonly ContentOccurrence[]>();
	for (const action of actions) {
		if (action.kind === "duplicate-block") {
			const occurrences = occurrencesByBlock.get(action.block) ?? [];
			keeperByBlock.set(action.block, pickKeeper(plugin, action.block, occurrences, sidecarByPath));
			repairOrderByBlock.set(
				action.block,
				[...occurrences].sort((left, right) => left.note.localeCompare(right.note) || right.start - left.start),
			);
		}
	}

	const noteByBlock = new Map<string, string>();
	for (const ref of content) noteByBlock.set(ref.block, keeperByBlock.get(ref.block)?.note ?? ref.note);

	const rehomed: { from: string; to: string }[] = [];
	const conflicted: RepairReport["conflicted"] = [];
	const buried: string[] = [];
	for (const { folder, blocks, hasEvents } of sidecars) {
		const targets = new Set<string>();
		for (const block of blocks) {
			const target = noteByBlock.get(block);
			if (target) targets.add(target);
		}
		if (!targets.size) {
			// No live note references ANY of this folder's blocks: the note is
			// gone. History is never deleted — it moves to the graveyard.
			const from = folder.path;
			if (hasEvents && (await buryFolder(plugin, folder))) buried.push(from);
			continue;
		}
		if (targets.size !== 1) {
			conflicted.push({
				sidecar: folder.path,
				notes: [...targets].sort((left, right) => left.localeCompare(right)),
				reason: "multiple-live-targets",
			});
			continue;
		}
		const notePath = [...targets][0];
		const note = vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) continue;
		const expected = sidecarDir(note);
		if (expected !== folder.path && vault.getAbstractFileByPath(expected)) {
			conflicted.push({ sidecar: folder.path, notes: [notePath], reason: "destination-exists" });
			continue;
		}
		if (expected !== folder.path) {
			const from = folder.path;
			// Forking below reads history from the keeper's co-located sidecar, so
			// a failed rehome must stop the repair before any ids are rewritten.
			await plugin.engine.withFileLock(note, () => vault.rename(folder, expected));
			rehomed.push({ from, to: expected });
		}
	}

	// A copied note duplicates block ids: every copy beyond the keeper gets a
	// FRESH id and a cloned history, so both notes keep their full timeline.
	// Read each keeper ledger once and retain only histories that will actually
	// be cloned. Destination appends invalidate the global sidecar cache, so a
	// per-repair index avoids O(copies × keeper-ledger) reparsing.
	const duplicateHistories = await gatherDuplicateHistories(plugin, keeperByBlock);
	const forked: { block: string; note: string; freshId: string }[] = [];
	for (const a of actions) {
		if (a.kind !== "duplicate-block") continue;
		// Rewrite from the bottom of each note so a short legacy id expanding to a
		// UUID cannot invalidate the original starts of earlier occurrences.
		const occurrences = repairOrderByBlock.get(a.block) ?? [];
		const keeper = keeperByBlock.get(a.block) ?? occurrences[0];
		for (const occurrence of occurrences) {
			if (occurrence.note === keeper.note && occurrence.start === keeper.start) continue;
			const fresh = await forkBlock(
				plugin,
				a.block,
				keeper.note,
				occurrence,
				duplicateHistories.get(a.block) ?? [],
			);
			if (fresh) forked.push({ block: a.block, note: occurrence.note, freshId: fresh });
		}
	}
	return { actions, rehomed, conflicted, forked, buried };
}

/** The note that keeps a duplicated block id: the one whose own sidecar
 *  already holds the block's history; ties broken by path order. */
function pickKeeper(
	plugin: MicaPlugin,
	block: string,
	occurrences: readonly ContentOccurrence[],
	sidecarByPath: ReadonlyMap<string, IndexedSidecar>,
): ContentOccurrence {
	let best: ContentOccurrence | undefined;
	let bestWithHistory: ContentOccurrence | undefined;
	for (const occurrence of occurrences) {
		if (!best || compareOccurrence(occurrence, best) < 0) best = occurrence;
		const note = plugin.app.vault.getAbstractFileByPath(occurrence.note);
		if (!(note instanceof TFile)) continue;
		if (
			sidecarByPath.get(sidecarDir(note))?.blocks.has(block) &&
			(!bestWithHistory || compareOccurrence(occurrence, bestWithHistory) < 0)
		) {
			bestWithHistory = occurrence;
		}
	}
	const keeper = bestWithHistory ?? best;
	if (!keeper) throw new Error(`Mica: duplicate block ${block} has no live occurrence`);
	return keeper;
}

function compareOccurrence(left: ContentOccurrence, right: ContentOccurrence): number {
	return left.note.localeCompare(right.note) || left.start - right.start;
}

async function gatherDuplicateHistories(
	plugin: MicaPlugin,
	keeperByBlock: ReadonlyMap<string, ContentOccurrence>,
): Promise<Map<string, readonly LedgerEvent[]>> {
	const blocksByKeeper = new Map<string, Set<string>>();
	for (const [block, keeper] of keeperByBlock) {
		const blocks = blocksByKeeper.get(keeper.note) ?? new Set<string>();
		blocks.add(block);
		blocksByKeeper.set(keeper.note, blocks);
	}
	const histories = new Map<string, LedgerEvent[]>();
	for (const [keeperPath, wantedBlocks] of blocksByKeeper) {
		const keeper = plugin.app.vault.getAbstractFileByPath(keeperPath);
		if (!(keeper instanceof TFile)) continue;
		const events = await readEventsAt(plugin.app.vault, `${sidecarDir(keeper)}/ledger.jsonl`);
		for (const event of events) {
			if (!wantedBlocks.has(event.block)) continue;
			const history = histories.get(event.block) ?? [];
			history.push(event);
			histories.set(event.block, history);
		}
	}
	for (const [block, events] of histories) histories.set(block, orderedLedgerEvents(events));
	return histories;
}

/** Give a COPY of a block a fresh id and clone the keeper's history for it. */
async function forkBlock(
	plugin: MicaPlugin,
	block: string,
	keeperPath: string,
	occurrence: ContentOccurrence,
	sourceEvents: readonly LedgerEvent[],
): Promise<string | null> {
	const vault = plugin.app.vault;
	const copy = vault.getAbstractFileByPath(occurrence.note);
	const keeper = vault.getAbstractFileByPath(keeperPath);
	if (!(copy instanceof TFile)) return null;
	return plugin.engine.withFileLock(copy, async () => {
		const fresh = newId();
		// `gatherDuplicateHistories` sorted this shared history once; every copy
		// remints from the same authoritative fold order without re-sorting it.
		const events = sourceEvents;

		if (events.length && keeper instanceof TFile) {
			await ensureSidecar(vault, copy);
			for (const hash of new Set(events.map((event) => event.hash))) {
				const body = await requireObject(vault, keeper, hash);
				await writeObject(vault, copy, hash, body);
			}
		}

		// Commit cloned history first. If the subsequent guarded note rewrite is
		// rejected, the only residue is unreachable immutable history; the live
		// note still retains its original id/history and no user content is lost.
		await appendEvents(
			vault,
			copy,
			remintOrderedLedgerEventIds(events, newId).map((event) => ({ ...event, block: fresh })),
		);
		await vault.process(copy, (doc) => {
			const edit = rewriteBlockIdAt(doc, occurrence.start, block, fresh);
			if (!edit) throw new Error(`Mica: duplicate block changed during repair (${block} at ${occurrence.note})`);
			return applyBlockEdit(doc, edit);
		});
		return fresh;
	});
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
