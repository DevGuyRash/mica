import { TFile, type Vault } from "obsidian";
import { Gunzip, gzip, strFromU8, strToU8 } from "fflate";
import { hashContent, objectPaths, resolveObjectHash, type LedgerEvent } from "../wasm/bridge";
import {
	assertNoteStoreCurrent,
	assertStoreRootCurrent,
	ensureStoreFolder,
	MAX_ALIASES,
	MAX_ALIAS_BYTES,
	parseAliases,
	readAliases,
	validateStoreRoot,
	type NoteStore,
	type StoreRoot,
} from "./store";
import {
	classifyEventBatch,
	MAX_LEDGER_BYTES,
	MAX_LEDGER_EVENTS,
	MAX_LEDGER_LINE_BYTES,
	parseLedgerDocument,
	utf8ByteLength,
	validateEventBatch,
} from "./ledger";

// Ledgers belong to stable note identities; immutable full-hash objects belong to the vault.
export function sidecarDir(note: NoteStore): string {
	return note.paths.dir;
}
export function objectsDir(root: StoreRoot): string {
	return root.paths.objects;
}
export function ledgerPath(note: NoteStore): string {
	return note.paths.ledger;
}
export function objectPath(root: StoreRoot, hash: string): string {
	assertStoreRootCurrent(root);
	return objectPaths(hash, root.paths.root).plain;
}
export function objectPathGz(root: StoreRoot, hash: string): string {
	assertStoreRootCurrent(root);
	return objectPaths(hash, root.paths.root).gzip;
}
function rootOf(store: StoreRoot | NoteStore): StoreRoot {
	return "root" in store ? store.root : store;
}
function fullHash(store: StoreRoot | NoteStore, hash: string): string {
	const alias = "aliases" in store ? store.aliases[hash] : undefined;
	return resolveObjectHash(hash, alias === undefined ? {} : { [hash]: alias });
}

/** Objects at or under this size stay human-readable plaintext .md. The rule
 *  is shared with the mica CLI — both sides read either form. */
export const COMPRESS_MIN_BYTES = 4096;
/** Refuse decompression bombs while remaining far above a practical block size. */
export const MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_OBJECT_BYTES = MAX_OBJECT_BYTES + 1024 * 1024;

async function runGzip(text: string): Promise<ArrayBuffer> {
	if (typeof CompressionStream === "function") {
		const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
		return new Response(stream).arrayBuffer();
	}
	return new Promise((resolve, reject) => {
		gzip(strToU8(text), (error, bytes) => {
			if (error) reject(error);
			else resolve(bytes.slice().buffer);
		});
	});
}

interface CompressionJob {
	readonly text: string;
	readonly bytes: number;
	readonly resolve: (value: ArrayBuffer) => void;
	readonly reject: (error: unknown) => void;
}
const MAX_COMPRESSION_QUEUE = 8;
const compressionQueue: CompressionJob[] = [];
let compressionActive = false;
let compressionQueuedBytes = 0;

function gzipText(text: string, bytes: number): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const job = { text, bytes, resolve, reject };
		if (!compressionActive) startCompression(job);
		else {
			if (compressionQueue.length >= MAX_COMPRESSION_QUEUE || compressionQueuedBytes + bytes > MAX_OBJECT_BYTES) {
				reject(new Error("Mica: history compression is busy; retry after current writes settle"));
				return;
			}
			compressionQueue.push(job);
			compressionQueuedBytes += bytes;
		}
	});
}

function startCompression(job: CompressionJob): void {
	compressionActive = true;
	void (async () => {
		try {
			job.resolve(await runGzip(job.text));
		} catch (error) {
			job.reject(error);
		} finally {
			compressionActive = false;
			const next = compressionQueue.shift();
			if (next) {
				compressionQueuedBytes -= next.bytes;
				startCompression(next);
			}
		}
	})();
}

async function gunzipToText(buf: ArrayBuffer): Promise<string> {
	if (typeof DecompressionStream === "function") {
		const stream = new Blob([buf]).stream().pipeThrough<Uint8Array>(new DecompressionStream("gzip"));
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_OBJECT_BYTES) {
				await reader.cancel();
				throw new Error(`Mica: decompressed history object exceeds ${MAX_OBJECT_BYTES} bytes`);
			}
			chunks.push(value);
		}
		return strFromU8(joinChunks(chunks, size));
	}

	// Portable fallback for older mobile WebViews. Stream output through a cap
	// rather than calling gunzipSync, which would allocate a decompression bomb.
	const chunks: Uint8Array[] = [];
	let size = 0;
	const gunzip = new Gunzip((chunk: Uint8Array) => {
		size += chunk.byteLength;
		if (size > MAX_OBJECT_BYTES)
			throw new Error(`Mica: decompressed history object exceeds ${MAX_OBJECT_BYTES} bytes`);
		chunks.push(chunk);
	});
	gunzip.push(new Uint8Array(buf), true);
	return strFromU8(joinChunks(chunks, size));
}

function joinChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function ensureSidecar(note: NoteStore): Promise<void> {
	await assertNoteStoreCurrent(note, true);
	for (const dir of [note.root.paths.objects, note.root.paths.notes, note.paths.dir])
		await ensureStoreFolder(note.root, dir);
}

const objectWrites = new WeakMap<Vault, Map<string, Promise<string>>>();

async function assertObjectWriteCurrent(store: StoreRoot | NoteStore, storeId: string): Promise<void> {
	if ("aliases" in store) await assertNoteStoreCurrent(store);
	if ((await validateStoreRoot(rootOf(store))) !== storeId)
		throw new Error("Mica: central store identity changed during object write; retry");
}

/** Fixed representation and per-hash serialization prevent cross-note compression races. */
export async function writeObject(store: StoreRoot | NoteStore, hash: string, content: string): Promise<void> {
	const root = rootOf(store);
	const actual = hashContent(content);
	if (resolveObjectHash(hash, hash.length === 19 ? { [hash]: actual } : {}) !== actual)
		throw new Error(`Mica: object hash mismatch (expected ${hash}, got ${actual})`);
	if (hash.length === 19 && !("aliases" in store)) throw new Error("Mica: legacy hash requires a note store");
	const byteLength = utf8ByteLength(content);
	if (byteLength > MAX_OBJECT_BYTES)
		throw new Error(`Mica: history object ${hash} exceeds ${MAX_OBJECT_BYTES} bytes`);
	if ("aliases" in store) await assertNoteStoreCurrent(store);
	const storeId = await validateStoreRoot(root, true);
	if (storeId === null) throw new Error("Mica: central store could not be initialized");
	if ("aliases" in store && store.storeId !== null && store.storeId !== storeId)
		throw new Error("Mica: central store identity changed before object write; retry");
	// A read handle may predate first initialization; pin its write view for every later guard.
	const operationStore = "aliases" in store && store.storeId === null ? { ...store, storeId } : store;
	await assertObjectWriteCurrent(operationStore, storeId);
	const writes = objectWrites.get(root.vault) ?? new Map<string, Promise<string>>();
	objectWrites.set(root.vault, writes);
	let task = writes.get(actual);
	if (!task) {
		const write = (async () => {
			await assertObjectWriteCurrent(operationStore, storeId);
			await ensureStoreFolder(root, root.paths.objects);
			const paths = objectPaths(actual, root.paths.root);
			if (!resolveObjectFile(root.vault, paths.plain, paths.gzip)) {
				const compressed = byteLength > COMPRESS_MIN_BYTES ? await gzipText(content, byteLength) : null;
				// Compression may wait in the bounded queue; no source/root guard survives that await.
				await assertObjectWriteCurrent(operationStore, storeId);
				if (!resolveObjectFile(root.vault, paths.plain, paths.gzip)) {
					try {
						assertStoreRootCurrent(root);
						if (compressed === null) await root.vault.create(paths.plain, content);
						else await root.vault.createBinary(paths.gzip, compressed);
					} catch (error) {
						if (!resolveObjectFile(root.vault, paths.plain, paths.gzip)) throw error;
					}
				}
			}
			await requireObject(root, actual);
			await assertObjectWriteCurrent(operationStore, storeId);
			return storeId;
		})().finally(() => {
			if (writes.get(actual) === write) writes.delete(actual);
		});
		writes.set(actual, write);
		task = write;
	}
	if ((await task) !== storeId)
		throw new Error("Mica: shared object write belonged to a different central store; retry");
	await assertObjectWriteCurrent(operationStore, storeId);
	if (hash.length === 19 && "aliases" in operationStore) {
		await publishAlias(operationStore, hash, actual);
		await assertObjectWriteCurrent(operationStore, storeId);
	}
}

async function publishAlias(note: NoteStore, short: string, full: string): Promise<void> {
	await ensureSidecar(note);
	const merge = (text: string): string => {
		const aliases = text ? parseAliases(text) : {};
		if (aliases[short] !== undefined && aliases[short] !== full)
			throw new Error(`Mica: conflicting object alias ${short}`);
		aliases[short] = full;
		if (Object.keys(aliases).length > MAX_ALIASES) throw new Error("Mica: too many object aliases");
		const body = JSON.stringify(aliases, null, "\t") + "\n";
		if (utf8ByteLength(body) > MAX_ALIAS_BYTES) throw new Error("Mica: alias document is too large");
		return body;
	};
	await assertNoteStoreCurrent(note, true);
	const file = note.root.vault.getAbstractFileByPath(note.paths.aliases);
	if (file instanceof TFile)
		await note.root.vault.process(file, (current) => {
			assertStoreRootCurrent(note.root);
			return merge(current);
		});
	else {
		if (file) throw new Error("Mica: alias path is not a file");
		try {
			assertStoreRootCurrent(note.root);
			await note.root.vault.create(note.paths.aliases, merge(""));
		} catch (error) {
			const raced = note.root.vault.getAbstractFileByPath(note.paths.aliases);
			if (!(raced instanceof TFile)) throw error;
			await assertNoteStoreCurrent(note, true);
			await note.root.vault.process(raced, (current) => {
				assertStoreRootCurrent(note.root);
				return merge(current);
			});
		}
	}
	Object.assign(note.aliases, await readAliases(note.root, note.paths.aliases));
}

function resolveObjectFile(vault: Vault, plainPath: string, gzPath: string): TFile | null {
	const plain = vault.getAbstractFileByPath(plainPath);
	const gz = vault.getAbstractFileByPath(gzPath);
	if (plain && !(plain instanceof TFile)) throw new Error(`Mica: history object path is not a file: ${plainPath}`);
	if (gz && !(gz instanceof TFile)) throw new Error(`Mica: history object path is not a file: ${gzPath}`);
	if (plain instanceof TFile && gz instanceof TFile) {
		throw new Error(`Mica: history object has both plaintext and compressed forms: ${plainPath}`);
	}
	return plain instanceof TFile ? plain : gz instanceof TFile ? gz : null;
}

export async function readObject(store: StoreRoot | NoteStore, hash: string): Promise<string | null> {
	const root = rootOf(store);
	if ((await validateStoreRoot(root)) === null) return null;
	const vault = root.vault;
	const resolvedHash = fullHash(store, hash);
	const plainPath = objectPath(root, resolvedHash);
	const gzPath = objectPathGz(root, resolvedHash);
	const object = resolveObjectFile(vault, plainPath, gzPath);
	if (!object) return null;
	let content: string;
	if (object.path === plainPath) {
		if (object.stat.size > MAX_OBJECT_BYTES) {
			throw new Error(`Mica: history object ${hash} exceeds ${MAX_OBJECT_BYTES} bytes`);
		}
		content = await vault.read(object);
		if (utf8ByteLength(content) > MAX_OBJECT_BYTES)
			throw new Error(`Mica: history object ${hash} exceeds ${MAX_OBJECT_BYTES} bytes`);
		verifyObject(resolvedHash, content);
		return content;
	}
	if (object.stat.size > MAX_COMPRESSED_OBJECT_BYTES) {
		throw new Error(`Mica: compressed history object ${hash} exceeds ${MAX_COMPRESSED_OBJECT_BYTES} bytes`);
	}
	content = await gunzipToText(await vault.readBinary(object));
	verifyObject(resolvedHash, content);
	return content;
}

/** Read a referenced object or surface the integrity failure explicitly. */
export async function requireObject(store: StoreRoot | NoteStore, hash: string): Promise<string> {
	const content = await readObject(store, hash);
	if (content === null) throw new Error(`Mica: missing history object ${hash}`);
	return content;
}

function verifyObject(expected: string, content: string): void {
	const actual = hashContent(content);
	if (expected !== actual) {
		throw new Error(`Mica: corrupt history object ${expected} (content hashes to ${actual})`);
	}
}

interface LedgerCacheEntry {
	readonly vault: Vault;
	readonly file: TFile;
	readonly path: string;
	readonly mtime: number;
	readonly size: number;
	readonly expiresAt: number;
	readonly events: LedgerEvent[];
}

// A single derived entry accelerates repeat UI/state reads without retaining a
// vault-sized mirror. The JSONL file remains the sole authority, and every
// append invalidates this entry before and after I/O.
let ledgerCache: LedgerCacheEntry | null = null;
const LEDGER_CACHE_TTL_MS = 5000;

export async function readEventsAt(root: StoreRoot, path: string): Promise<LedgerEvent[]> {
	if ((await validateStoreRoot(root)) === null) return [];
	const vault = root.vault;
	const af = vault.getAbstractFileByPath(path);
	if (!af) return [];
	if (!(af instanceof TFile)) throw new Error(`Mica: ledger path is not a file: ${path}`);
	if (
		ledgerCache?.vault === vault &&
		ledgerCache.file === af &&
		ledgerCache.path === path &&
		ledgerCache.mtime === af.stat.mtime &&
		ledgerCache.size === af.stat.size &&
		ledgerCache.expiresAt >= Date.now()
	) {
		return ledgerCache.events;
	}
	const snapshot = await readLedgerSnapshot(vault, path);
	if (!snapshot.file) return [];
	ledgerCache = {
		vault,
		file: snapshot.file,
		path,
		mtime: snapshot.file.stat.mtime,
		size: snapshot.file.stat.size,
		expiresAt: Date.now() + LEDGER_CACHE_TTL_MS,
		events: snapshot.events,
	};
	return snapshot.events;
}

interface LedgerSnapshot {
	readonly file: TFile | null;
	readonly text: string;
	readonly events: LedgerEvent[];
	readonly recordCount: number;
	readonly byteLength: number;
}

async function readLedgerSnapshot(vault: Vault, path: string): Promise<LedgerSnapshot> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const af = vault.getAbstractFileByPath(path);
		if (!af) return { file: null, text: "", events: [], recordCount: 0, byteLength: 0 };
		if (!(af instanceof TFile)) throw new Error(`Mica: ledger path is not a file: ${path}`);
		if (af.stat.size > MAX_LEDGER_BYTES) {
			throw new Error(`Mica: ledger exceeds ${MAX_LEDGER_BYTES} bytes: ${path}`);
		}
		const beforeMtime = af.stat.mtime;
		const beforeSize = af.stat.size;
		const text = await vault.read(af);
		const byteLength = utf8ByteLength(text);
		if (byteLength > MAX_LEDGER_BYTES) {
			throw new Error(`Mica: ledger exceeds ${MAX_LEDGER_BYTES} bytes: ${path}`);
		}
		if (af.stat.mtime !== beforeMtime || af.stat.size !== beforeSize) continue;
		const parsed = parseLedgerDocument(text);
		return { file: af, text, events: parsed.events, recordCount: parsed.recordCount, byteLength };
	}
	throw new Error(`Mica: ledger kept changing while being read: ${path}`);
}

export async function readLedger(note: NoteStore): Promise<LedgerEvent[]> {
	return readEventsAt(note.root, ledgerPath(note));
}

/** Human/tool-readable sidecar summary: note anchor, path hint, block names. */
export interface SidecarManifest {
	noteId: string | null;
	path: string;
	blocks: Record<string, string>;
	updated: number;
}

export async function writeManifest(note: NoteStore, manifest: SidecarManifest): Promise<boolean> {
	if (manifest.noteId !== note.noteId) throw new Error("Mica: manifest identity does not match its note store");
	const body = JSON.stringify(manifest, null, "\t") + "\n";
	if (utf8ByteLength(body) > MAX_LEDGER_BYTES) throw new Error("Mica: note manifest is too large");
	await ensureSidecar(note);
	const vault = note.root.vault;
	const path = note.paths.manifest;
	const af = vault.getAbstractFileByPath(path);
	if (af instanceof TFile) {
		// `updated` describes the last semantic manifest change, not the last
		// snapshot attempt. Avoid rewriting the summary (and waking Sync) when its
		// note anchor, path, block order, and names are already current.
		if (af.stat.size > MAX_LEDGER_BYTES) throw new Error("Mica: note manifest is too large");
		const existing = await vault.read(af);
		assertManifestOwner(existing, note.noteId);
		if (sameManifest(existing, manifest)) return false;
		await assertNoteStoreCurrent(note, true);
		await vault.process(af, (current) => {
			assertStoreRootCurrent(note.root);
			if (current !== existing) throw new Error("Mica: note manifest changed before publication; retry");
			return body;
		});
		return true;
	}
	try {
		await assertNoteStoreCurrent(note, true);
		assertStoreRootCurrent(note.root);
		await vault.create(path, body);
		return true;
	} catch (error) {
		const raced = vault.getAbstractFileByPath(path);
		if (!(raced instanceof TFile)) throw error;
		if (raced.stat.size > MAX_LEDGER_BYTES) throw new Error("Mica: note manifest is too large");
		const existing = await vault.read(raced);
		assertManifestOwner(existing, note.noteId);
		if (sameManifest(existing, manifest)) return false;
		await assertNoteStoreCurrent(note, true);
		await vault.process(raced, (current) => {
			assertStoreRootCurrent(note.root);
			if (current !== existing) throw new Error("Mica: note manifest changed before publication; retry");
			return body;
		});
		return true;
	}
}

function assertManifestOwner(text: string, id: string): void {
	if (utf8ByteLength(text) > MAX_LEDGER_BYTES) throw new Error("Mica: note manifest is too large");
	const value: unknown = JSON.parse(text);
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		!("noteId" in value) ||
		value.noteId !== id
	)
		throw new Error("Mica: existing manifest has a conflicting note identity");
	if (Object.keys(value).some((key) => !["noteId", "path", "blocks", "updated"].includes(key)))
		throw new Error("Mica: existing manifest has unknown fields; history was left unchanged");
}

function sameManifest(text: string, expected: SidecarManifest): boolean {
	try {
		const value = JSON.parse(text) as Partial<SidecarManifest>;
		return (
			value.noteId === expected.noteId &&
			value.path === expected.path &&
			sameOrderedStringRecord(value.blocks, expected.blocks)
		);
	} catch {
		return false;
	}
}

function sameOrderedStringRecord(actual: unknown, expected: Readonly<Record<string, string>>): boolean {
	if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
	const actualRecord = actual as Record<string, unknown>;
	const actualKeys = Object.keys(actualRecord);
	const expectedKeys = Object.keys(expected);
	if (actualKeys.length !== expectedKeys.length) return false;
	for (let index = 0; index < actualKeys.length; index++) {
		const key = actualKeys[index];
		if (key !== expectedKeys[index] || actualRecord[key] !== expected[key]) return false;
	}
	return true;
}

export type LedgerCommitState = "none" | "partial" | "unknown" | "conflict";

/** An append failure carries the only fact a caller may use to decide whether
 * rolling live content back is safe. `none` means a verified read found no
 * intended eid after all write/recovery attempts. */
export class LedgerAppendError extends Error {
	constructor(
		message: string,
		readonly commitState: LedgerCommitState,
		readonly presentEids: readonly string[],
		readonly intendedEids: readonly string[],
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "LedgerAppendError";
	}
}

export function ledgerAppendProvesNoCommit(error: unknown): boolean {
	return error instanceof LedgerAppendError && error.commitState === "none";
}

export async function appendEvents(note: NoteStore, events: readonly LedgerEvent[]): Promise<void> {
	const vault = note.root.vault;
	if (!events.length) return;
	validateEventBatch(events);
	encodeEventLines(events); // Fail before any I/O when one record is not recoverable.
	const path = ledgerPath(note);
	const intendedEids = events.map((event) => event.eid);
	let wroteOrAttempted = false;
	let lastError: unknown;
	let lastPresent: readonly LedgerEvent[] = [];

	// Each pass re-reads authoritative JSONL, verifies by eid and appends only
	// missing records. This recovers create races, ambiguous adapter failures,
	// and even a partial write without duplicating committed logical events.
	for (let attempt = 0; attempt < 3; attempt++) {
		let snapshot: LedgerSnapshot;
		try {
			snapshot = await readLedgerSnapshot(vault, path);
		} catch (error) {
			lastError = error;
			if (!wroteOrAttempted) {
				throw new LedgerAppendError(
					`Mica: ledger could not be read before append: ${path}`,
					"none",
					[],
					intendedEids,
					{ cause: error },
				);
			}
			continue;
		}
		const status = classifyEventBatch(snapshot.events, events);
		lastPresent = status.present;
		if (status.conflictEids.length) {
			throw new LedgerAppendError(
				`Mica: ledger already contains conflicting eid(s): ${status.conflictEids.join(", ")}`,
				"conflict",
				status.present.map((event) => event.eid),
				intendedEids,
			);
		}
		if (!status.missing.length) {
			if (snapshot.file) {
				ledgerCache = {
					vault,
					file: snapshot.file,
					path,
					mtime: snapshot.file.stat.mtime,
					size: snapshot.file.stat.size,
					expiresAt: Date.now() + LEDGER_CACHE_TTL_MS,
					events: snapshot.events,
				};
			}
			return;
		}
		if (snapshot.recordCount + status.missing.length > MAX_LEDGER_EVENTS) {
			throw new LedgerAppendError(
				`Mica: ledger append would exceed ${MAX_LEDGER_EVENTS} events`,
				status.present.length ? "partial" : "none",
				status.present.map((event) => event.eid),
				intendedEids,
			);
		}
		const body = encodeEventLines(status.missing);
		const separator = snapshot.text.length > 0 && !snapshot.text.endsWith("\n") ? "\n" : "";
		if (snapshot.byteLength + utf8ByteLength(separator + body) > MAX_LEDGER_BYTES) {
			throw new LedgerAppendError(
				`Mica: ledger append would exceed ${MAX_LEDGER_BYTES} bytes`,
				status.present.length ? "partial" : "none",
				status.present.map((event) => event.eid),
				intendedEids,
			);
		}
		ledgerCache = null;
		wroteOrAttempted = true;
		try {
			await assertNoteStoreCurrent(note, true);
			assertStoreRootCurrent(note.root);
			if (snapshot.file) await vault.append(snapshot.file, separator + body);
			else await vault.create(path, body);
		} catch (error) {
			// The adapter may have committed before rejecting, or another writer may
			// have won a create race. Only the next verified read decides.
			lastError = error;
		}
		ledgerCache = null;
	}

	// One final read classifies the ambiguity for callers. Never claim `none`
	// merely because the adapter threw: only an authoritative post-write read is
	// sufficient evidence for a rollback.
	try {
		const snapshot = await readLedgerSnapshot(vault, path);
		const status = classifyEventBatch(snapshot.events, events);
		if (status.conflictEids.length) {
			throw new LedgerAppendError(
				`Mica: ledger append ended with conflicting eid(s): ${status.conflictEids.join(", ")}`,
				"conflict",
				status.present.map((event) => event.eid),
				intendedEids,
				{ cause: lastError },
			);
		}
		if (!status.missing.length) return;
		throw new LedgerAppendError(
			`Mica: ledger append could not commit ${status.missing.length} event(s) after recovery`,
			status.present.length ? "partial" : "none",
			status.present.map((event) => event.eid),
			intendedEids,
			{ cause: lastError },
		);
	} catch (error) {
		if (error instanceof LedgerAppendError) throw error;
		throw new LedgerAppendError(
			"Mica: ledger append outcome could not be verified; live content was not rolled back",
			"unknown",
			lastPresent.map((event) => event.eid),
			intendedEids,
			{ cause: error },
		);
	}
}

function encodeEventLines(events: readonly LedgerEvent[]): string {
	const lines = events.map((event) => JSON.stringify(event));
	for (const line of lines) {
		if (utf8ByteLength(line) > MAX_LEDGER_LINE_BYTES) {
			throw new Error(`Mica: ledger event exceeds ${MAX_LEDGER_LINE_BYTES} bytes`);
		}
	}
	return `${lines.join("\n")}\n`;
}
