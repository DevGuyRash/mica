import { debounce, TFile, type Debouncer, type Vault } from "obsidian";
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
import {
	appendEvents,
	ensureSidecar,
	LedgerAppendError,
	ledgerAppendProvesNoCommit,
	readLedger,
	requireObject,
	writeManifest,
	writeObject,
} from "../storage/sidecar";

export interface NoteTransform<T> {
	/** The complete next note. Return the input unchanged for a rejected/no-op edit. */
	doc: string;
	/** A typed result which lets the caller distinguish conflicts from success. */
	result: T;
}

export interface MutateOptions {
	/** Save a semantic pre-image before a destructive mutation. Structural-only
	 *  changes remain excluded by the product's versioning contract. */
	snapshotBefore?: boolean;
	/** Persist the result after a successful note change. */
	snapshotAfter?: boolean;
}

type SnapshotDebouncer = Debouncer<[TFile], void>;

/** Internal classification used only when a live note was already published.
 * `rollbackSafe` means no event from this snapshot attempt (or an earlier retry)
 * can have reached the authoritative ledger. */
class SnapshotFailure extends Error {
	constructor(
		readonly rollbackSafe: boolean,
		cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "SnapshotFailure";
	}
}

/**
 * Owns every asynchronous note/version mutation. Work is serialized by TFile
 * identity (stable across rename), while each returned promise preserves its
 * own failure. Only background auto-snapshot calls log and absorb failures.
 */
export class VersionEngine {
	private readonly debouncers = new Map<string, SnapshotDebouncer>();
	private readonly queues = new Map<TFile, Promise<void>>();
	private readonly stateReads = new Map<TFile, Promise<Record<string, BlockState>>>();
	private readonly listeners = new Set<(file: TFile) => void>();
	private disposed = false;

	constructor(private readonly plugin: MicaPlugin) {}

	/** Called on every note modify; ignores sidecar files and non-markdown. */
	handleModify(file: TFile): void {
		if (this.disposed || file.extension !== "md") return;
		if (file.path.includes(".mica/")) return;
		if (!this.plugin.settings.autoSnapshotEnabled) return;
		let bounce = this.debouncers.get(file.path);
		if (!bounce) {
			bounce = debounce(
				(f: TFile) => {
					void this.snapshot(f).catch((error) =>
						console.error("Mica: background snapshot failed", f.path, error),
					);
				},
				this.plugin.settings.snapshotDebounceMs,
				true,
			);
			this.debouncers.set(file.path, bounce);
		}
		bounce(file);
	}

	/** Cancel and forget one file's pending background snapshot. */
	forgetFile(path: string): void {
		this.debouncers.get(path)?.cancel();
		this.debouncers.delete(path);
	}

	/** Cancel all pending background snapshots after a settings change. */
	resetDebouncers(): void {
		for (const bounce of this.debouncers.values()) bounce.cancel();
		this.debouncers.clear();
	}

	/** Release engine-owned timers/listeners. Already-running I/O is allowed to settle. */
	dispose(): void {
		this.disposed = true;
		this.resetDebouncers();
		this.listeners.clear();
		this.stateReads.clear();
	}

	/** Subscribe to "a file was just snapshotted" (chips refresh on this). */
	onSnapshot(cb: (file: TFile) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emitSnapshot(file: TFile): void {
		if (this.disposed) return;
		for (const cb of this.listeners) {
			try {
				cb(file);
			} catch (error) {
				console.error("Mica: snapshot listener failed", error);
			}
		}
	}

	/**
	 * Coalesce simultaneous chip/modal reads. The read itself joins the same
	 * per-file queue as writes, so it observes a complete state before or after
	 * a mutation, never a ledger in the middle of one.
	 */
	state(file: TFile): Promise<Record<string, BlockState>> {
		const pending = this.stateReads.get(file);
		if (pending) return pending;
		const read = this.enqueue(file, () => this.readState(file)).finally(() => {
			if (this.stateReads.get(file) === read) this.stateReads.delete(file);
		});
		this.stateReads.set(file, read);
		return read;
	}

	private async readState(file: TFile): Promise<Record<string, BlockState>> {
		return foldLedger(await readLedger(this.plugin.app.vault, file));
	}

	/**
	 * Run a synchronous text transform through Obsidian's atomic `Vault.process`
	 * while serialized with snapshots and other API edits for the same note.
	 */
	mutate<T>(file: TFile, transform: (current: string) => NoteTransform<T>, options: MutateOptions = {}): Promise<T> {
		this.stateReads.delete(file);
		return this.enqueue(file, async () => {
			// Ordinary API edits honor the semantic content gate: adding/reordering
			// empty structure must not mint a user-visible version. doSnapshot still
			// returns the exact note it observed, which remains the conflict guard for
			// the subsequent Vault.process mutation. Restore/branch explicitly force
			// their pre-images in their dedicated methods below.
			const snapshottedDoc = options.snapshotBefore ? await this.doSnapshot(file, false) : null;
			let result: T | undefined;
			let ran = false;
			let changed = false;
			let previousDoc = "";
			const committedDoc = await this.plugin.app.vault.process(file, (current) => {
				if (snapshottedDoc !== null && current !== snapshottedDoc) {
					throw new Error(`Mica: ${file.path} changed after its pre-image was saved; retry the edit`);
				}
				previousDoc = current;
				const next = transform(current);
				ran = true;
				result = next.result;
				changed = next.doc !== current;
				return next.doc;
			});
			if (!ran) throw new Error(`Mica: note transform did not run for ${file.path}`);
			if (changed && options.snapshotAfter) {
				try {
					await this.doSnapshot(file, false);
				} catch (error) {
					if (error instanceof SnapshotFailure && error.rollbackSafe) {
						let rolledBack = false;
						try {
							await this.plugin.app.vault.process(file, (current) => {
								if (current !== committedDoc) {
									throw new Error("the note changed again before rollback");
								}
								return previousDoc;
							});
							rolledBack = true;
						} catch (rollbackError) {
							console.error(
								"Mica: history update failed after the live note changed again; preserving live content and retrying",
								file.path,
								new AggregateError([error, rollbackError]),
							);
							this.scheduleRecoverySnapshot(file);
						}
						if (rolledBack) {
							throw new Error(
								`Mica: history update failed; the note edit was rolled back (${file.path})`,
								{
									cause: error,
								},
							);
						}
					} else {
						// Partial/unknown means the authoritative events may already be
						// present. The live edit therefore succeeded; preserve that truth
						// for the caller and repair any missing head asynchronously.
						console.error(
							"Mica: history update needs recovery; preserving the committed note edit",
							file.path,
							error,
						);
						this.scheduleRecoverySnapshot(file);
					}
				}
			}
			return result as T;
		});
	}

	/** Serialize sidecar/identity work that cannot fit a synchronous note transform. */
	withFileLock<T>(file: TFile, task: () => Promise<T>): Promise<T> {
		this.stateReads.delete(file);
		return this.enqueue(file, task);
	}

	/** Explicit snapshots reject on failure; background callers catch separately. */
	snapshot(file: TFile, force = false): Promise<void> {
		this.stateReads.delete(file);
		return this.enqueue(file, async () => {
			await this.doSnapshot(file, force);
		});
	}

	private enqueue<T>(file: TFile, task: () => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("Mica: version engine is disposed"));
		const previous = this.queues.get(file) ?? Promise.resolve();
		const operation = previous.then(task);
		// The queue tail must settle so one rejected task cannot poison later work,
		// but callers receive `operation`, which retains the original rejection.
		const tail = operation
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (this.queues.get(file) === tail) this.queues.delete(file);
			});
		this.queues.set(file, tail);
		return operation;
	}

	private scheduleRecoverySnapshot(file: TFile): void {
		window.setTimeout(() => {
			if (this.disposed) return;
			void this.snapshot(file, false).catch((error) =>
				console.error("Mica: deferred history recovery failed", file.path, error),
			);
		}, 0);
	}

	private async doSnapshot(file: TFile, force: boolean, attempt = 0, historyCommitted = false): Promise<string> {
		let committed = historyCommitted;
		try {
			const vault = this.plugin.app.vault;
			let doc = await vault.read(file);
			let blocks = scanBlocksView(doc);
			if (!blocks.some((block) => block.closed)) return doc;

			if (this.plugin.settings.autoAddIds && blocks.some((block) => block.closed && !block.id)) {
				doc = await vault.process(file, (current) => ensureIds(current));
				blocks = scanBlocksView(doc);
			}
			this.requireUniqueSnapshotIds(blocks);
			if (!blocks.some((block) => block.id && block.closed)) return doc;

			const state = await this.readState(file);
			const events: LedgerEvent[] = [];
			for (const block of blocks) {
				const id = block.id;
				if (!id || !block.closed) continue;
				const content = doc.slice(block.content_start, block.content_end);
				const hash = hashContent(content);
				const head = state[id]?.head ?? null;
				if (head === hash) continue;
				if (!force && !(await this.contentChanged(vault, file, content, head))) continue;
				await ensureSidecar(vault, file);
				await writeObject(vault, file, hash, content);
				const ts = Date.now();
				events.push({ type: "add-version", eid: newId(), ts, block: id, hash });
				events.push({ type: "set-head", eid: newId(), ts, block: id, hash });
			}
			if (!events.length) return doc;
			const names: Record<string, string> = {};
			for (const block of blocks) if (block.id) names[block.id] = block.name ?? "";
			const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as
				Record<string, unknown> | undefined;
			await writeManifest(vault, file, {
				noteId: typeof frontmatter?.["mica-id"] === "string" ? (frontmatter["mica-id"] as string) : null,
				path: file.path,
				blocks: names,
				updated: Date.now(),
			});
			// Sidecar/object writes are asynchronous and cannot share a transaction
			// with the note. Re-read immediately before committing the authoritative
			// head events; if Sync/editor changed the note meanwhile, discard these
			// prepared events and snapshot the fresh document instead.
			const beforeCommit = await vault.read(file);
			if (beforeCommit !== doc) return this.retrySnapshot(file, force, attempt, committed);
			await appendEvents(vault, file, events);
			committed = true;
			const afterCommit = await vault.read(file);
			if (afterCommit !== doc) return this.retrySnapshot(file, force, attempt, committed);
			this.emitSnapshot(file);
			return doc;
		} catch (error) {
			if (error instanceof SnapshotFailure) throw error;
			const rollbackSafe =
				!committed && (!(error instanceof LedgerAppendError) || ledgerAppendProvesNoCommit(error));
			throw new SnapshotFailure(rollbackSafe, error);
		}
	}

	private retrySnapshot(file: TFile, force: boolean, attempt: number, historyCommitted: boolean): Promise<string> {
		if (attempt >= 2) {
			return Promise.reject(new Error(`Mica: ${file.path} kept changing while versions were being saved; retry`));
		}
		return this.doSnapshot(file, force, attempt + 1, historyCommitted);
	}

	private requireUniqueSnapshotIds(blocks: ReturnType<typeof scanBlocksView>): void {
		const seen = new Set<string>();
		const duplicates = new Set<string>();
		for (const block of blocks) {
			if (!block.closed || !block.id) continue;
			if (seen.has(block.id)) duplicates.add(block.id);
			else seen.add(block.id);
		}
		if (duplicates.size) {
			throw new Error(
				`Mica: duplicate block id(s) cannot be snapshotted: ${[...duplicates].sort().join(", ")}; run Mica repair first`,
			);
		}
	}

	private async contentChanged(vault: Vault, file: TFile, content: string, head: string | null): Promise<boolean> {
		const signature = contentSignature(content);
		if (!head) return hasContent(content);
		const headContent = await requireObject(vault, file, head);
		return contentSignature(headContent) !== signature;
	}

	/** Revert to a verified version or reject without claiming success. */
	revert(file: TFile, blockId: string, hash: string): Promise<void> {
		this.stateReads.delete(file);
		return this.enqueue(file, async () => {
			await this.requireVersion(file, blockId, hash);
			const content = await requireObject(this.plugin.app.vault, file, hash);
			const snapshottedDoc = await this.doSnapshot(file, true);
			const replacement = await this.replaceUniqueBlock(file, blockId, content, snapshottedDoc);
			await this.commitLiveVersion(file, blockId, content, replacement, [
				{ type: "set-head", eid: newId(), ts: Date.now(), block: blockId, hash },
			]);
		});
	}

	/** Create a verified branch version and make it the live/head content. */
	editVersion(file: TFile, blockId: string, parentHash: string, content: string): Promise<void> {
		this.stateReads.delete(file);
		return this.enqueue(file, async () => {
			await this.requireVersion(file, blockId, parentHash);
			await requireObject(this.plugin.app.vault, file, parentHash);
			this.uniqueLiveBlock(await this.plugin.app.vault.read(file), blockId);
			const snapshottedDoc = await this.doSnapshot(file, true);
			const hash = hashContent(content);
			await ensureSidecar(this.plugin.app.vault, file);
			await writeObject(this.plugin.app.vault, file, hash, content);
			const replacement = await this.replaceUniqueBlock(file, blockId, content, snapshottedDoc);
			const ts = Date.now();
			await this.commitLiveVersion(file, blockId, content, replacement, [
				{ type: "add-version", eid: newId(), ts, block: blockId, hash, parent: parentHash },
				{ type: "set-head", eid: newId(), ts, block: blockId, hash },
			]);
		});
	}

	/** Append a label only after proving the version/object is valid. */
	labelVersion(file: TFile, blockId: string, hash: string, label: string): Promise<void> {
		this.stateReads.delete(file);
		return this.enqueue(file, async () => {
			await this.requireVersion(file, blockId, hash);
			await requireObject(this.plugin.app.vault, file, hash);
			await appendEvents(this.plugin.app.vault, file, [
				{ type: "label", eid: newId(), ts: Date.now(), block: blockId, hash, label: label || null },
			]);
			this.emitSnapshot(file);
		});
	}

	private async requireVersion(file: TFile, blockId: string, hash: string): Promise<void> {
		const block = (await this.readState(file))[blockId];
		if (!block?.versions.some((version) => version.hash === hash)) {
			throw new Error(`Mica: version ${hash} does not belong to block ${blockId}`);
		}
	}

	private async replaceUniqueBlock(
		file: TFile,
		blockId: string,
		content: string,
		expectedDoc: string,
	): Promise<{ previous: string; committed: string }> {
		let previous: string | null = null;
		const committed = await this.plugin.app.vault.process(file, (doc) => {
			if (doc !== expectedDoc)
				throw new Error(`Mica: ${file.path} changed after its pre-image was saved; retry the edit`);
			const block = this.uniqueLiveBlock(doc, blockId);
			previous = doc.slice(block.content_start, block.content_end);
			const next = replaceBlockContent(doc, blockId, content);
			if (next === null) throw new Error(`Mica: cannot replace block ${blockId}`);
			return next;
		});
		if (previous === null) throw new Error(`Mica: block transform did not run for ${blockId}`);
		return { previous, committed };
	}

	private async commitLiveVersion(
		file: TFile,
		blockId: string,
		attempted: string,
		replacement: { previous: string; committed: string },
		events: readonly LedgerEvent[],
	): Promise<void> {
		const vault = this.plugin.app.vault;
		if ((await vault.read(file)) !== replacement.committed) {
			await this.rollbackBlock(
				file,
				blockId,
				attempted,
				replacement.previous,
				new Error("the note changed before history could be committed"),
			);
		}
		try {
			await appendEvents(vault, file, events);
		} catch (error) {
			if (ledgerAppendProvesNoCommit(error)) {
				await this.rollbackBlock(file, blockId, attempted, replacement.previous, error);
			}
			// A partial/unknown append may already contain the authoritative head.
			// Rolling the note back in that state would manufacture divergence.
			throw error;
		}
		// A write racing immediately after the append is preserved, then captured
		// as the newest head so the ledger cannot remain stale.
		if ((await vault.read(file)) !== replacement.committed) await this.doSnapshot(file, true);
		this.emitSnapshot(file);
	}

	private uniqueLiveBlock(doc: string, blockId: string): ReturnType<typeof scanBlocksView>[number] {
		const matches = scanBlocksView(doc).filter((block) => block.closed && block.id === blockId);
		if (matches.length !== 1) {
			throw new Error(
				matches.length ? `Mica: block id is ambiguous: ${blockId}` : `Mica: block not found: ${blockId}`,
			);
		}
		return matches[0];
	}

	private async rollbackBlock(
		file: TFile,
		blockId: string,
		attempted: string,
		previous: string,
		cause: unknown,
	): Promise<never> {
		const expected = normalizeBlockContent(attempted);
		try {
			await this.plugin.app.vault.process(file, (doc) => {
				const matches = scanBlocksView(doc).filter((block) => block.closed && block.id === blockId);
				if (matches.length !== 1) throw new Error("block disappeared or became ambiguous");
				const block = matches[0];
				if (doc.slice(block.content_start, block.content_end) !== expected) {
					throw new Error("block changed again before rollback");
				}
				const rollback = replaceBlockContent(doc, blockId, previous);
				if (rollback === null) throw new Error("rollback reducer rejected the block");
				return rollback;
			});
		} catch (rollbackError) {
			throw new AggregateError(
				[cause, rollbackError],
				`Mica: history update failed and the live block could not be rolled back (${blockId})`,
			);
		}
		throw new Error(`Mica: history update failed; the live block was rolled back (${blockId})`, { cause });
	}
}

function normalizeBlockContent(content: string): string {
	return content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
}
