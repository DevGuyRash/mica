import { TFile, TFolder } from "obsidian";
import type MicaPlugin from "../main";
import { foldLedger, hasContent, hashContent, migrateTabs, newId, noteId, notePaths, resolveObjectHash, scanBlocksView, setNoteId, type LedgerEvent } from "../wasm/bridge";
import {
	appendEvents,
	ensureSidecar,
	ledgerAppendProvesNoCommit,
	readLedger,
	requireObject,
	writeManifest,
	writeObject,
} from "../storage/sidecar";
import { assertNoteStoreCurrent, bindNoteStore, isLiveNote, stageNoteStore, storeRoot, validateStoreRoot, type NoteStore } from "../storage/store";
import {
	classifyEventBatch,
	isLedgerEvent,
	isObjectHash,
	MAX_LEDGER_BYTES,
	MAX_LEDGER_LINE_BYTES,
	utf8ByteLength,
	validateEventBatch,
} from "../storage/ledger";

export interface MigrateFileReport {
	path: string;
	blocks: number;
	versionsImported: number;
	/** Content hash of the whole-note backup object (absent on dry run). */
	backup?: string;
	dryRun: boolean;
}

type MigrationLedgerEvent = Exclude<LedgerEvent, { type: "replace-version" }>;

interface MigrationJournal {
	readonly format: 1;
	readonly status: "pending" | "complete";
	readonly note: string;
	readonly original: string;
	readonly migrated: string;
	readonly events: readonly MigrationLedgerEvent[];
}

/**
 * Convert one note's legacy ` ```tabs ` blocks to Mica. Lossless and
 * recoverable: the original and fully finalized note are stored before the
 * live note changes, and a pending journal makes an ambiguous/partial ledger
 * append idempotently resumable. Returns null when there is nothing to do.
 */
export async function migrateFile(plugin: MicaPlugin, file: TFile, dryRun: boolean): Promise<MigrateFileReport | null> {
	const vault = plugin.app.vault;
	if (!isLiveNote(file)) throw new Error("Mica: stored history is not a live note to migrate");
	const root = storeRoot(vault);
	if (dryRun) {
		const result = migrateTabs(await vault.read(file), plugin.settings.versionCalloutTypes);
		if (!result.changed) return null;
		const versionsImported = result.blocks.reduce((n, block) => n + block.versions.length, 0);
		return { path: file.path, blocks: result.blocks.length, versionsImported, dryRun: true };
	}

	const migrated = await plugin.engine.withFileLock(file, async () => {
		const initial = await vault.read(file);
		const existingStore = await bindNoteStore(root, file, initial);
		const recoveryStore = existingStore ?? await findPendingMigrationStore(plugin, file, initial);
		const resumed = recoveryStore ? await resumePendingMigration(plugin, file, recoveryStore) : null;
		if (resumed) return resumed;

		let original = "";
		let result: ReturnType<typeof migrateTabs> | null = null;
		await vault.process(file, (current) => {
			original = current;
			result = migrateTabs(current, plugin.settings.versionCalloutTypes);
			return current;
		});
		const staged = result as ReturnType<typeof migrateTabs> | null;
		if (!staged?.changed) return null;

		const finalized = ensureMicaId(staged.doc);
		// Keep the exact original bytes recoverable before publishing the new anchor/body.
		const store = await stageNoteStore(root, file, original, finalized.id);
		await ensureSidecar(store);
		const originalHash = hashContent(original);
		const migratedHash = hashContent(finalized.doc);
		await writeObject(store, originalHash, original);
		await writeObject(store, migratedHash, finalized.doc);

		const importedEvents: MigrationLedgerEvent[] = [];
		const now = Date.now();
		for (const block of staged.blocks) {
			const n = block.versions.length;
			for (let i = 0; i < n; i++) {
				const version = block.versions[i];
				const hash = hashContent(version.content);
				await writeObject(store, hash, version.content);
				importedEvents.push({
					type: "add-version",
					eid: newId(),
					ts: Math.max(0, now - (n - i) * 1000),
					block: block.id,
					hash,
					label: version.label,
					origin: `migrated:${version.status}`,
				});
			}
		}
		const headEvents = await stageHeadEvents(store, finalized.doc);
		const events = [...importedEvents, ...headEvents];
		await validateMigrationAppend(store, events);
		const versionsImported = staged.blocks.reduce((n, block) => n + block.versions.length, 0);
		const journal: MigrationJournal = {
			format: 1,
			status: "pending",
			note: file.path,
			original: originalHash,
			migrated: migratedHash,
			events,
		};

		const names: Record<string, string> = {};
		for (const block of scanBlocksView(finalized.doc)) if (block.id) names[block.id] = block.name ?? "";
		await writeManifest(store, {
			noteId: finalized.id,
			path: file.path,
			blocks: names,
			updated: Date.now(),
		});
		await createPendingMigrationJournal(plugin, store, journal);

		await assertNoteStoreCurrent(store, true);
		let committed: string;
		try {
			committed = await vault.process(file, (current) => {
				if (current !== original)
					throw new Error(`Mica: ${file.path} changed while migration was staged; retry`);
				return finalized.doc;
			});
		} catch (error) {
			const current = await vault.read(file);
			if (current === original) {
				throw error;
			}
			if (current === finalized.doc) committed = current;
			else throw error; // Preserve the journal + both exact note objects.
		}

		if ((await vault.read(file)) !== committed) {
			throw new Error(`Mica: ${file.path} changed before imported history could be committed`);
		}
		try {
			await appendEvents(store, events);
		} catch (error) {
			if (ledgerAppendProvesNoCommit(error)) {
				await rollbackMigrationNote(plugin, file, committed, original);
				throw new Error(`Mica: migration history failed; ${file.path} was rolled back`, { cause: error });
			}
			// Partial/unknown means rollback is unsafe. The pending journal retains
			// the exact documents and eids so rerunning migration resumes append.
			throw error;
		}
		await completeMigrationJournal(plugin, store, journal);
		return { backup: originalHash, blocks: staged.blocks.length, versionsImported };
	});
	if (!migrated) return null;
	return { path: file.path, ...migrated, dryRun: false };
}

async function resumePendingMigration(
	plugin: MicaPlugin,
	file: TFile,
	store: NoteStore,
): Promise<{ backup: string; blocks: number; versionsImported: number } | null> {
	const journal = await readMigrationJournal(plugin, store);
	if (!journal || journal.status === "complete") return null;
	const vault = plugin.app.vault;
	const [original, migrated] = await Promise.all([
		requireObject(store, journal.original),
		requireObject(store, journal.migrated),
	]);
	const originalId = noteId(original);
	if ((originalId !== null && originalId !== store.noteId) || noteId(migrated) !== store.noteId)
		throw new Error("Mica: pending conversion objects do not belong to this note identity");
	const resumable = await ensureHeadEventsInJournal(plugin, store, journal, migrated);
	await validateMigrationAppend(store, resumable.events);
	let current = await vault.read(file);
	if (current === original) {
		await assertNoteStoreCurrent(store, true);
		current = await vault.process(file, (latest) => {
			if (latest !== original) throw new Error(`Mica: ${file.path} diverged while migration recovery was staged`);
			return migrated;
		});
	}
	if (current !== migrated) {
		throw new Error(
			`Mica: pending migration for ${file.path} cannot resume because the note differs from both journaled copies`,
		);
	}
	await appendEvents(store, resumable.events);
	await completeMigrationJournal(plugin, store, resumable);
	let versionsImported = 0;
	for (const event of resumable.events) {
		if (event.type === "add-version" && event.origin?.startsWith("migrated:")) versionsImported += 1;
	}
	let blocks = 0;
	for (const block of scanBlocksView(migrated)) {
		if (block.closed && block.id) blocks += 1;
	}
	return { backup: resumable.original, blocks, versionsImported };
}

/** Rust journals contain archive events only; plugin journals also stage the
 * migrated heads. Persist any missing head events before appending so either
 * host can resume the other's transaction with stable event ids. */
async function ensureHeadEventsInJournal(
	plugin: MicaPlugin,
	store: NoteStore,
	journal: MigrationJournal,
	migrated: string,
): Promise<MigrationJournal> {
	const existingHeads = new Set<string>();
	for (const event of journal.events) {
		if (event.type === "set-head") existingHeads.add(`${event.block}\0${resolveObjectHash(event.hash, store.aliases)}`);
	}
	const staged = await stageHeadEvents(store, migrated);
	const missing: MigrationLedgerEvent[] = [];
	for (let index = 0; index < staged.length; index += 2) {
		const add = staged[index];
		const head = staged[index + 1];
		if (!add || !head || head.type !== "set-head") continue;
		if (!existingHeads.has(`${head.block}\0${resolveObjectHash(head.hash, store.aliases)}`)) missing.push(add, head);
	}
	if (missing.length === 0) return journal;
	const updated: MigrationJournal = { ...journal, events: [...journal.events, ...missing] };
	await replaceMigrationJournal(plugin, store, journal, updated);
	return updated;
}

/** Validate the actual combined append before a journal can publish live bytes. */
async function validateMigrationAppend(store: NoteStore, events: readonly MigrationLedgerEvent[]): Promise<void> {
	const existing = await readLedger(store);
	const status = classifyEventBatch(existing, events);
	if (status.conflictEids.length) throw new Error("Mica: migration events conflict with recorded history");
	foldLedger([...existing, ...status.missing]);
}

async function stageHeadEvents(store: NoteStore, doc: string): Promise<MigrationLedgerEvent[]> {
	const events: MigrationLedgerEvent[] = [];
	const ts = Date.now();
	for (const block of scanBlocksView(doc)) {
		if (!block.closed || !block.id) continue;
		const content = doc.slice(block.content_start, block.content_end);
		if (!hasContent(content)) continue;
		const hash = hashContent(content);
		await writeObject(store, hash, content);
		events.push({ type: "add-version", eid: newId(), ts, block: block.id, hash });
		events.push({ type: "set-head", eid: newId(), ts, block: block.id, hash });
	}
	return events;
}

function migrationJournalPath(store: NoteStore): string {
	return store.paths.migration;
}

async function readMigrationJournal(plugin: MicaPlugin, store: NoteStore): Promise<MigrationJournal | null> {
	const path = migrationJournalPath(store);
	const af = plugin.app.vault.getAbstractFileByPath(path);
	if (!af) return null;
	if (!(af instanceof TFile)) throw new Error(`Mica: migration journal path is not a file: ${path}`);
	if (af.stat.size > MAX_LEDGER_BYTES) throw new Error(`Mica: migration journal exceeds ${MAX_LEDGER_BYTES} bytes`);
	const text = await plugin.app.vault.read(af);
	return parseMigrationJournal(text, path);
}

async function createPendingMigrationJournal(
	plugin: MicaPlugin,
	store: NoteStore,
	journal: MigrationJournal,
): Promise<void> {
	const path = migrationJournalPath(store);
	const body = encodeMigrationJournal(journal);
	await assertNoteStoreCurrent(store, true);
	const existing = plugin.app.vault.getAbstractFileByPath(path);
	if (existing) {
		if (!(existing instanceof TFile)) throw new Error(`Mica: migration journal path is not a file: ${path}`);
		await plugin.app.vault.process(existing, (current) => {
			const previous = parseMigrationJournal(current, path);
			if (previous.status === "pending") {
				throw new Error(`Mica: refusing to overwrite pending migration journal: ${path}`);
			}
			return body;
		});
		await verifyMigrationJournal(plugin, store, journal);
		return;
	}
	try {
		await plugin.app.vault.create(path, body);
	} catch (error) {
		if (plugin.app.vault.getAbstractFileByPath(path)) {
			throw new Error(`Mica: a pending migration journal appeared concurrently: ${path}`, { cause: error });
		}
		throw error;
	}
	await verifyMigrationJournal(plugin, store, journal);
}

function validateJournalEvents(events: readonly MigrationLedgerEvent[]): void {
	for (const event of events) {
		if (utf8ByteLength(JSON.stringify(event)) > MAX_LEDGER_LINE_BYTES) {
			throw new Error(`Mica: migration event exceeds ${MAX_LEDGER_LINE_BYTES} bytes`);
		}
	}
}

async function completeMigrationJournal(plugin: MicaPlugin, store: NoteStore, pending: MigrationJournal): Promise<void> {
	const complete: MigrationJournal = { ...pending, status: "complete" };
	await replaceMigrationJournal(plugin, store, pending, complete);
}

function isMigrationJournal(value: unknown): value is MigrationJournal {
	if (typeof value !== "object" || value === null) return false;
	const journal = value as Record<string, unknown>;
	return (
		journal.format === 1 &&
		(journal.status === "pending" || journal.status === "complete") &&
		typeof journal.note === "string" &&
		isObjectHash(journal.original) &&
		isObjectHash(journal.migrated) &&
		Array.isArray(journal.events) &&
		journal.events.every(isMigrationLedgerEvent)
	);
}

function isMigrationLedgerEvent(value: unknown): value is MigrationLedgerEvent {
	return isLedgerEvent(value) && value.type !== "replace-version";
}

function parseMigrationJournal(text: string, path: string): MigrationJournal {
	if (utf8ByteLength(text) > MAX_LEDGER_BYTES) {
		throw new Error(`Mica: migration journal exceeds ${MAX_LEDGER_BYTES} bytes`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Mica: invalid migration journal: ${path}`, { cause: error });
	}
	if (!isMigrationJournal(value)) throw new Error(`Mica: invalid migration journal: ${path}`);
	validateEventBatch(value.events);
	validateJournalEvents(value.events);
	return value;
}

function encodeMigrationJournal(journal: MigrationJournal): string {
	validateEventBatch(journal.events);
	validateJournalEvents(journal.events);
	const body = `${JSON.stringify(journal, null, "\t")}\n`;
	if (utf8ByteLength(body) > MAX_LEDGER_BYTES) {
		throw new Error(`Mica: migration journal exceeds ${MAX_LEDGER_BYTES} bytes`);
	}
	return body;
}

async function replaceMigrationJournal(
	plugin: MicaPlugin,
	store: NoteStore,
	expected: MigrationJournal,
	next: MigrationJournal,
): Promise<void> {
	const path = migrationJournalPath(store);
	const af = plugin.app.vault.getAbstractFileByPath(path);
	if (!(af instanceof TFile)) throw new Error(`Mica: migration journal is missing or not a file: ${path}`);
	const body = encodeMigrationJournal(next);
	await assertNoteStoreCurrent(store, true);
	await plugin.app.vault.process(af, (current) => {
		const actual = parseMigrationJournal(current, path);
		if (!sameMigrationJournal(actual, expected) && !sameMigrationJournal(actual, next)) {
			throw new Error(`Mica: migration journal changed concurrently: ${path}`);
		}
		return body;
	});
	await verifyMigrationJournal(plugin, store, next);
}

async function verifyMigrationJournal(plugin: MicaPlugin, store: NoteStore, expected: MigrationJournal): Promise<void> {
	const actual = await readMigrationJournal(plugin, store);
	if (!actual || !sameMigrationJournal(actual, expected)) {
		throw new Error(`Mica: migration journal write could not be verified: ${migrationJournalPath(store)}`);
	}
}

function sameMigrationJournal(left: MigrationJournal, right: MigrationJournal): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function rollbackMigrationNote(
	plugin: MicaPlugin,
	file: TFile,
	expectedMigrated: string,
	original: string,
): Promise<void> {
	await plugin.app.vault.process(file, (current) => {
		if (current !== expectedMigrated) throw new Error("the note changed again before migration rollback");
		return original;
	});
}

/** Insert only Mica's own frontmatter key while preserving the rest byte-for-
 * byte. Existing `uuid` and all unrelated keys remain untouched. */
function ensureMicaId(doc: string): { doc: string; id: string } {
	const existing = noteId(doc);
	if (existing !== null) return { doc, id: existing };
	const id = newId();
	return { doc: setNoteId(doc, null, id), id };
}

/** Resume the existing conversion transaction even if its staged anchor was
 * never published. This inspects central journals only; it imports no old layout. */
async function findPendingMigrationStore(plugin: MicaPlugin, file: TFile, source: string): Promise<NoteStore | null> {
	const root = storeRoot(plugin.app.vault);
	if (await validateStoreRoot(root) === null) return null;
	const notes = root.vault.getAbstractFileByPath(root.paths.notes);
	if (!notes) return null;
	if (!(notes instanceof TFolder)) throw new Error("Mica: central note records are not a folder");
	let match: NoteStore | null = null;
	for (const folder of notes.children) {
		if (!(folder instanceof TFolder)) continue;
		const manifest = root.vault.getAbstractFileByPath(`${folder.path}/manifest.json`);
		if (!manifest) continue;
		if (!(manifest instanceof TFile) || manifest.stat.size > MAX_LEDGER_BYTES)
			throw new Error("Mica: invalid central note manifest during conversion recovery");
		const value: unknown = JSON.parse(await root.vault.read(manifest));
		if (typeof value !== "object" || value === null || !("path" in value) || value.path !== file.path) continue;
		if (!("noteId" in value) || typeof value.noteId !== "string" || notePaths(value.noteId, root.paths.root).dir !== folder.path)
			throw new Error("Mica: central note identity does not match its directory");
		const candidate = await stageNoteStore(root, file, source, value.noteId);
		await assertNoteStoreCurrent(candidate);
		const journal = await readMigrationJournal(plugin, candidate);
		if (!journal || journal.status !== "pending") continue;
		if (await requireObject(candidate, journal.original) !== source) continue;
		if (match) throw new Error("Mica: multiple pending conversions match this note; no history was changed");
		match = candidate;
	}
	return match;
}

/** Migrate every markdown note in the vault (sidecars excluded). */
export async function migrateVault(plugin: MicaPlugin, dryRun: boolean): Promise<MigrateFileReport[]> {
	const reports: MigrateFileReport[] = [];
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (!isLiveNote(file)) continue;
		const report = await migrateFile(plugin, file, dryRun);
		if (report) reports.push(report);
	}
	return reports;
}
