import { debounce, TFile } from "obsidian";
import type MicaPlugin from "../main";
import {
	foldLedger,
	hashContent,
	newId,
	replaceBlockContent,
	scanBlocksView,
	type BlockState,
	type LedgerEvent,
} from "../wasm/bridge";
import { appendEvents, ensureSidecar, readLedger, readObject, writeObject } from "../storage/sidecar";

/**
 * Snapshots each block's content into its note's sidecar on save, and drives
 * revert. Snapshots are change-gated by a BLAKE3 hash so an unchanged block is
 * never re-stored (no snapshot storms).
 */
export class VersionEngine {
	private readonly debouncedSnapshot: (file: TFile) => void;

	constructor(private readonly plugin: MicaPlugin) {
		this.debouncedSnapshot = debounce((file: TFile) => void this.snapshot(file), 1500, true);
	}

	/** Called on every note modify; ignores sidecar files and non-markdown. */
	handleModify(file: TFile): void {
		if (file.extension !== "md") return;
		if (file.path.includes(".mica/")) return;
		this.debouncedSnapshot(file);
	}

	async state(file: TFile): Promise<Record<string, BlockState>> {
		return foldLedger(await readLedger(this.plugin.app.vault, file));
	}

	async snapshot(file: TFile): Promise<void> {
		const vault = this.plugin.app.vault;
		const doc = await vault.read(file);
		const blocks = scanBlocksView(doc);
		if (!blocks.some((b) => b.id && b.closed)) return;

		const state = await this.state(file);
		const events: LedgerEvent[] = [];
		for (const b of blocks) {
			const id = b.id;
			if (!id || !b.closed) continue;
			const content = doc.slice(b.content_start, b.content_end);
			const hash = hashContent(content);
			if (state[id]?.head === hash) continue; // unchanged
			await ensureSidecar(vault, file);
			await writeObject(vault, file, hash, content);
			const ts = Date.now();
			events.push({ type: "add-version", eid: newId(), ts, block: id, hash });
			events.push({ type: "set-head", eid: newId(), ts, block: id, hash });
		}
		await appendEvents(vault, file, events);
	}

	/** Revert a block to a stored version: rewrite it inline and record a set-head. */
	async revert(file: TFile, blockId: string, hash: string): Promise<void> {
		const vault = this.plugin.app.vault;
		const content = await readObject(vault, file, hash);
		if (content === null) return;
		const next = replaceBlockContent(await vault.read(file), blockId, content);
		if (next === null) return;
		await vault.modify(file, next);
		await appendEvents(vault, file, [{ type: "set-head", eid: newId(), ts: Date.now(), block: blockId, hash }]);
	}
}
