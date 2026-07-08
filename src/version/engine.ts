import { debounce, TFile, type Vault } from "obsidian";
import type MicaPlugin from "../main";
import {
	contentSignature,
	ensureIds,
	foldLedger,
	hasContent,
	hashContent,
	newId,
	replaceBlockContent,
	scanBlocksView,
	type BlockState,
	type LedgerEvent,
} from "../wasm/bridge";
import { appendEvents, ensureSidecar, readLedger, readObject, writeManifest, writeObject } from "../storage/sidecar";

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
	private readonly listeners = new Set<(file: TFile) => void>();

	constructor(private readonly plugin: MicaPlugin) {}

	/** Called on every note modify; ignores sidecar files and non-markdown. */
	handleModify(file: TFile): void {
		if (file.extension !== "md") return;
		if (file.path.includes(".mica/")) return;
		if (!this.plugin.settings.autoSnapshotEnabled) return; // manual mode: only explicit snapshots
		let bounce = this.debouncers.get(file.path);
		if (!bounce) {
			bounce = debounce((f: TFile) => void this.snapshot(f), this.plugin.settings.snapshotDebounceMs, true);
			this.debouncers.set(file.path, bounce);
		}
		bounce(file);
	}

	/** Drop cached debouncers (e.g. after the debounce setting changes). */
	resetDebouncers(): void {
		this.debouncers.clear();
	}

	/** Subscribe to "a file was just snapshotted" (chips refresh on this). */
	onSnapshot(cb: (file: TFile) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emitSnapshot(file: TFile): void {
		for (const cb of this.listeners) {
			try {
				cb(file);
			} catch (e) {
				console.error("Mica: snapshot listener failed", e);
			}
		}
	}

	async state(file: TFile): Promise<Record<string, BlockState>> {
		return foldLedger(await readLedger(this.plugin.app.vault, file));
	}

	/**
	 * Serialized per file: a second call queues behind the first. `force` snapshots
	 * even a content-unchanged (structural-only) edit — used by the manual "Save
	 * version" button.
	 */
	snapshot(file: TFile, force = false): Promise<void> {
		const prev = this.inflight.get(file.path) ?? Promise.resolve();
		const next = prev
			.then(() => this.doSnapshot(file, force))
			.catch((e) => console.error("Mica: snapshot failed", file.path, e))
			.finally(() => {
				if (this.inflight.get(file.path) === next) this.inflight.delete(file.path);
			});
		this.inflight.set(file.path, next);
		return next;
	}

	private async doSnapshot(file: TFile, force: boolean): Promise<void> {
		const vault = this.plugin.app.vault;
		let doc = await vault.read(file);
		let blocks = scanBlocksView(doc);
		if (!blocks.some((b) => b.closed)) return; // no Mica blocks at all

		// Auto-stamp ids so versioning + inline editing work without a command.
		if (this.plugin.settings.autoAddIds && blocks.some((b) => b.closed && !b.id)) {
			const next = ensureIds(doc);
			if (next !== doc) {
				await vault.modify(file, next);
				doc = next;
				blocks = scanBlocksView(doc);
			}
		}
		if (!blocks.some((b) => b.id && b.closed)) return;

		const state = await this.state(file);
		const events: LedgerEvent[] = [];
		for (const b of blocks) {
			const id = b.id;
			if (!id || !b.closed) continue;
			const content = doc.slice(b.content_start, b.content_end);
			const hash = hashContent(content);
			const head = state[id]?.head ?? null;
			if (head === hash) continue; // byte-identical to head
			if (!force && !(await this.contentChanged(vault, file, content, head))) continue; // structural-only churn
			await ensureSidecar(vault, file);
			await writeObject(vault, file, hash, content);
			const ts = Date.now();
			events.push({ type: "add-version", eid: newId(), ts, block: id, hash });
			events.push({ type: "set-head", eid: newId(), ts, block: id, hash });
		}
		await appendEvents(vault, file, events);
		if (events.length) this.emitSnapshot(file);
		if (events.length) {
			const names: Record<string, string> = {};
			for (const b of blocks) if (b.id) names[b.id] = b.name ?? "";
			const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as
				Record<string, unknown> | undefined;
			await writeManifest(vault, file, {
				noteId: typeof fm?.["mica-id"] === "string" ? (fm["mica-id"] as string) : null,
				path: file.path,
				blocks: names,
				updated: Date.now(),
			});
		}
	}

	/**
	 * Whether a block's *prose* differs from its stored head — the gate that keeps
	 * empty tabs/cells, reordering, and renames from minting versions. The first
	 * real version requires actual content; later ones require the content
	 * signature to differ from the head object's.
	 */
	private async contentChanged(vault: Vault, file: TFile, content: string, head: string | null): Promise<boolean> {
		const sig = contentSignature(content);
		if (!head) return hasContent(content);
		const headContent = await readObject(vault, file, head);
		if (headContent === null) return true; // head object missing — snapshot to be safe
		return contentSignature(headContent) !== sig;
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

	/**
	 * Edit a previous version in place — branch semantics: the result is a NEW
	 * version whose `parent` records the version it was derived from, and it
	 * becomes the head. Nothing is ever rewritten.
	 */
	async editVersion(file: TFile, blockId: string, parentHash: string, content: string): Promise<void> {
		const vault = this.plugin.app.vault;
		await this.snapshot(file); // preserve current inline state first
		const hash = hashContent(content);
		await ensureSidecar(vault, file);
		await writeObject(vault, file, hash, content);
		const ts = Date.now();
		await appendEvents(vault, file, [
			{ type: "add-version", eid: newId(), ts, block: blockId, hash, parent: parentHash },
			{ type: "set-head", eid: newId(), ts, block: blockId, hash },
		]);
		const next = replaceBlockContent(await vault.read(file), blockId, content);
		if (next !== null) await vault.modify(file, next);
	}
}
