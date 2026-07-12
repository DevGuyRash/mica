import { normalizePath, TFile } from "obsidian";
import type MicaPlugin from "../main";
import {
	coreVersion,
	diffText,
	makePatch,
	newId,
	parseBlock,
	replaceBlockContent,
	scanBlocksView,
	serializeCst,
	setBlockAttr,
	type DiffGranularity,
	type DiffResult,
	type VersionMeta,
} from "../wasm/bridge";
import { applyOp, type StructOp } from "../cst/ops";
import { appendEvents, readObject } from "../storage/sidecar";
import { ensureBlockIds, ensureNoteId } from "../identity/identity";
import { repair, type RepairReport } from "../identity/reconcile";
import { migrateFile, migrateVault, type MigrateFileReport } from "../migrate/migrate";

const INBOX = "mica-bridge/inbox";
const OUTBOX = "mica-bridge/outbox";

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
	constructor(private readonly plugin: MicaPlugin) {}

	version(): string {
		return coreVersion();
	}

	private note(path: string): TFile {
		const f = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) throw new Error(`Not a note: ${path}`);
		return f;
	}

	async blockList(notePath: string): Promise<{ id: string | null; name: string | null }[]> {
		const doc = await this.plugin.app.vault.read(this.note(notePath));
		return scanBlocksView(doc).map((b) => ({ id: b.id, name: b.name }));
	}

	async blockRead(notePath: string, blockId: string): Promise<string> {
		const doc = await this.plugin.app.vault.read(this.note(notePath));
		const b = scanBlocksView(doc).find((x) => x.id === blockId);
		if (!b) throw new Error(`Block not found: ${blockId}`);
		return doc.slice(b.content_start, b.content_end);
	}

	async blockUpdate(notePath: string, blockId: string, content: string): Promise<void> {
		const file = this.note(notePath);
		// Snapshot BEFORE writing so an agent edit can never destroy the only
		// copy of the current content (the debounced snapshot may not have fired).
		await this.plugin.engine.snapshot(file);
		const next = replaceBlockContent(await this.plugin.app.vault.read(file), blockId, content);
		if (next === null) throw new Error(`Block not found: ${blockId}`);
		await this.plugin.app.vault.modify(file, next);
		await this.plugin.engine.snapshot(file);
	}

	async versionsList(notePath: string, blockId: string): Promise<VersionMeta[]> {
		return (await this.plugin.engine.state(this.note(notePath)))[blockId]?.versions ?? [];
	}

	async versionsSnapshot(notePath: string): Promise<void> {
		await this.plugin.engine.snapshot(this.note(notePath));
	}

	async versionsRevert(notePath: string, blockId: string, hash: string): Promise<void> {
		await this.plugin.engine.revert(this.note(notePath), blockId, hash);
	}

	async versionsDiff(
		notePath: string,
		baseHash: string,
		otherHash: string,
		granularity = "line",
	): Promise<DiffResult> {
		const [base, other] = await this.pair(notePath, baseHash, otherHash);
		return diffText(base, other, granularity as DiffGranularity, 3);
	}

	async versionsPatch(notePath: string, baseHash: string, otherHash: string): Promise<string> {
		const [base, other] = await this.pair(notePath, baseHash, otherHash);
		return makePatch(base, other, 3);
	}

	private async pair(notePath: string, baseHash: string, otherHash: string): Promise<[string, string]> {
		const file = this.note(notePath);
		const vault = this.plugin.app.vault;
		return [(await readObject(vault, file, baseHash)) ?? "", (await readObject(vault, file, otherHash)) ?? ""];
	}

	async versionsEdit(notePath: string, blockId: string, parentHash: string, content: string): Promise<void> {
		await this.plugin.engine.editVersion(this.note(notePath), blockId, parentHash, content);
	}

	/** Label (or clear the label of) a stored version. */
	async versionsLabel(notePath: string, blockId: string, hash: string, label: string): Promise<void> {
		await appendEvents(this.plugin.app.vault, this.note(notePath), [
			{ type: "label", eid: newId(), ts: Date.now(), block: blockId, hash, label: label || null },
		]);
	}

	/**
	 * Apply one structural op (the same shapes the UI and the mica CLI use:
	 * insertTab, renameTab, moveNode, …) to a block, corruption-proof.
	 */
	async blockApply(notePath: string, blockId: string, op: StructOp): Promise<boolean> {
		const file = this.note(notePath);
		await this.plugin.engine.snapshot(file); // pre-image
		const doc = await this.plugin.app.vault.read(file);
		const b = scanBlocksView(doc).find((x) => x.id === blockId);
		if (!b) throw new Error(`Block not found: ${blockId}`);
		const { changed, cst } = applyOp(parseBlock(doc.slice(b.content_start, b.content_end)), op);
		if (!changed) return false;
		const next = replaceBlockContent(doc, blockId, serializeCst(cst));
		if (next === null) throw new Error(`Block not found: ${blockId}`);
		await this.plugin.app.vault.modify(file, next);
		await this.plugin.engine.snapshot(file);
		return true;
	}

	/** Set / remove one fence-header attribute (name, accent, density, …). */
	async blockSetAttr(notePath: string, blockId: string, key: string, value: string | null): Promise<void> {
		const file = this.note(notePath);
		const doc = await this.plugin.app.vault.read(file);
		const next = setBlockAttr(doc, blockId, key, value);
		if (next === null) throw new Error(`Cannot set ${key} on block ${blockId}`);
		if (next !== doc) await this.plugin.app.vault.modify(file, next);
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

	private verbTable(): Record<string, (...args: string[]) => Promise<unknown>> {
		return {
			"block.list": (n) => this.blockList(n),
			"block.read": (n, id) => this.blockRead(n, id),
			"block.update": (n, id, c) => this.blockUpdate(n, id, c),
			"versions.list": (n, id) => this.versionsList(n, id),
			"versions.snapshot": (n) => this.versionsSnapshot(n),
			"versions.revert": (n, id, h) => this.versionsRevert(n, id, h),
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
	}

	async runInstruction(instruction: Instruction): Promise<unknown> {
		const fn = this.verbTable()[instruction.verb];
		if (!fn) throw new Error(`Unknown verb: ${instruction.verb}`);
		return fn(...(instruction.args ?? []));
	}

	/**
	 * Watch the inbox for instruction JSON dropped by agents/scripts.
	 *
	 * Registered inside `onLayoutReady`: Obsidian fires `create` for every
	 * existing file during vault load, so registering earlier would REPLAY every
	 * old instruction (including destructive ones) on every app launch. Each
	 * inbox file is also deleted after processing, so it can only ever run once.
	 */
	registerBridge(): void {
		this.plugin.app.workspace.onLayoutReady(() => {
			this.plugin.registerEvent(
				this.plugin.app.vault.on("create", (f) => {
					if (f instanceof TFile && f.path.startsWith(`${INBOX}/`) && f.extension === "json") {
						void this.processInbox(f);
					}
				}),
			);
		});
	}

	private async processInbox(file: TFile): Promise<void> {
		const vault = this.plugin.app.vault;
		let result: unknown;
		let error: string | null = null;
		try {
			result = await this.runInstruction(JSON.parse(await vault.read(file)) as Instruction);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		// Consume the instruction so it can never replay.
		await vault.delete(file).catch((e) => console.error("Mica bridge: failed to consume inbox file", file.path, e));
		try {
			if (!vault.getAbstractFileByPath(OUTBOX)) await vault.createFolder(OUTBOX);
			const out = normalizePath(`${OUTBOX}/${file.basename}.json`);
			const existing = vault.getAbstractFileByPath(out);
			if (existing instanceof TFile) await vault.delete(existing);
			await vault.create(out, JSON.stringify({ ok: error === null, result, error }, null, 2));
		} catch (e) {
			// Never hang an agent silently: the failure is at least observable.
			console.error("Mica bridge: failed to write outbox result for", file.path, e);
		}
	}
}
