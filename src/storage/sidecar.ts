import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import { Gunzip, strFromU8 } from "fflate";
import { hashContent, type LedgerEvent } from "../wasm/bridge";
import {
	classifyEventBatch,
	isObjectHash,
	MAX_LEDGER_BYTES,
	MAX_LEDGER_EVENTS,
	MAX_LEDGER_LINE_BYTES,
	parseLedgerDocument,
	utf8ByteLength,
	validateEventBatch,
} from "./ledger";

// A note's history lives in a *visible*, co-located sidecar folder, so it rides
// the normal Vault API + Obsidian Sync and stays human-readable. Version objects
// are content-addressed and immutable; the ledger is append-only.

export function sidecarDir(file: TFile): string {
	const base = file.path.slice(0, file.path.length - file.extension.length - 1);
	return normalizePath(`${base}.mica`);
}

export function objectsDir(file: TFile): string {
	return `${sidecarDir(file)}/objects`;
}

export function ledgerPath(file: TFile): string {
	return `${sidecarDir(file)}/ledger.jsonl`;
}

export function objectPath(file: TFile, hash: string): string {
	return `${objectsDir(file)}/${objectName(hash)}.mica.md`;
}

/** Compressed variant (large objects only). Hash stays over the PLAINTEXT. */
export function objectPathGz(file: TFile, hash: string): string {
	return `${objectsDir(file)}/${objectName(hash)}.mica.gz`;
}

function objectName(hash: string): string {
	if (!isObjectHash(hash)) {
		throw new Error(`Mica: invalid object hash ${JSON.stringify(hash)}`);
	}
	const name = hash.replace(":", "-");
	return name;
}

/** Objects at or under this size stay human-readable plaintext .md. The rule
 *  is shared with the mica CLI — both sides read either form. */
export const COMPRESS_MIN_BYTES = 4096;
/** Refuse decompression bombs while remaining far above a practical block size. */
export const MAX_OBJECT_BYTES = 128 * 1024 * 1024;
const MAX_COMPRESSED_OBJECT_BYTES = MAX_OBJECT_BYTES + 1024 * 1024;

async function gzipText(text: string): Promise<ArrayBuffer | null> {
	if (typeof CompressionStream !== "function") return null;
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
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

export async function ensureSidecar(vault: Vault, file: TFile): Promise<void> {
	for (const dir of [sidecarDir(file), objectsDir(file)]) {
		const current = vault.getAbstractFileByPath(dir);
		if (current instanceof TFolder) continue;
		if (current) throw new Error(`Mica: sidecar path is not a folder: ${dir}`);
		try {
			await vault.createFolder(dir);
		} catch (error) {
			// A concurrent creator is harmless; every other failure is real.
			if (!(vault.getAbstractFileByPath(dir) instanceof TFolder)) throw error;
		}
	}
}

/** Content-addressed write: objects are immutable, so an existing hash is a
 *  no-op. Small objects stay human-readable plaintext; large ones gzip when
 *  the host WebView supports compression and otherwise remain plaintext. */
export async function writeObject(vault: Vault, file: TFile, hash: string, content: string): Promise<void> {
	const actual = hashContent(content);
	if (!hashMatches(hash, actual)) throw new Error(`Mica: object hash mismatch (expected ${hash}, got ${actual})`);
	const byteLength = utf8ByteLength(content);
	if (byteLength > MAX_OBJECT_BYTES)
		throw new Error(`Mica: history object ${hash} exceeds ${MAX_OBJECT_BYTES} bytes`);
	const plain = objectPath(file, hash);
	const gz = objectPathGz(file, hash);
	if (resolveObjectFile(vault, plain, gz)) {
		await requireObject(vault, file, hash); // Never bless an existing corrupt object.
		return;
	}
	try {
		if (byteLength <= COMPRESS_MIN_BYTES || typeof CompressionStream !== "function") {
			await vault.create(plain, content);
		} else {
			const bytes = await gzipText(content);
			if (bytes === null) {
				await vault.create(plain, content);
			} else await vault.createBinary(gz, bytes);
		}
	} catch (error) {
		// Content addressing makes a same-hash create race a successful no-op.
		if (!resolveObjectFile(vault, plain, gz)) throw error;
	}
	// Verify our own successful write too: storage adapters can resolve a create
	// after a short/altered write, and immutable corruption must never reach the
	// authoritative ledger.
	await requireObject(vault, file, hash);
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

export async function readObject(vault: Vault, file: TFile, hash: string): Promise<string | null> {
	const plainPath = objectPath(file, hash);
	const gzPath = objectPathGz(file, hash);
	const object = resolveObjectFile(vault, plainPath, gzPath);
	if (!object) return null;
	let content: string;
	if (object.path === plainPath) {
		if (object.stat.size > MAX_OBJECT_BYTES) {
			throw new Error(`Mica: history object ${hash} exceeds ${MAX_OBJECT_BYTES} bytes`);
		}
		content = await vault.read(object);
		verifyObject(hash, content);
		return content;
	}
	if (object.stat.size > MAX_COMPRESSED_OBJECT_BYTES) {
		throw new Error(`Mica: compressed history object ${hash} exceeds ${MAX_COMPRESSED_OBJECT_BYTES} bytes`);
	}
	content = await gunzipToText(await vault.readBinary(object));
	verifyObject(hash, content);
	return content;
}

/** Read a referenced object or surface the integrity failure explicitly. */
export async function requireObject(vault: Vault, file: TFile, hash: string): Promise<string> {
	const content = await readObject(vault, file, hash);
	if (content === null) throw new Error(`Mica: missing history object ${hash} for ${file.path}`);
	return content;
}

function verifyObject(expected: string, content: string): void {
	const actual = hashContent(content);
	if (!hashMatches(expected, actual)) {
		throw new Error(`Mica: corrupt history object ${expected} (content hashes to ${actual})`);
	}
}

function hashMatches(expected: string, actual: string): boolean {
	if (!isObjectHash(expected) || !isObjectHash(actual)) return false;
	return expected.length === actual.length
		? expected === actual
		: expected.length === 19 && actual.length === 67 && expected === actual.slice(0, 19);
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

export async function readEventsAt(vault: Vault, path: string): Promise<LedgerEvent[]> {
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

export async function readLedger(vault: Vault, file: TFile): Promise<LedgerEvent[]> {
	return readEventsAt(vault, ledgerPath(file));
}

/** Human/tool-readable sidecar summary: note anchor, path hint, block names. */
export interface SidecarManifest {
	noteId: string | null;
	path: string;
	blocks: Record<string, string>;
	updated: number;
}

export async function writeManifest(vault: Vault, file: TFile, manifest: SidecarManifest): Promise<boolean> {
	const path = `${sidecarDir(file)}/manifest.json`;
	const body = JSON.stringify(manifest, null, "\t") + "\n";
	const af = vault.getAbstractFileByPath(path);
	if (af instanceof TFile) {
		// `updated` describes the last semantic manifest change, not the last
		// snapshot attempt. Avoid rewriting the summary (and waking Sync) when its
		// note anchor, path, block order, and names are already current.
		if (sameManifest(await vault.read(af), manifest)) return false;
		await vault.process(af, () => body);
		return true;
	}
	try {
		await vault.create(path, body);
		return true;
	} catch (error) {
		const raced = vault.getAbstractFileByPath(path);
		if (!(raced instanceof TFile)) throw error;
		if (sameManifest(await vault.read(raced), manifest)) return false;
		await vault.process(raced, () => body);
		return true;
	}
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

export async function appendEvents(vault: Vault, file: TFile, events: readonly LedgerEvent[]): Promise<void> {
	if (!events.length) return;
	validateEventBatch(events);
	encodeEventLines(events); // Fail before any I/O when one record is not recoverable.
	const path = ledgerPath(file);
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
