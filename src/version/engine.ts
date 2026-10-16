import { debounce, TFile, TFolder, type Debouncer, type Vault } from "obsidian";
import type MicaPlugin from "../main";
import { bindNoteStore, ensureNoteStore, isLiveNote, storeRoot, validateStoreRoot, type NoteStore } from "../storage/store";
import {
	contentSignature,
	ensureIds,
	foldLedger,
	hasContent,
	hashContent,
	newId,
	noteId,
	replaceBlockContent,
	resolveObjectHash,
	scanBlocksView,
	type BlockState,
	type LedgerEvent,
	type VersionMeta,
} from "../wasm/bridge";
import {
	appendEvents,
	ensureSidecar,
	LedgerAppendError,
	ledgerAppendProvesNoCommit,
	readLedger,
	readObject,
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

/** Exact outcome of one explicit snapshot request. Metadata maintenance is
 * reported separately so callers never describe it as a saved version. */
export interface SnapshotResult {
	readonly blockIds: readonly string[];
	readonly versionsCreated: number;
	readonly metadataChanged: boolean;
}

export interface SnapshotEvent extends SnapshotResult {
	readonly file: TFile;
}

export type RevertToHeadResult =
	| { readonly status: "reverted"; readonly recoveryHash: string; readonly headHash: string }
	| { readonly status: "unchanged" }
	| { readonly status: "no-head" }
	| { readonly status: "unavailable"; readonly reason: string };

export type VersionRef = string | { readonly versionId?: string; readonly hash?: string };

interface SnapshotCommit extends SnapshotResult {
	readonly doc: string;
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
	private readonly storeReads = new Map<TFile, Promise<NoteStore | null>>();
	private readonly operationStores = new Map<TFile, NoteStore>();
	private readonly stateReads = new Map<TFile, Promise<Record<string, BlockState>>>();
	private readonly listeners = new Set<(event: SnapshotEvent) => void>();
	private disposed = false;

	constructor(private readonly plugin: MicaPlugin) {}

	/** Called on every note modify; ignores sidecar files and non-markdown. */
	handleModify(file: TFile): void {
		if (this.disposed || !isLiveNote(file)) return;
		const hasHistory = Boolean(this.plugin.app.vault.getAbstractFileByPath(storeRoot(this.plugin.app.vault).paths.marker));
		if (!this.plugin.settings.autoSnapshotEnabled && !this.plugin.settings.autoAddIds && !hasHistory) return;
		let bounce = this.debouncers.get(file.path);
		if (!bounce) {
			bounce = debounce(
				(f: TFile) => {
					const work = this.plugin.settings.autoSnapshotEnabled ? this.snapshot(f) : this.maintainNote(f);
					void work.catch((error) => console.error("Mica: background maintenance failed", f.path, error));
				},
				this.plugin.settings.snapshotDebounceMs,
				true,
			);
			this.debouncers.set(file.path, bounce);
		}
		bounce(file);
	}

	/** Keep identity and existing manifest metadata current when automatic content
	 * snapshots are disabled. This never creates a sidecar or a version event. */
	private maintainNote(file: TFile): Promise<void> {
		return this.withFileLock(file, async () => {
			const vault = this.plugin.app.vault;
			await validateStoreRoot(storeRoot(vault));
			let doc = await vault.read(file);
			let blocks = scanBlocksView(doc);
			if (this.plugin.settings.autoAddIds && blocks.some((block) => block.closed && !block.id)) {
				await this.lookupStore(file, doc); // Reject a copied note identity before changing its blocks.
				const expectedId = noteId(doc);
				doc = await vault.process(file, (current) => {
					if (noteId(current) !== expectedId) throw new Error("Mica: note identity changed before block IDs could be prepared");
					return ensureIds(current);
				});
				blocks = scanBlocksView(doc);
			}
			if (await this.refreshManifestIfPresent(vault, file, blocks, doc)) this.emitSnapshot(file, [], true);
		});
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
		this.storeReads.clear();
	}

	/** The lifecycle owner may release identity listeners after admitted queues finish. */
	settled(): Promise<void> {
		return Promise.all(this.queues.values()).then(() => undefined);
	}

	/** Subscribe to "a file was just snapshotted" (chips refresh on this). */
	onSnapshot(cb: (event: SnapshotEvent) => void): () => void {
		if (this.disposed) return () => undefined;
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emitSnapshot(file: TFile, blockIds: readonly string[] = [], metadataChanged = false): void {
		if (this.disposed) return;
		const event: SnapshotEvent = {
			file,
			blockIds,
			versionsCreated: blockIds.length,
			metadataChanged,
		};
		for (const cb of this.listeners) {
			try {
				cb(event);
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

	/** Queue a new fold after any already-started read. Use this at interaction
	 * boundaries that freeze a durable metadata snapshot (for example a search
	 * index) so a just-completed label/visibility event cannot be hidden by a
	 * coalesced pre-event read. */
	freshState(file: TFile): Promise<Record<string, BlockState>> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.state(file);
	}

	/** Source-backed read lookup for UI/API consumers. Never stamps or creates history. */
	historyStore(file: TFile): Promise<NoteStore | null> {
		const pending = this.storeReads.get(file);
		if (pending) return pending;
		const read = this.enqueue(file, () => this.lookupStore(file)).finally(() => {
			if (this.storeReads.get(file) === read) this.storeReads.delete(file);
		});
		this.storeReads.set(file, read);
		return read;
	}

	private async lookupStore(file: TFile, source?: string): Promise<NoteStore | null> {
		const existing = this.operationStores.get(file);
		if (existing && (source === undefined || noteId(source) === existing.noteId)) return existing;
		const root = storeRoot(this.plugin.app.vault);
		const store = await bindNoteStore(root, file, source ?? await root.vault.read(file));
		if (store) this.operationStores.set(file, store);
		return store;
	}

	private async requireStore(file: TFile): Promise<NoteStore> {
		const store = await this.lookupStore(file);
		if (!store) throw new Error(`Mica: history is not prepared for ${file.path}`);
		return store;
	}

	private async readState(file: TFile): Promise<Record<string, BlockState>> {
		const store = await this.lookupStore(file);
		return store ? foldLedger(await readLedger(store)) : {};
	}

	/**
	 * Run a synchronous text transform through Obsidian's atomic `Vault.process`
	 * while serialized with snapshots and other API edits for the same note.
	 */
	mutate<T>(file: TFile, transform: (current: string) => NoteTransform<T>, options: MutateOptions = {}): Promise<T> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			// Ordinary API edits honor the semantic content gate: adding/reordering
			// empty structure must not mint a user-visible version. doSnapshot still
			// returns the exact note it observed, which remains the conflict guard for
			// the subsequent Vault.process mutation. Restore/branch explicitly force
			// their pre-images in their dedicated methods below.
			const snapshottedDoc = options.snapshotBefore ? (await this.doSnapshot(file, false)).doc : null;
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
		this.storeReads.delete(file);
		return this.enqueue(file, task);
	}

	/** Note identity owns history; a rename changes only its human-readable path hint. */
	handleRename(file: TFile, oldPath: string): Promise<void> {
		this.forgetFile(oldPath);
		if (!isLiveNote(file)) return Promise.resolve();
		return this.withFileLock(file, async () => {
			const doc = await this.plugin.app.vault.read(file);
			await this.refreshManifestIfPresent(this.plugin.app.vault, file, scanBlocksView(doc), doc);
			this.emitSnapshot(file, [], true);
		});
	}

	/** Explicit note-wide snapshots reject on failure and report only versions
	 * that reached the authoritative ledger. */
	snapshot(file: TFile, force = false): Promise<SnapshotResult> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const result = await this.doSnapshot(file, force);
			return snapshotResult(result);
		});
	}

	/** Snapshot exactly one stable block. Other dirty blocks in the note remain
	 * untouched; shared identity/manifest maintenance may still run. */
	snapshotBlock(file: TFile, blockId: string, force = true): Promise<SnapshotResult> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const result = await this.doSnapshot(file, force, blockId);
			return snapshotResult(result);
		});
	}

	private enqueue<T>(file: TFile, task: () => Promise<T>): Promise<T> {
		if (this.disposed) return Promise.reject(new Error("Mica: version engine is disposed"));
		const previous = this.queues.get(file) ?? Promise.resolve();
		const operation = previous.then(async () => {
			if (!isLiveNote(file)) throw new Error(`Mica: managed storage is not a live note: ${file.path}`);
			this.operationStores.delete(file);
			try { return await task(); } finally { this.operationStores.delete(file); }
		});
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

	private async doSnapshot(
		file: TFile,
		force: boolean,
		onlyBlockId?: string,
		attempt = 0,
		historyCommitted = false,
		created = new Set<string>(),
		metadataChangedBefore = false,
	): Promise<SnapshotCommit> {
		let committed = historyCommitted;
		try {
			const vault = this.plugin.app.vault;
			await validateStoreRoot(storeRoot(vault));
			let doc = await vault.read(file);
			let blocks = scanBlocksView(doc);
			const hasClosedBlock = blocks.some((block) => block.closed);

			if (
				hasClosedBlock &&
				this.plugin.settings.autoAddIds &&
				blocks.some((block) => block.closed && !block.id)
			) {
				await this.lookupStore(file, doc); // Reject a copied note identity before changing its blocks.
				const expectedId = noteId(doc);
				doc = await vault.process(file, (current) => {
					if (noteId(current) !== expectedId) throw new Error("Mica: note identity changed before block IDs could be prepared");
					return ensureIds(current);
				});
				blocks = scanBlocksView(doc);
			}
			const events: LedgerEvent[] = [];
			let sidecarReady = false;
			if (onlyBlockId) {
				let targets = 0;
				for (const block of blocks) {
					if (block.closed && block.id === onlyBlockId) targets += 1;
				}
				if (targets !== 1) {
					throw new Error(
						targets
							? `Mica: block id is ambiguous: ${onlyBlockId}`
							: `Mica: block not found: ${onlyBlockId}`,
					);
				}
			}
			if (hasClosedBlock) {
				this.requireUniqueSnapshotIds(blocks);
				if (blocks.some((block) => block.id && block.closed)) {
					const existingStore = await this.lookupStore(file, doc);
					const state: Record<string, BlockState> = existingStore ? foldLedger(await readLedger(existingStore)) : {};
					const scannedSource = doc;
					for (const block of blocks) {
						const id = block.id;
						if (!id || !block.closed) continue;
						if (onlyBlockId && id !== onlyBlockId) continue;
						const content = scannedSource.slice(block.content_start, block.content_end);
						const hash = hashContent(content);
						const blockState = state[id];
						const head = blockState?.rawHead ?? blockState?.head ?? null;
						const alias = head ? existingStore?.aliases[head] : undefined;
						if (head && resolveObjectHash(head, alias === undefined ? {} : { [head]: alias }) === hash) continue;
						if (!force && !(await this.contentChanged(file, content, head))) continue;
						if (!sidecarReady) {
							const prepared = await ensureNoteStore(storeRoot(vault), file, doc);
							if (prepared.source !== doc) { doc = prepared.source; blocks = scanBlocksView(doc); }
							this.operationStores.set(file, prepared.store);
							await ensureSidecar(prepared.store);
							sidecarReady = true;
						}
						await writeObject(await this.requireStore(file), hash, content);
						const ts = Date.now();
						const checkpointId = newId();
						events.push({
							type: "checkpoint",
							eid: checkpointId,
							ts,
							block: id,
							hash,
							parent: blockState?.rawHeadVersionId ?? blockState?.headVersionId ?? null,
							cause: "snapshot",
						});
						events.push({ type: "move-head", eid: newId(), ts, block: id, target: checkpointId });
					}
				}
			}
			const manifestChanged = await this.refreshManifestIfPresent(vault, file, blocks, doc);
			const anyMetadataChanged = metadataChangedBefore || manifestChanged;
			// Sidecar/object writes are asynchronous and cannot share a transaction
			// with the note. Re-read immediately before committing the authoritative
			// head events; if Sync/editor changed the note meanwhile, discard these
			// prepared events and snapshot the fresh document instead.
			const beforeCommit = await vault.read(file);
			if (beforeCommit !== doc)
				return this.retrySnapshot(file, force, onlyBlockId, attempt, committed, created, anyMetadataChanged);
			if (!events.length) {
				const blockIds = [...created];
				if (anyMetadataChanged || blockIds.length) this.emitSnapshot(file, blockIds, anyMetadataChanged);
				return {
					doc,
					blockIds,
					versionsCreated: created.size,
					metadataChanged: anyMetadataChanged,
				};
			}
			await appendEvents(await this.requireStore(file), events);
			committed = true;
			for (let i = 0; i < events.length; i += 2) {
				const event = events[i];
				if (event?.type === "add-version" || event?.type === "checkpoint") created.add(event.block);
			}
			const afterCommit = await vault.read(file);
			if (afterCommit !== doc)
				return this.retrySnapshot(file, force, onlyBlockId, attempt, committed, created, anyMetadataChanged);
			const blockIds = [...created];
			this.emitSnapshot(file, blockIds, anyMetadataChanged);
			return {
				doc,
				blockIds,
				versionsCreated: blockIds.length,
				metadataChanged: anyMetadataChanged,
			};
		} catch (error) {
			if (error instanceof SnapshotFailure) throw error;
			const rollbackSafe =
				!committed && (!(error instanceof LedgerAppendError) || ledgerAppendProvesNoCommit(error));
			throw new SnapshotFailure(rollbackSafe, error);
		}
	}

	private async refreshManifestIfPresent(
		vault: Vault,
		file: TFile,
		blocks: ReturnType<typeof scanBlocksView>,
		source?: string,
	): Promise<boolean> {
		const store = await this.lookupStore(file, source);
		if (!store) return false;
		const folder = vault.getAbstractFileByPath(store.paths.dir);
		if (!folder) return false;
		if (!(folder instanceof TFolder)) throw new Error(`Mica: sidecar path is not a folder: ${store.paths.dir}`);
		const names: Record<string, string> = {};
		for (const block of blocks) if (block.id) names[block.id] = block.name ?? "";
		return writeManifest(store, {
			noteId: store.noteId,
			path: file.path,
			blocks: names,
			updated: Date.now(),
		});
	}

	private retrySnapshot(
		file: TFile,
		force: boolean,
		onlyBlockId: string | undefined,
		attempt: number,
		historyCommitted: boolean,
		created: Set<string>,
		metadataChanged: boolean,
	): Promise<SnapshotCommit> {
		if (attempt >= 2) {
			return Promise.reject(new Error(`Mica: ${file.path} kept changing while versions were being saved; retry`));
		}
		return this.doSnapshot(file, force, onlyBlockId, attempt + 1, historyCommitted, created, metadataChanged);
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

	private async contentChanged(file: TFile, content: string, head: string | null): Promise<boolean> {
		const signature = contentSignature(content);
		if (!head) return hasContent(content);
		const headContent = await requireObject(await this.requireStore(file), head);
		return contentSignature(headContent) !== signature;
	}

	/** Revert to a verified checkpoint or reject without claiming success. */
	revert(file: TFile, blockId: string, ref: VersionRef): Promise<void> {
		return this.resetHeadToVersion(file, blockId, ref).then(() => undefined);
	}

	/** Move HEAD to an existing checkpoint after preserving the live pre-image. */
	resetHeadToVersion(file: TFile, blockId: string, ref: VersionRef): Promise<boolean> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const selected = await this.resolveVersion(file, blockId, ref);
			const content = await requireObject(await this.requireStore(file), selected.hash);
			const liveDoc = await this.plugin.app.vault.read(file);
			const live = this.uniqueLiveBlock(liveDoc, blockId);
			const state = (await this.readState(file))[blockId];
			if (
				liveDoc.slice(live.content_start, live.content_end) === content &&
				(state?.rawHeadVersionId ?? state?.headVersionId) === selected.versionId
			)
				return false;
			const snapshottedDoc = (await this.doSnapshot(file, true, blockId)).doc;
			const replacement = await this.replaceUniqueBlock(file, blockId, content, snapshottedDoc);
			await this.commitLiveVersion(file, blockId, content, replacement, [
				{ type: "move-head", eid: newId(), ts: Date.now(), block: blockId, target: selected.versionId },
			]);
			return true;
		});
	}

	/** Restore older bytes as a new forward checkpoint parented to current HEAD. */
	restoreAsCheckpoint(file: TFile, blockId: string, ref: VersionRef): Promise<boolean> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const selected = await this.resolveVersion(file, blockId, ref);
			const content = await requireObject(await this.requireStore(file), selected.hash);
			const liveDoc = await this.plugin.app.vault.read(file);
			const live = this.uniqueLiveBlock(liveDoc, blockId);
			if (liveDoc.slice(live.content_start, live.content_end) === content) return false;
			const snapshottedDoc = (await this.doSnapshot(file, true, blockId)).doc;
			const current = (await this.readState(file))[blockId];
			const parent = current?.rawHeadVersionId ?? current?.headVersionId ?? null;
			const checkpointId = newId();
			const replacement = await this.replaceUniqueBlock(file, blockId, content, snapshottedDoc);
			const ts = Date.now();
			await this.commitLiveVersion(file, blockId, content, replacement, [
				{
					type: "checkpoint",
					eid: checkpointId,
					ts,
					block: blockId,
					hash: selected.hash,
					parent,
					source: selected.versionId,
					cause: "restore",
				},
				{ type: "move-head", eid: newId(), ts, block: blockId, target: checkpointId },
			]);
			return true;
		});
	}

	/** Append reversible visibility changes for exact logical checkpoints. */
	setVersionsVisible(file: TFile, blockId: string, versionIds: readonly string[], visible: boolean): Promise<number> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const requested = new Set(versionIds);
			if (!requested.size) return 0;
			const state = (await this.readState(file))[blockId];
			const visibilityById = new Map<string, boolean>();
			for (const version of state?.versions ?? []) {
				if (requested.has(version.versionId)) visibilityById.set(version.versionId, version.visible);
			}
			for (const version of state?.removedVersions ?? []) {
				if (requested.has(version.versionId)) visibilityById.set(version.versionId, version.visible);
			}
			const changed: string[] = [];
			for (const id of requested) {
				const current = visibilityById.get(id);
				if (current === undefined) throw new Error(`Mica: version ${id} does not belong to block ${blockId}`);
				if (current !== visible) changed.push(id);
			}
			if (!changed.length) return 0;
			const ts = Date.now();
			await appendEvents(
				await this.requireStore(file),
				changed.map((target) => ({
					type: "version-visibility" as const,
					eid: newId(),
					ts,
					block: blockId,
					target,
					visible,
				})),
			);
			this.emitSnapshot(file, [], true);
			return changed.length;
		});
	}

	restoreRemovedVersions(file: TFile, blockId: string, versionIds: readonly string[]): Promise<number> {
		return this.setVersionsVisible(file, blockId, versionIds, true);
	}

	/** Restore the current block body to its stored HEAD. The discarded working
	 * copy is force-snapshotted first, so the operation remains recoverable. */
	revertToHead(file: TFile, blockId: string): Promise<RevertToHeadResult> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const state = (await this.readState(file))[blockId];
			const head = state?.rawHead ?? state?.head;
			if (!head) return { status: "no-head" };
			let headContent: string | null;
			try {
				headContent = await readObject(await this.requireStore(file), head);
			} catch (error) {
				return {
					status: "unavailable",
					reason: error instanceof Error ? error.message : String(error),
				};
			}
			if (headContent === null) {
				return { status: "unavailable", reason: `Mica: missing history object ${head} for ${file.path}` };
			}
			const liveDoc = await this.plugin.app.vault.read(file);
			const live = this.uniqueLiveBlock(liveDoc, blockId);
			const current = liveDoc.slice(live.content_start, live.content_end);
			if (current === headContent) return { status: "unchanged" };
			const recoveryHash = hashContent(current);
			const snapshottedDoc = (await this.doSnapshot(file, true, blockId)).doc;
			const replacement = await this.replaceUniqueBlock(file, blockId, headContent, snapshottedDoc);
			await this.commitLiveVersion(file, blockId, headContent, replacement, [
				{
					type: "move-head",
					eid: newId(),
					ts: Date.now(),
					block: blockId,
					target: state?.rawHeadVersionId ?? state?.headVersionId ?? null,
				},
			]);
			return { status: "reverted", recoveryHash, headHash: head };
		});
	}

	/** Recreate a dirty working copy without moving the durable HEAD pointer.
	 * Used only to undo Revert-to-HEAD after proving both the ledger head and
	 * live content still equal the head that operation restored. */
	restoreWorkingCopy(file: TFile, blockId: string, recoveryHash: string, expectedHead: string): Promise<void> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const state = (await this.readState(file))[blockId];
			if ((state?.rawHead ?? state?.head) !== expectedHead) {
				throw new Error("Mica: HEAD changed after the revert; the working copy was left unchanged");
			}
			const hasRecovery =
				(state?.versions ?? []).some((version) => version.hash === recoveryHash) ||
				(state?.removedVersions ?? []).some((version) => version.hash === recoveryHash);
			if (!hasRecovery) {
				throw new Error("Mica: the recovery checkpoint no longer belongs to this block");
			}
			const [recovery, headContent] = await Promise.all([
				requireObject(await this.requireStore(file), recoveryHash),
				requireObject(await this.requireStore(file), expectedHead),
			]);
			await this.plugin.app.vault.process(file, (doc) => {
				const live = this.uniqueLiveBlock(doc, blockId);
				if (doc.slice(live.content_start, live.content_end) !== headContent) {
					throw new Error("Mica: the block changed after the revert; the working copy was left unchanged");
				}
				const next = replaceBlockContent(doc, blockId, recovery);
				if (next === null) throw new Error(`Mica: cannot restore working copy for ${blockId}`);
				return next;
			});
			this.emitSnapshot(file, [], true);
		});
	}

	/** Create a verified branch version and make it the live/head content. */
	editVersion(file: TFile, blockId: string, parentRef: VersionRef, content: string): Promise<void> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const parent = await this.resolveVersion(file, blockId, parentRef);
			await requireObject(await this.requireStore(file), parent.hash);
			this.uniqueLiveBlock(await this.plugin.app.vault.read(file), blockId);
			const snapshottedDoc = (await this.doSnapshot(file, true, blockId)).doc;
			const hash = hashContent(content);
			await ensureSidecar(await this.requireStore(file));
			await writeObject(await this.requireStore(file), hash, content);
			const replacement = await this.replaceUniqueBlock(file, blockId, content, snapshottedDoc);
			const ts = Date.now();
			const checkpointId = newId();
			await this.commitLiveVersion(file, blockId, content, replacement, [
				{
					type: "checkpoint",
					eid: checkpointId,
					ts,
					block: blockId,
					hash,
					parent: parent.versionId,
					cause: "branch-edit",
				},
				{ type: "move-head", eid: newId(), ts, block: blockId, target: checkpointId },
			]);
		});
	}

	/** Append a label only after proving the version/object is valid. */
	labelVersion(file: TFile, blockId: string, ref: VersionRef, label: string): Promise<void> {
		this.stateReads.delete(file);
		this.storeReads.delete(file);
		return this.enqueue(file, async () => {
			const version = await this.resolveVersion(file, blockId, ref);
			await requireObject(await this.requireStore(file), version.hash);
			await appendEvents(await this.requireStore(file), [
				{
					type: "version-label",
					eid: newId(),
					ts: Date.now(),
					block: blockId,
					target: version.versionId,
					label: label || null,
				},
			]);
			this.emitSnapshot(file, [], true);
		});
	}

	private async resolveVersion(file: TFile, blockId: string, ref: VersionRef): Promise<VersionMeta> {
		const block = (await this.readState(file))[blockId];
		const collections = [block?.versions ?? [], block?.removedVersions ?? []] as const;
		const versionId = typeof ref === "string" ? ref : ref.versionId;
		if (versionId) {
			for (const versions of collections) {
				for (const version of versions) if (version.versionId === versionId) return version;
			}
			// Public string selectors prefer stable checkpoint identity, then
			// retain the legacy exact-hash contract when no such id exists.
			if (typeof ref !== "string")
				throw new Error(`Mica: version ${versionId} does not belong to block ${blockId}`);
		}
		const hash = typeof ref === "string" ? ref : ref.hash;
		let match: VersionMeta | null = null;
		if (hash) {
			for (const versions of collections) {
				for (const version of versions) {
					if (version.hash !== hash) continue;
					if (match)
						throw new Error(`Mica: content hash ${hash} identifies multiple checkpoints; use versionId`);
					match = version;
				}
			}
		}
		if (match) return match;
		throw new Error(`Mica: version ${hash ?? "(missing reference)"} does not belong to block ${blockId}`);
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
			await appendEvents(await this.requireStore(file), events);
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
		if ((await vault.read(file)) !== replacement.committed) await this.doSnapshot(file, true, blockId);
		this.emitSnapshot(
			file,
			events.some((event) => event.type === "add-version" || event.type === "checkpoint") ? [blockId] : [],
			true,
		);
	}

	private uniqueLiveBlock(doc: string, blockId: string): ReturnType<typeof scanBlocksView>[number] {
		let match: ReturnType<typeof scanBlocksView>[number] | null = null;
		for (const block of scanBlocksView(doc)) {
			if (!block.closed || block.id !== blockId) continue;
			if (match) throw new Error(`Mica: block id is ambiguous: ${blockId}`);
			match = block;
		}
		if (!match) throw new Error(`Mica: block not found: ${blockId}`);
		return match;
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
				let block: ReturnType<typeof scanBlocksView>[number] | null = null;
				for (const candidate of scanBlocksView(doc)) {
					if (!candidate.closed || candidate.id !== blockId) continue;
					if (block) throw new Error("block disappeared or became ambiguous");
					block = candidate;
				}
				if (!block) throw new Error("block disappeared or became ambiguous");
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

function snapshotResult(commit: SnapshotCommit): SnapshotResult {
	return {
		blockIds: commit.blockIds,
		versionsCreated: commit.versionsCreated,
		metadataChanged: commit.metadataChanged,
	};
}
