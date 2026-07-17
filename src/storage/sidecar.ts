import { normalizePath, TFile, TFolder, type Vault } from "obsidian";
import type { LedgerEvent } from "../wasm/bridge";

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
	const name = hash.replace(":", "-");
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
		throw new Error(`Mica: invalid object hash ${JSON.stringify(hash)}`);
	}
	return name;
}

/** Objects at or under this size stay human-readable plaintext .md. The rule
 *  is shared with the mica CLI — both sides read either form. */
export const COMPRESS_MIN_BYTES = 4096;

async function gzipText(text: string): Promise<ArrayBuffer> {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Response(stream).arrayBuffer();
}

async function gunzipToText(buf: ArrayBuffer): Promise<string> {
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Response(stream).text();
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
 *  no-op. Small objects stay human-readable plaintext; large ones gzip. */
export async function writeObject(vault: Vault, file: TFile, hash: string, content: string): Promise<void> {
	const plain = objectPath(file, hash);
	const gz = objectPathGz(file, hash);
	if (objectExists(vault, plain, gz)) return;
	try {
		if (new Blob([content]).size <= COMPRESS_MIN_BYTES) {
			await vault.create(plain, content);
			return;
		}
		const bytes = await gzipText(content);
		await vault.createBinary(gz, bytes);
	} catch (error) {
		// Content addressing makes a same-hash create race a successful no-op.
		if (!objectExists(vault, plain, gz)) throw error;
	}
}

function objectExists(vault: Vault, plain: string, gz: string): boolean {
	return vault.getAbstractFileByPath(plain) instanceof TFile || vault.getAbstractFileByPath(gz) instanceof TFile;
}

export async function readObject(vault: Vault, file: TFile, hash: string): Promise<string | null> {
	const plain = vault.getAbstractFileByPath(objectPath(file, hash));
	if (plain instanceof TFile) return vault.read(plain);
	const gz = vault.getAbstractFileByPath(objectPathGz(file, hash));
	if (gz instanceof TFile) return gunzipToText(await vault.readBinary(gz));
	return null;
}

export async function readEventsAt(vault: Vault, path: string): Promise<LedgerEvent[]> {
	const af = vault.getAbstractFileByPath(path);
	if (!(af instanceof TFile)) return [];
	const events: LedgerEvent[] = [];
	for (const line of (await vault.read(af)).split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const event: unknown = JSON.parse(trimmed);
			if (isLedgerEvent(event)) events.push(event);
		} catch {
			// Skip a malformed line rather than losing the whole history.
		}
	}
	return events;
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
	if (!isRecord(value)) return false;
	if (typeof value.eid !== "string" || !Number.isFinite(value.ts) || typeof value.block !== "string") return false;
	if (typeof value.hash !== "string" || !isSafePathPart(value.hash)) return false;
	switch (value.type) {
		case "add-version":
			return optionalString(value.label) && optionalString(value.origin) && optionalString(value.parent);
		case "set-head":
			return true;
		case "label":
			return optionalString(value.label);
		default:
			return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): boolean {
	return value === undefined || value === null || typeof value === "string";
}

function isSafePathPart(value: string): boolean {
	return Boolean(value) && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
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

export async function writeManifest(vault: Vault, file: TFile, manifest: SidecarManifest): Promise<void> {
	const path = `${sidecarDir(file)}/manifest.json`;
	const body = JSON.stringify(manifest, null, "\t") + "\n";
	const af = vault.getAbstractFileByPath(path);
	if (af instanceof TFile) {
		await vault.modify(af, body);
		return;
	}
	try {
		await vault.create(path, body);
	} catch (error) {
		const raced = vault.getAbstractFileByPath(path);
		if (!(raced instanceof TFile)) throw error;
		await vault.modify(raced, body);
	}
}

export async function appendEvents(vault: Vault, file: TFile, events: readonly LedgerEvent[]): Promise<void> {
	if (!events.length) return;
	const path = ledgerPath(file);
	const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const af = vault.getAbstractFileByPath(path);
	if (af instanceof TFile) {
		await vault.append(af, lines);
		return;
	}
	try {
		await vault.create(path, lines);
	} catch {
		// Lost a create race — the ledger appeared between the check and the
		// create. Re-resolve and append so the events are never dropped.
		const raced = vault.getAbstractFileByPath(path);
		if (raced instanceof TFile) await vault.append(raced, lines);
		else throw new Error(`Mica: cannot write ledger at ${path}`);
	}
}
