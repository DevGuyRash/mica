import { normalizePath, Notice, TFile } from "obsidian";
import type MicaPlugin from "../main";
import {
	coreVersion,
	hashContent,
	resolveObjectHash,
	diffText,
	makePatch,
	replaceBlockContent,
	scanBlocksView,
	setBlockAttr,
	type DiffGranularity,
	type DiffResult,
	type VersionMeta,
} from "../wasm/bridge";
import { applyOpText, type StructOp } from "../cst/ops";
import { interactiveDiffIssue } from "../diff/budget";
import { readLedger, requireObject } from "../storage/sidecar";
import {
	assertNoteStoreCurrent,
	assertStoreRootCurrent,
	ensureStoreFolder,
	isLiveNote,
	storeRoot,
	validateStoreRoot,
	type StoreRoot,
} from "../storage/store";
import { ensureBlockIds, ensureNoteId } from "../identity/identity";
import { repair, type RepairReport } from "../identity/reconcile";
import { migrateFile, migrateVault, type MigrateFileReport } from "../migrate/migrate";
import { createBlockSource, type CreateBlockSourceOptions } from "./blockSource";

interface Instruction {
	verb: string;
	args?: string[];
}

/**
 * The full programmatic surface of Mica. Exposed as `window.mica` (drivable from
 * the dev console and scripting plugins) and via a file-bridge so agents can
 * drive it headlessly by dropping instruction JSON into an inbox folder. Every
 * verb routes through the same corruption-proof core the UI uses.
 */
export class MicaApi {
	private disposed = false;
	private readonly bridgeTasks = new Set<Promise<void>>();
	private readonly pendingInbox = new Set<TFile>();
	private bridgePump: Promise<void> | null = null;
	private queueFullReported = false;
	constructor(private readonly plugin: MicaPlugin) {}

	/** Stop admission synchronously; already admitted work stays owned until settled. */
	dispose(): void {
		this.disposed = true;
		this.pendingInbox.clear();
	}

	settled(): Promise<void> {
		return Promise.allSettled([...this.bridgeTasks]).then(() => undefined);
	}

	private isCurrentInbox(file: TFile, root: StoreRoot, path = file.path): boolean {
		return (
			!this.disposed &&
			file.vault === root.vault &&
			file.path === path &&
			file.extension === "json" &&
			path.startsWith(`${root.paths.bridgeInbox}/`) &&
			root.vault.getAbstractFileByPath(path) === file
		);
	}

	/** Serialize file generations; own consumption notifications reduce to no-ops. */
	private enqueueInbox(file: TFile): void {
		const root = storeRoot(this.plugin.app.vault);
		if (!this.isCurrentInbox(file, root)) return;
		if (!this.pendingInbox.has(file) && this.pendingInbox.size >= 128) {
			if (!this.queueFullReported)
				console.error("Mica bridge: inbox queue is full; unconsumed requests were preserved for retry");
			this.queueFullReported = true;
			return;
		}
		this.pendingInbox.add(file);
		if (this.bridgePump) return;
		const pump = (async () => {
			while (!this.disposed && this.pendingInbox.size) {
				const next = this.pendingInbox.values().next().value!;
				this.pendingInbox.delete(next);
				try {
					await this.processInbox(next);
				} catch (error) {
					console.error("Mica bridge: request did not complete; inspect its inbox record", error);
				}
			}
		})().finally(() => {
			this.bridgeTasks.delete(pump);
			this.bridgePump = null;
			this.queueFullReported = false;
		});
		this.bridgePump = pump;
		this.bridgeTasks.add(pump);
	}

	private superviseBridge(work: () => Promise<void>): void {
		if (this.disposed) return;
		const task = Promise.resolve()
			.then(() => {
				if (!this.disposed) return work();
			})
			.catch((error: unknown) => console.error("Mica bridge: operation did not finish", error))
			.finally(() => this.bridgeTasks.delete(task));
		this.bridgeTasks.add(task);
	}

	version(): string {
		return coreVersion();
	}

	/** Build a complete UUID-addressed Mica fence for templates/scripts. */
	createBlockSource(options: CreateBlockSourceOptions): string {
		return createBlockSource(options);
	}

	private note(path: string): TFile {
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile) || !isLiveNote(f)) throw new Error(`Not a live note: ${path}`);
		return f;
	}

	async blockList(notePath: string): Promise<{ id: string | null; name: string | null }[]> {
		const doc = await this.plugin.app.vault.read(this.note(notePath));
		return scanBlocksView(doc).map((b) => ({ id: b.id, name: b.name }));
	}

	async blockRead(notePath: string, blockId: string): Promise<string> {
		const doc = await this.plugin.app.vault.read(this.note(notePath));
		const b = uniqueBlock(doc, blockId);
		return doc.slice(b.content_start, b.content_end);
	}

	async blockUpdate(notePath: string, blockId: string, content: string): Promise<void> {
		const file = this.note(notePath);
		// Snapshot BEFORE writing so an agent edit can never destroy the only
		// copy of the current content (the debounced snapshot may not have fired).
		await this.plugin.engine.mutate(
			file,
			(doc) => {
				uniqueBlock(doc, blockId);
				const next = replaceBlockContent(doc, blockId, content);
				if (next === null) throw new Error(`Cannot update block: ${blockId}`);
				return { doc: next, result: undefined };
			},
			{ snapshotBefore: true, snapshotAfter: true },
		);
	}

	async versionsList(notePath: string, blockId: string): Promise<VersionMeta[]> {
		return (await this.plugin.engine.state(this.note(notePath)))[blockId]?.versions ?? [];
	}

	async versionsRemoved(notePath: string, blockId: string): Promise<VersionMeta[]> {
		return (await this.plugin.engine.state(this.note(notePath)))[blockId]?.removedVersions ?? [];
	}

	async versionsSnapshot(notePath: string): ReturnType<MicaPlugin["engine"]["snapshot"]> {
		return this.plugin.engine.snapshot(this.note(notePath));
	}

	async versionsRevert(notePath: string, blockId: string, versionSelector: string): Promise<void> {
		await this.plugin.engine.revert(this.note(notePath), blockId, versionSelector);
	}

	async versionsRestoreCheckpoint(notePath: string, blockId: string, versionId: string): Promise<boolean> {
		return this.plugin.engine.restoreAsCheckpoint(this.note(notePath), blockId, { versionId });
	}

	async versionsResetHead(notePath: string, blockId: string, versionId: string): Promise<boolean> {
		return this.plugin.engine.resetHeadToVersion(this.note(notePath), blockId, { versionId });
	}

	async versionsSetVisible(
		notePath: string,
		blockId: string,
		versionIds: readonly string[],
		visible: boolean,
	): Promise<number> {
		return this.plugin.engine.setVersionsVisible(this.note(notePath), blockId, versionIds, visible);
	}

	async versionsDiff(
		notePath: string,
		baseHash: string,
		otherHash: string,
		granularity = "line",
	): Promise<DiffResult> {
		const [base, other] = await this.pair(notePath, baseHash, otherHash);
		const resolved = parseDiffGranularity(granularity);
		const issue = interactiveDiffIssue(base, other, resolved);
		if (issue) throw new Error(`Mica: ${issue}; use the mica CLI for this comparison`);
		return diffText(base, other, resolved, 3);
	}

	async versionsPatch(notePath: string, baseHash: string, otherHash: string): Promise<string> {
		const [base, other] = await this.pair(notePath, baseHash, otherHash);
		const issue = interactiveDiffIssue(base, other, "line");
		if (issue) throw new Error(`Mica: ${issue}; use the mica CLI for this comparison`);
		return makePatch(base, other, 3);
	}

	private async pair(notePath: string, baseHash: string, otherHash: string): Promise<[string, string]> {
		const store = await this.plugin.engine.historyStore(this.note(notePath));
		if (!store) throw new Error("Mica: this note has no prepared history");
		// Pool membership does not imply membership in this note's history.
		const allowed = new Set<string>();
		for (const event of await readLedger(store)) {
			if ("hash" in event) allowed.add(resolveObjectHash(event.hash, store.aliases));
			if (event.type === "add-version" && event.parent)
				allowed.add(resolveObjectHash(event.parent, store.aliases));
		}
		for (const hash of [baseHash, otherHash]) {
			if (!allowed.has(resolveObjectHash(hash, store.aliases)))
				throw new Error("Mica: requested object is not referenced by this note's history");
		}
		const pair: [string, string] = [await requireObject(store, baseHash), await requireObject(store, otherHash)];
		await assertNoteStoreCurrent(store);
		return pair;
	}

	async versionsEdit(notePath: string, blockId: string, parentSelector: string, content: string): Promise<void> {
		await this.plugin.engine.editVersion(this.note(notePath), blockId, parentSelector, content);
	}

	/** Label (or clear the label of) a stored version. */
	async versionsLabel(notePath: string, blockId: string, versionSelector: string, label: string): Promise<void> {
		await this.plugin.engine.labelVersion(this.note(notePath), blockId, versionSelector, label);
	}

	/**
	 * Apply one structural op (the same shapes the UI and the mica CLI use:
	 * insertTab, renameTab, moveNode, …) to a block, corruption-proof.
	 */
	async blockApply(notePath: string, blockId: string, op: StructOp): Promise<boolean> {
		const file = this.note(notePath);
		return this.plugin.engine.mutate(
			file,
			(doc) => {
				const block = uniqueBlock(doc, blockId);
				const { changed, text } = applyOpText(doc.slice(block.content_start, block.content_end), op);
				if (!changed) return { doc, result: false };
				const next = replaceBlockContent(doc, blockId, text);
				if (next === null) throw new Error(`Cannot update block: ${blockId}`);
				return { doc: next, result: true };
			},
			{ snapshotBefore: true, snapshotAfter: true },
		);
	}

	/** Set / remove one fence-header attribute (name, accent, density, …). */
	async blockSetAttr(notePath: string, blockId: string, key: string, value: string | null): Promise<void> {
		const file = this.note(notePath);
		await this.plugin.engine.mutate(file, (doc) => {
			uniqueBlock(doc, blockId);
			const next = setBlockAttr(doc, blockId, key, value);
			if (next === null) throw new Error(`Cannot set ${key} on block ${blockId}`);
			return { doc: next, result: undefined };
		});
	}

	async prepare(notePath: string): Promise<string> {
		const file = this.note(notePath);
		const id = await ensureNoteId(this.plugin, file);
		await ensureBlockIds(this.plugin, file);
		return id;
	}

	async repair(): Promise<RepairReport> {
		return repair(this.plugin);
	}

	/** Dry-run report of every convertible legacy-tabs note in the vault. */
	async migrateScan(): Promise<MigrateFileReport[]> {
		return migrateVault(this.plugin, true);
	}

	/** Migrate one note (path given) or the whole vault (no args). */
	async migrateRun(notePath?: string): Promise<MigrateFileReport[]> {
		if (notePath) {
			const report = await migrateFile(this.plugin, this.note(notePath), false);
			return report ? [report] : [];
		}
		return migrateVault(this.plugin, false);
	}

	// --- dispatch + file-bridge ------------------------------------------

	private readonly verbs: Record<string, (...args: string[]) => Promise<unknown>> = {
		"block.source": (body, name?) => Promise.resolve(this.createBlockSource({ body, name })),
		"block.list": (n) => this.blockList(n),
		"block.read": (n, id) => this.blockRead(n, id),
		"block.update": (n, id, c) => this.blockUpdate(n, id, c),
		"versions.list": (n, id) => this.versionsList(n, id),
		"versions.removed": (n, id) => this.versionsRemoved(n, id),
		"versions.snapshot": (n) => this.versionsSnapshot(n),
		"versions.revert": (n, id, h) => this.versionsRevert(n, id, h),
		"versions.restore-checkpoint": (n, id, versionId) => this.versionsRestoreCheckpoint(n, id, versionId),
		"versions.reset-head": (n, id, versionId) => this.versionsResetHead(n, id, versionId),
		"versions.set-visible": (n, id, visible, ...versionIds) =>
			this.versionsSetVisible(n, id, versionIds, visible === "true"),
		"versions.visibility": (n, id, visible, ...versionIds) =>
			this.versionsSetVisible(n, id, versionIds, visible === "true"),
		"versions.diff": (n, b, o, g) => this.versionsDiff(n, b, o, g),
		"versions.patch": (n, b, o) => this.versionsPatch(n, b, o),
		"versions.edit": (n, id, parent, c) => this.versionsEdit(n, id, parent, c),
		"versions.label": (n, id, h, l) => this.versionsLabel(n, id, h, l ?? ""),
		"block.apply": (n, id, op) => this.blockApply(n, id, JSON.parse(op) as StructOp),
		"block.attr": (n, id, k, v) => this.blockSetAttr(n, id, k, v ?? null),
		"migrate.scan": () => this.migrateScan(),
		"migrate.run": (n?) => this.migrateRun(n),
		prepare: (n) => this.prepare(n),
		repair: () => this.repair(),
	};

	async runInstruction(instruction: Instruction): Promise<unknown> {
		const fn = this.verbs[instruction.verb];
		if (!fn) throw new Error(`Unknown verb: ${instruction.verb}`);
		return fn(...(instruction.args ?? []));
	}

	/**
	 * Watch the inbox for instruction JSON dropped by agents/scripts.
	 *
	 * Registered inside `onLayoutReady`: Obsidian fires `create` for every
	 * existing file during vault load, so registering earlier would REPLAY every
	 * old instruction (including destructive ones) on every app launch. Each
	 * inbox generation is replaced with a consumed marker under an exact-byte guard.
	 */
	registerBridge(): void {
		this.plugin.register(() => this.dispose());
		this.plugin.app.workspace.onLayoutReady(() => {
			if (this.disposed) return;
			this.superviseBridge(async () => {
				try {
					await this.initializeBridge();
				} catch (error) {
					if (this.disposed) return;
					console.error("Mica bridge: storage initialization failed", error);
					new Notice(
						`Mica: history storage is unavailable. ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
		});
	}

	private async initializeBridge(): Promise<void> {
		const root = storeRoot(this.plugin.app.vault);
		await validateStoreRoot(root, true);
		if (this.disposed) return;
		await ensureStoreFolder(root, root.paths.bridgeInbox);
		if (this.disposed) return;
		await ensureStoreFolder(root, root.paths.bridgeOutbox);
		if (this.disposed) return;
		// Register after initial load and folder creation; never replay existing inbox files.
		const enqueue = (file: unknown): void => {
			if (file instanceof TFile) this.enqueueInbox(file);
		};
		this.plugin.registerEvent(root.vault.on("create", enqueue));
		this.plugin.registerEvent(root.vault.on("modify", enqueue));
	}

	private async processInbox(file: TFile): Promise<void> {
		if (this.disposed) return;
		const vault = this.plugin.app.vault;
		const root = storeRoot(vault);
		const path = file.path;
		// A queued TFile can be renamed while another request is running. Admission
		// must still belong to the selected inbox, not merely to the same object.
		if (!this.isCurrentInbox(file, root, path)) return;
		const out = normalizePath(`${root.paths.bridgeOutbox}/${file.basename}.json`);
		const storeId = await validateStoreRoot(root);
		if (this.disposed) return;
		assertStoreRootCurrent(root);
		if (!this.isCurrentInbox(file, root, path)) throw new Error("Mica: inbox file moved before execution");
		if (!storeId) throw new Error("Mica: initialize history storage before using the bridge");
		const mtime = file.stat.mtime,
			size = file.stat.size;
		const text = await vault.read(file);
		if (this.disposed) return;
		assertStoreRootCurrent(root);
		if (!this.isCurrentInbox(file, root, path) || file.stat.mtime !== mtime || file.stat.size !== size)
			throw new Error("Mica: inbox generation changed while being read; request was preserved");
		let result: unknown;
		let error: string | null = null;
		try {
			const instruction: unknown = JSON.parse(text);
			if (isConsumedInstruction(instruction)) return;
			const parsed = parseInstruction(instruction);
			assertStoreRootCurrent(root);
			if (!this.isCurrentInbox(file, root, path) || file.stat.mtime !== mtime || file.stat.size !== size)
				throw new Error("Mica: inbox file changed before execution");
			result = await this.runInstruction(parsed);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		if (this.disposed) return;
		if ((await validateStoreRoot(root)) !== storeId)
			throw new Error("Mica: history store changed during instruction processing");
		if (this.disposed) return;
		// Serialize before consumption: if later outbox publication fails, the
		// non-executable inbox record retains the exact outcome without replay.
		const body = JSON.stringify({ ok: error === null, result, error }, null, 2);
		// Trash has no compare-and-swap API. Replace only the executed bytes so
		// a newer Sync/editor instruction is preserved.
		const consumed = JSON.stringify({ micaConsumed: 1, instructionHash: hashContent(text), response: body }) + "\n";
		assertStoreRootCurrent(root);
		if (!this.isCurrentInbox(file, root, path)) throw new Error("Mica: inbox file moved; request was preserved");
		await vault.process(file, (current) => {
			assertStoreRootCurrent(root);
			if (!this.isCurrentInbox(file, root, path) || current !== text)
				throw new Error("Mica: inbox generation changed; newer content was preserved");
			return consumed;
		});
		if (this.disposed) return;
		if ((await validateStoreRoot(root)) !== storeId)
			throw new Error("Mica: history store changed before response publication");
		if (this.disposed) return;
		await ensureStoreFolder(root, root.paths.bridgeOutbox);
		if (this.disposed) return;
		assertStoreRootCurrent(root);
		const existing = vault.getAbstractFileByPath(out);
		if (existing instanceof TFile) {
			const previous = await vault.read(existing);
			if (this.disposed) return;
			assertStoreRootCurrent(root);
			await vault.process(existing, (current) => {
				assertStoreRootCurrent(root);
				if (
					this.disposed ||
					existing.path !== out ||
					vault.getAbstractFileByPath(out) !== existing ||
					current !== previous
				)
					throw new Error("Mica: newer bridge response was preserved");
				return body;
			});
		} else {
			assertStoreRootCurrent(root);
			await vault.create(out, body);
		}
	}
}

function isConsumedInstruction(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"micaConsumed" in value &&
		value.micaConsumed === 1 &&
		"instructionHash" in value &&
		typeof value.instructionHash === "string"
	);
}

function parseInstruction(value: unknown): Instruction {
	if (typeof value !== "object" || value === null || !("verb" in value) || typeof value.verb !== "string")
		throw new Error("Mica: bridge instruction requires a string verb");
	if (!("args" in value)) return { verb: value.verb };
	if (!Array.isArray(value.args)) throw new Error("Mica: bridge instruction arguments must be strings");
	const rawArgs: unknown[] = value.args;
	const args: string[] = [];
	for (const arg of rawArgs) {
		if (typeof arg !== "string") throw new Error("Mica: bridge instruction arguments must be strings");
		args.push(arg);
	}
	return { verb: value.verb, args };
}

function uniqueBlock(doc: string, blockId: string): ReturnType<typeof scanBlocksView>[number] {
	let match: ReturnType<typeof scanBlocksView>[number] | null = null;
	for (const block of scanBlocksView(doc)) {
		if (!block.closed || block.id !== blockId) continue;
		if (match) throw new Error(`Block id is ambiguous: ${blockId}; run Mica repair first`);
		match = block;
	}
	if (!match) throw new Error(`Block not found: ${blockId}`);
	return match;
}

function parseDiffGranularity(value: string): DiffGranularity {
	switch (value) {
		case "line":
		case "word":
		case "char":
		case "line-word":
		case "line-char":
			return value;
		default:
			throw new Error(`Mica: unsupported diff granularity ${JSON.stringify(value)}`);
	}
}
