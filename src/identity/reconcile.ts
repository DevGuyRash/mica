import { TFile, TFolder } from "obsidian";
import type MicaPlugin from "../main";
import {
	applyBlockEdit,
	newId,
	noteId,
	notePaths,
	reconcileIndexes,
	resolveObjectHash,
	rewriteBlockIdAt,
	scanBlocksView,
	setNoteId,
	type LedgerEvent,
	type ReconcileAction,
} from "../wasm/bridge";
import {
	appendEvents,
	ensureSidecar,
	readEventsAt,
	requireObject,
	writeManifest,
	writeObject,
} from "../storage/sidecar";
import {
	assertLiveNoteCurrent,
	ensureNoteStore,
	isLiveNote,
	readAliases,
	stageNoteStore,
	storeRoot,
	validateStoreRoot,
	type NoteStore,
	type StoreRoot,
} from "../storage/store";
import { MAX_LEDGER_BYTES, orderedLedgerEvents, remintOrderedLedgerEventIds } from "../storage/ledger";

interface LiveNote {
	file: TFile;
	source: string;
	id: string | null;
	store: NoteStore | null;
}
interface NoteRecord {
	id: string;
	pathHint: string;
	events: readonly LedgerEvent[];
	aliases: Readonly<Record<string, string>>;
	dir: string;
}
interface Occurrence {
	block: string;
	note: LiveNote;
	start: number;
	ordinal: number;
}

export interface RepairReport {
	actions: ReconcileAction[];
	rehomed: { from: string; to: string }[];
	conflicted: { sidecar: string; notes: string[]; reason: "multiple-live-targets" | "destination-exists" }[];
	forked: { block: string; note: string; freshId: string }[];
	buried: string[];
}

async function gatherNotes(root: StoreRoot): Promise<LiveNote[]> {
	const notes: LiveNote[] = [];
	for (const file of root.vault.getMarkdownFiles()) {
		if (!isLiveNote(file)) continue;
		const source = await root.vault.read(file);
		notes.push({ file, source, id: noteId(source), store: null });
	}
	return notes;
}

async function gatherRecords(root: StoreRoot): Promise<Map<string, NoteRecord>> {
	const records = new Map<string, NoteRecord>();
	const folder = root.vault.getAbstractFileByPath(root.paths.notes);
	if (!folder) return records;
	if (!(folder instanceof TFolder)) throw new Error("Mica: note-store path is not a folder");
	for (const child of folder.children) {
		if (!(child instanceof TFolder)) continue;
		const manifestFile = root.vault.getAbstractFileByPath(`${child.path}/manifest.json`);
		if (!manifestFile) continue; // An interrupted staged fork remains recoverable, never guessed into a live note.
		if (!(manifestFile instanceof TFile) || manifestFile.stat.size > MAX_LEDGER_BYTES)
			throw new Error(`Mica: invalid note manifest: ${child.path}`);
		const value: unknown = JSON.parse(await root.vault.read(manifestFile));
		if (typeof value !== "object" || value === null || !("noteId" in value) || typeof value.noteId !== "string")
			throw new Error(`Mica: manifest lacks a stable note identity: ${child.path}`);
		const paths = notePaths(value.noteId, root.paths.root);
		if (paths.dir !== child.path)
			throw new Error(`Mica: manifest identity does not match its directory: ${child.path}`);
		const pathHint = "path" in value && typeof value.path === "string" ? value.path : "";
		records.set(value.noteId, {
			id: value.noteId,
			pathHint,
			dir: paths.dir,
			events: await readEventsAt(root, paths.ledger),
			aliases: await readAliases(root, paths.aliases),
		});
	}
	return records;
}

function occurrences(notes: readonly LiveNote[]): Occurrence[] {
	const all: Occurrence[] = [];
	for (const note of notes)
		for (const [ordinal, block] of scanBlocksView(note.source).entries()) {
			if (block.id) all.push({ block: block.id, note, start: block.start, ordinal });
		}
	return all;
}

async function copyReferences(
	root: StoreRoot,
	record: NoteRecord | undefined,
	destination: NoteStore,
	events: readonly LedgerEvent[],
): Promise<void> {
	const hashes = new Set<string>();
	for (const event of events) if ("hash" in event && typeof event.hash === "string") hashes.add(event.hash);
	for (const hash of hashes) {
		const alias = record?.aliases[hash];
		const full = resolveObjectHash(hash, alias === undefined ? {} : { [hash]: alias });
		const body = await requireObject(root, full);
		// Full objects already live in the shared pool. Only a legacy note alias needs publication.
		if (hash !== full) await writeObject(destination, hash, body);
	}
}

/** Central records never move with a path hint and orphaned history is retained in place. */
export async function repair(plugin: MicaPlugin): Promise<RepairReport> {
	const root = storeRoot(plugin.app.vault);
	await validateStoreRoot(root);
	const notes = await gatherNotes(root);
	let records = await gatherRecords(root);
	for (const note of notes) {
		if (!note.id || records.has(note.id)) continue;
		if (root.vault.getAbstractFileByPath(notePaths(note.id, root.paths.root).ledger))
			throw new Error(`Mica: live note history lacks its manifest: ${note.file.path}`);
	}
	const initialOccurrences = occurrences(notes);
	const actions = reconcileIndexes(
		initialOccurrences.map((entry) => ({ block: entry.block, note: entry.note.file.path })),
		[...records.values()].flatMap((record) =>
			[...new Set(record.events.map((event) => event.block))].map((block) => ({ block, sidecar: record.dir })),
		),
	);
	const forked: RepairReport["forked"] = [];
	const byId = new Map<string, LiveNote[]>();
	for (const note of notes)
		if (note.id) {
			const group = byId.get(note.id) ?? [];
			group.push(note);
			byId.set(note.id, group);
		}

	// A copied note must receive its own ledger before any duplicate block repair can write.
	for (const [id, group] of byId) {
		if (group.length < 2) continue;
		const record = records.get(id);
		group.sort((left, right) => left.file.path.localeCompare(right.file.path));
		const keeper = group.find((note) => note.file.path === record?.pathHint) ?? group[0];
		for (const copy of group) {
			if (copy === keeper) continue;
			await plugin.engine.withFileLock(copy.file, async () => {
				const path = copy.file.path;
				const expected = copy.source;
				if ((await root.vault.read(copy.file)) !== expected)
					throw new Error("Mica: copied note changed during repair");
				const fresh = newId();
				const store = await stageNoteStore(root, copy.file, expected, fresh);
				const ids = new Map<string, string>();
				for (const event of record?.events ?? []) if (!ids.has(event.block)) ids.set(event.block, newId());
				const blocks = scanBlocksView(expected);
				for (const block of blocks) if (block.id && !ids.has(block.id)) ids.set(block.id, newId());
				let next = expected;
				for (let index = blocks.length - 1; index >= 0; index--) {
					const block = blocks[index];
					if (!block.id) continue;
					const replacement = ids.get(block.id)!;
					const edit = rewriteBlockIdAt(next, block.start, block.id, replacement);
					if (!edit) throw new Error("Mica: copied block changed during repair");
					next = applyBlockEdit(next, edit);
				}
				next = setNoteId(next, id, fresh);
				const cloned = remintOrderedLedgerEventIds(orderedLedgerEvents(record?.events ?? []), newId).map(
					(event) => ({ ...event, block: ids.get(event.block)! }),
				);
				await ensureSidecar(store);
				await copyReferences(root, record, store, cloned);
				const names: Record<string, string> = {};
				for (const block of scanBlocksView(next)) if (block.id) names[block.id] = block.name ?? "";
				// A failed publication leaves a named, recoverable orphan record rather than hidden history.
				await writeManifest(store, { noteId: fresh, path: copy.file.path, blocks: names, updated: Date.now() });
				await appendEvents(store, cloned);
				await validateStoreRoot(root);
				await root.vault.process(copy.file, (live) => {
					assertLiveNoteCurrent(root, copy.file, path);
					if (live !== expected)
						throw new Error("Mica: copied note changed before repaired identity could be published");
					return next;
				});
				copy.source = next;
				copy.id = fresh;
				copy.store = store;
				for (const block of blocks)
					if (block.id) forked.push({ block: block.id, note: copy.file.path, freshId: ids.get(block.id)! });
			});
		}
	}

	records = await gatherRecords(root);
	const byBlock = new Map<string, Occurrence[]>();
	for (const occurrence of occurrences(notes)) {
		const group = byBlock.get(occurrence.block) ?? [];
		group.push(occurrence);
		byBlock.set(occurrence.block, group);
	}
	for (const [block, group] of byBlock) {
		if (group.length < 2) continue;
		group.sort(
			(left, right) => left.note.file.path.localeCompare(right.note.file.path) || right.start - left.start,
		);
		let keeper = group[group.length - 1];
		let keeperHasHistory = false;
		for (const entry of group) {
			const hasHistory = Boolean(
				entry.note.id && records.get(entry.note.id)?.events.some((event) => event.block === block),
			);
			const order = entry.note.file.path.localeCompare(keeper.note.file.path) || entry.start - keeper.start;
			if ((hasHistory && !keeperHasHistory) || (hasHistory === keeperHasHistory && order < 0)) {
				keeper = entry;
				keeperHasHistory = hasHistory;
			}
		}
		const record = keeper.note.id ? records.get(keeper.note.id) : undefined;
		const events = orderedLedgerEvents(record?.events.filter((event) => event.block === block) ?? []);
		for (const occurrence of group) {
			if (occurrence === keeper) continue;
			await plugin.engine.withFileLock(occurrence.note.file, async () => {
				const path = occurrence.note.file.path;
				const live = await root.vault.read(occurrence.note.file);
				if (live !== occurrence.note.source) throw new Error("Mica: block changed during repair");
				const before = scanBlocksView(live);
				const at = occurrence.ordinal;
				if (before[at]?.id !== block) throw new Error("Mica: duplicate block disappeared during repair");
				const prepared = await ensureNoteStore(root, occurrence.note.file, live);
				const target = scanBlocksView(prepared.source)[at];
				if (!target) throw new Error("Mica: duplicate block disappeared while preparing identity");
				const fresh = newId();
				await ensureSidecar(prepared.store);
				await copyReferences(root, record, prepared.store, events);
				await appendEvents(
					prepared.store,
					remintOrderedLedgerEventIds(events, newId).map((event) => ({ ...event, block: fresh })),
				);
				await validateStoreRoot(root);
				const next = await root.vault.process(occurrence.note.file, (current) => {
					assertLiveNoteCurrent(root, occurrence.note.file, path);
					if (current !== prepared.source)
						throw new Error("Mica: duplicate block changed before publication");
					const edit = rewriteBlockIdAt(current, target.start, block, fresh);
					if (!edit) throw new Error("Mica: duplicate block changed before publication");
					return applyBlockEdit(current, edit);
				});
				occurrence.note.source = next;
				occurrence.note.id = prepared.store.noteId;
				occurrence.note.store = prepared.store;
				const names: Record<string, string> = {};
				for (const candidate of scanBlocksView(next))
					if (candidate.id) names[candidate.id] = candidate.name ?? "";
				await writeManifest(prepared.store, {
					noteId: prepared.store.noteId,
					path: occurrence.note.file.path,
					blocks: names,
					updated: Date.now(),
				});
				forked.push({ block, note: occurrence.note.file.path, freshId: fresh });
			});
		}
	}
	return { actions, rehomed: [], conflicted: [], forked, buried: [] };
}
