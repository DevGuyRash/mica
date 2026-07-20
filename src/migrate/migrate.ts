import { TFile } from "obsidian";
import type MicaPlugin from "../main";
import { hasContent, hashContent, migrateTabs, newId, scanBlocksView, type LedgerEvent } from "../wasm/bridge";
import {
	appendEvents,
	ensureSidecar,
	ledgerAppendProvesNoCommit,
	requireObject,
	sidecarDir,
	writeManifest,
	writeObject,
} from "../storage/sidecar";
import {
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

interface MigrationJournal {
	readonly format: 1;
	readonly status: "pending" | "complete";
	readonly note: string;
	readonly original: string;
	readonly migrated: string;
	readonly events: readonly LedgerEvent[];
}

/**
 * Convert one note's legacy ` ```tabs ` blocks to Mica. Lossless and
 * recoverable: the original and fully finalized note are stored before the
 * live note changes, and a pending journal makes an ambiguous/partial ledger
 * append idempotently resumable. Returns null when there is nothing to do.
 */
export async function migrateFile(plugin: MicaPlugin, file: TFile, dryRun: boolean): Promise<MigrateFileReport | null> {
	const vault = plugin.app.vault;
	if (dryRun) {
		const result = migrateTabs(await vault.read(file), plugin.settings.versionCalloutTypes);
		if (!result.changed) return null;
		const versionsImported = result.blocks.reduce((n, block) => n + block.versions.length, 0);
		return { path: file.path, blocks: result.blocks.length, versionsImported, dryRun: true };
	}

	const migrated = await plugin.engine.withFileLock(file, async () => {
		const resumed = await resumePendingMigration(plugin, file);
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

		const existingNoteId = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.["mica-id"];
		const finalized = ensureMicaId(staged.doc, typeof existingNoteId === "string" ? existingNoteId : null);
		await ensureSidecar(vault, file);
		const originalHash = hashContent(original);
		const migratedHash = hashContent(finalized.doc);
		await writeObject(vault, file, originalHash, original);
		await writeObject(vault, file, migratedHash, finalized.doc);

		const importedEvents: LedgerEvent[] = [];
		const now = Date.now();
		for (const block of staged.blocks) {
			const n = block.versions.length;
			for (let i = 0; i < n; i++) {
				const version = block.versions[i];
				const hash = hashContent(version.content);
				await writeObject(vault, file, hash, version.content);
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
		const headEvents = await stageHeadEvents(plugin, file, finalized.doc);
		const events = [...importedEvents, ...headEvents];
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
		await writeManifest(vault, file, {
			noteId: finalized.id,
			path: file.path,
			blocks: names,
			updated: Date.now(),
		});
		await createPendingMigrationJournal(plugin, file, journal);

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
			await appendEvents(vault, file, events);
		} catch (error) {
			if (ledgerAppendProvesNoCommit(error)) {
				await rollbackMigrationNote(plugin, file, committed, original);
				throw new Error(`Mica: migration history failed; ${file.path} was rolled back`, { cause: error });
			}
			// Partial/unknown means rollback is unsafe. The pending journal retains
			// the exact documents and eids so rerunning migration resumes append.
			throw error;
		}
		await completeMigrationJournal(plugin, file, journal);
		return { backup: originalHash, blocks: staged.blocks.length, versionsImported };
	});
	if (!migrated) return null;
	return { path: file.path, ...migrated, dryRun: false };
}

async function resumePendingMigration(
	plugin: MicaPlugin,
	file: TFile,
): Promise<{ backup: string; blocks: number; versionsImported: number } | null> {
	const journal = await readMigrationJournal(plugin, file);
	if (!journal || journal.status === "complete") return null;
	const vault = plugin.app.vault;
	const [original, migrated] = await Promise.all([
		requireObject(vault, file, journal.original),
		requireObject(vault, file, journal.migrated),
	]);
	let current = await vault.read(file);
	if (current === original) {
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
	const resumable = await ensureHeadEventsInJournal(plugin, file, journal, migrated);
	await appendEvents(vault, file, resumable.events);
	await completeMigrationJournal(plugin, file, resumable);
	const versionsImported = resumable.events.filter(
		(event) => event.type === "add-version" && event.origin?.startsWith("migrated:"),
	).length;
	const blocks = scanBlocksView(migrated).filter((block) => block.closed && block.id).length;
	return { backup: resumable.original, blocks, versionsImported };
}

/** Rust journals contain archive events only; plugin journals also stage the
 * migrated heads. Persist any missing head events before appending so either
 * host can resume the other's transaction with stable event ids. */
async function ensureHeadEventsInJournal(
	plugin: MicaPlugin,
	file: TFile,
	journal: MigrationJournal,
	migrated: string,
): Promise<MigrationJournal> {
	const existingHeads = new Set(
		journal.events.filter((event) => event.type === "set-head").map((event) => `${event.block}\0${event.hash}`),
	);
	const staged = await stageHeadEvents(plugin, file, migrated);
	const missing: LedgerEvent[] = [];
	for (let index = 0; index < staged.length; index += 2) {
		const add = staged[index];
		const head = staged[index + 1];
		if (!add || !head || head.type !== "set-head") continue;
		if (!existingHeads.has(`${head.block}\0${head.hash}`)) missing.push(add, head);
	}
	if (missing.length === 0) return journal;
	const updated: MigrationJournal = { ...journal, events: [...journal.events, ...missing] };
	await replaceMigrationJournal(plugin, file, journal, updated);
	return updated;
}

async function stageHeadEvents(plugin: MicaPlugin, file: TFile, doc: string): Promise<LedgerEvent[]> {
	const events: LedgerEvent[] = [];
	const ts = Date.now();
	for (const block of scanBlocksView(doc)) {
		if (!block.closed || !block.id) continue;
		const content = doc.slice(block.content_start, block.content_end);
		if (!hasContent(content)) continue;
		const hash = hashContent(content);
		await writeObject(plugin.app.vault, file, hash, content);
		events.push({ type: "add-version", eid: newId(), ts, block: block.id, hash });
		events.push({ type: "set-head", eid: newId(), ts, block: block.id, hash });
	}
	return events;
}

function migrationJournalPath(file: TFile): string {
	return `${sidecarDir(file)}/migration.json`;
}

async function readMigrationJournal(plugin: MicaPlugin, file: TFile): Promise<MigrationJournal | null> {
	const path = migrationJournalPath(file);
	const af = plugin.app.vault.getAbstractFileByPath(path);
	if (!af) return null;
	if (!(af instanceof TFile)) throw new Error(`Mica: migration journal path is not a file: ${path}`);
	if (af.stat.size > MAX_LEDGER_BYTES) throw new Error(`Mica: migration journal exceeds ${MAX_LEDGER_BYTES} bytes`);
	const text = await plugin.app.vault.read(af);
	return parseMigrationJournal(text, path);
}

async function createPendingMigrationJournal(
	plugin: MicaPlugin,
	file: TFile,
	journal: MigrationJournal,
): Promise<void> {
	const path = migrationJournalPath(file);
	const body = encodeMigrationJournal(journal);
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
		await verifyMigrationJournal(plugin, file, journal);
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
	await verifyMigrationJournal(plugin, file, journal);
}

function validateJournalEvents(events: readonly LedgerEvent[]): void {
	for (const event of events) {
		if (utf8ByteLength(JSON.stringify(event)) > MAX_LEDGER_LINE_BYTES) {
			throw new Error(`Mica: migration event exceeds ${MAX_LEDGER_LINE_BYTES} bytes`);
		}
	}
}

async function completeMigrationJournal(plugin: MicaPlugin, file: TFile, pending: MigrationJournal): Promise<void> {
	const complete: MigrationJournal = { ...pending, status: "complete" };
	await replaceMigrationJournal(plugin, file, pending, complete);
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
		journal.events.every(isLedgerEvent)
	);
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
	file: TFile,
	expected: MigrationJournal,
	next: MigrationJournal,
): Promise<void> {
	const path = migrationJournalPath(file);
	const af = plugin.app.vault.getAbstractFileByPath(path);
	if (!(af instanceof TFile)) throw new Error(`Mica: migration journal is missing or not a file: ${path}`);
	const body = encodeMigrationJournal(next);
	await plugin.app.vault.process(af, (current) => {
		const actual = parseMigrationJournal(current, path);
		if (!sameMigrationJournal(actual, expected) && !sameMigrationJournal(actual, next)) {
			throw new Error(`Mica: migration journal changed concurrently: ${path}`);
		}
		return body;
	});
	await verifyMigrationJournal(plugin, file, next);
}

async function verifyMigrationJournal(plugin: MicaPlugin, file: TFile, expected: MigrationJournal): Promise<void> {
	const actual = await readMigrationJournal(plugin, file);
	if (!actual || !sameMigrationJournal(actual, expected)) {
		throw new Error(`Mica: migration journal write could not be verified: ${migrationJournalPath(file)}`);
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
function ensureMicaId(doc: string, cachedId: string | null): { doc: string; id: string } {
	if (cachedId) return { doc, id: cachedId };
	const id = newId();
	const bom = doc.startsWith("\uFEFF") ? "\uFEFF" : "";
	const body = bom ? doc.slice(1) : doc;
	const firstEol = body.indexOf("\n");
	const firstLine = body.slice(0, firstEol < 0 ? body.length : firstEol).replace(/\r$/, "");
	if (firstLine.trim() === "---" && firstEol >= 0) {
		const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
		closing.lastIndex = firstEol + 1;
		const close = closing.exec(body);
		if (close) {
			const frontmatter = body.slice(firstEol + 1, close.index);
			const key = /^mica-id[ \t]*:[ \t]*([^#\r\n]*?)(?:[ \t]+#.*)?$/m.exec(frontmatter);
			if (key) {
				const current = key[1].trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2");
				if (current) return { doc, id: current };
				const valueStart = firstEol + 1 + (key.index ?? 0) + key[0].indexOf(":") + 1;
				const valueEnd = firstEol + 1 + (key.index ?? 0) + key[0].length;
				return { doc: `${bom}${body.slice(0, valueStart)} ${id}${body.slice(valueEnd)}`, id };
			}
			const eol = body.slice(Math.max(0, close.index - 2), close.index).endsWith("\r\n") ? "\r\n" : "\n";
			return { doc: `${bom}${body.slice(0, close.index)}mica-id: ${id}${eol}${body.slice(close.index)}`, id };
		}
	}
	const eol = body.includes("\r\n") ? "\r\n" : "\n";
	return { doc: `${bom}---${eol}mica-id: ${id}${eol}---${eol}${body}`, id };
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
