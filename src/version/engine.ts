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
 * never re-stored (no snapshot storms). One debouncer PER FILE (a shared timer
 * would drop file A's snapshot when file B changes inside the window), and
 * snapshots are serialized per file so concurrent calls can't race the ledger.
 */
export class VersionEngine {
	private readonly debouncers = new Map<string, (file: TFile) => void>();
	private readonly inflight = new Map<string, Promise<void>>();

	constructor(private readonly plugin: MicaPlugin) {}

	/** Called on every note modify; ignores sidecar files and non-markdown. */
	handleModify(file: TFile): void {
		if (file.extension !== "md") return;
		if (file.path.includes(".mica/")) return;
		let bounce = this.debouncers.get(file.path);
		if (!bounce) {
			bounce = debounce((f: TFile) => void this.snapshot(f), 1500, true);
			this.debouncers.set(file.path, bounce);
		}
		bounce(file);
	}

	async state(file: TFile): Promise<Record<string, BlockState>> {
		return foldLedger(await readLedger(this.plugin.app.vault, file));
	}

	/** Serialized per file: a second call queues behind the first. */
	snapshot(file: TFile): Promise<void> {
		const prev = this.inflight.get(file.path) ?? Promise.resolve();
		const next = prev
			.then(() => this.doSnapshot(file))
			.catch((e) => console.error("Mica: snapshot failed", file.path, e))
			.finally(() => {
				if (this.inflight.get(file.path) === next) this.inflight.delete(file.path);
			});
		this.inflight.set(file.path, next);
		return next;
	}

	private async doSnapshot(file: TFile): Promise<void> {
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

	/**
	 * Revert a block to a stored version. Snapshots the CURRENT state first so
	 * a dirty inline edit is never destroyed, then rewrites and records set-head.
	 */
	async revert(file: TFile, blockId: string, hash: string): Promise<void> {
		const vault = this.plugin.app.vault;
		await this.snapshot(file); // preserve whatever is inline right now
		const content = await readObject(vault, file, hash);
		if (content === null) return;
		const next = replaceBlockContent(await vault.read(file), blockId, content);
		if (next === null) return;
		await vault.modify(file, next);
		await appendEvents(vault, file, [{ type: "set-head", eid: newId(), ts: Date.now(), block: blockId, hash }]);
	}
}
