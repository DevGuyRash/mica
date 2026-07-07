import { normalizePath, TFile, Vault } from "obsidian";
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
	return `${objectsDir(file)}/${hash.replace(":", "-")}.mica.md`;
}

export async function ensureSidecar(vault: Vault, file: TFile): Promise<void> {
	for (const dir of [sidecarDir(file), objectsDir(file)]) {
		if (!vault.getAbstractFileByPath(dir)) {
			await vault.createFolder(dir).catch(() => undefined);
		}
	}
}

/** Content-addressed write: objects are immutable, so an existing hash is a no-op. */
export async function writeObject(vault: Vault, file: TFile, hash: string, content: string): Promise<void> {
	const path = objectPath(file, hash);
	if (vault.getAbstractFileByPath(path)) return;
	await vault.create(path, content).catch(() => undefined);
}

export async function readObject(vault: Vault, file: TFile, hash: string): Promise<string | null> {
	const af = vault.getAbstractFileByPath(objectPath(file, hash));
	return af instanceof TFile ? vault.read(af) : null;
}

export async function readEventsAt(vault: Vault, path: string): Promise<LedgerEvent[]> {
	const af = vault.getAbstractFileByPath(path);
	if (!(af instanceof TFile)) return [];
	const events: LedgerEvent[] = [];
	for (const line of (await vault.read(af)).split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as LedgerEvent);
		} catch {
			// Skip a malformed line rather than losing the whole history.
		}
	}
	return events;
}

export async function readLedger(vault: Vault, file: TFile): Promise<LedgerEvent[]> {
	return readEventsAt(vault, ledgerPath(file));
}

export async function appendEvents(vault: Vault, file: TFile, events: LedgerEvent[]): Promise<void> {
	if (!events.length) return;
	const path = ledgerPath(file);
	const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
	const af = vault.getAbstractFileByPath(path);
	if (af instanceof TFile) {
		await vault.append(af, lines);
	} else {
		await vault.create(path, lines);
	}
}
