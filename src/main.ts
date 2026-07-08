import { Notice, Plugin, TFile } from "obsidian";
import { coreVersion, initCore, scanBlocksView } from "./wasm/bridge";
import { micaLivePreview } from "./cm/micaLivePreview";
import { registerReadingRenderer } from "./render/readingRenderer";
import { VersionEngine } from "./version/engine";
import { ensureBlockIds, ensureNoteId } from "./identity/identity";
import { repair } from "./identity/reconcile";
import { sidecarDir } from "./storage/sidecar";
import { DiffModal } from "./diff/diffModal";
import { MicaApi } from "./api/mica";
import { migrateFile, migrateVault, type MigrateFileReport } from "./migrate/migrate";
import { DEFAULT_SETTINGS, MicaSettingTab, type MicaSettings } from "./settings";
import type { BlockUi } from "./render/layoutEngine";

/**
 * Mica plugin entry point. Wires the WASM core, the three-mode renderer, the
 * versioning engine, settings, and the scriptable API + agent bridge.
 */
export default class MicaPlugin extends Plugin {
	engine!: VersionEngine;
	api!: MicaApi;
	settings!: MicaSettings;
	/** Per-block UI state (active tab per group + a pending focus target), keyed
	 * by block id/position so it survives the widget rebuild after each edit. */
	readonly micaUi = new Map<string, BlockUi>();

	async onload(): Promise<void> {
		await initCore();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<MicaSettings> | null);
		this.applyStyleVars();
		this.engine = new VersionEngine(this);
		this.api = new MicaApi(this);
		this.api.registerBridge();
		(window as unknown as { mica?: MicaApi }).mica = this.api;

		registerReadingRenderer(this);
		this.registerEditorExtension(micaLivePreview(this));
		this.addSettingTab(new MicaSettingTab(this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.engine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") void this.followRename(file, oldPath);
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.reconcileOnLoad) void this.reconcileOnLoad();
		});

		this.addCommand({
			id: "prepare-note",
			name: "Prepare note for Mica (add ids)",
			callback: () => void this.prepareActiveNote(),
		});
		this.addCommand({
			id: "snapshot-now",
			name: "Snapshot versions now",
			callback: () => void this.snapshotActiveNote(),
		});
		this.addCommand({
			id: "diff-versions",
			name: "Compare block versions",
			callback: () => void this.diffActiveBlock(),
		});
		this.addCommand({
			id: "repair",
			name: "Repair history (reconcile)",
			callback: () => void this.runRepair(),
		});
		this.addCommand({
			id: "run-instruction",
			name: "Run instruction (JSON from clipboard)",
			callback: () => void this.runInstructionFromClipboard(),
		});
		this.addCommand({
			id: "migrate-tabs-dry-run",
			name: "Migrate tabs → Mica (dry run, active note)",
			callback: () => void this.migrateActive(true),
		});
		this.addCommand({
			id: "migrate-tabs",
			name: "Migrate tabs → Mica (active note)",
			callback: () => void this.migrateActive(false),
		});
		this.addCommand({
			id: "migrate-vault-dry-run",
			name: "Migrate tabs → Mica (dry run, whole vault)",
			callback: () => void this.migrateWholeVault(true),
		});
		this.addCommand({
			id: "migrate-vault",
			name: "Migrate tabs → Mica (whole vault)",
			callback: () => void this.migrateWholeVault(false),
		});

		console.info(`Mica: loaded (plugin v${this.manifest.version}, core v${coreVersion()})`);
	}

	onunload(): void {
		delete (window as unknown as { mica?: MicaApi }).mica;
		const b = document.body;
		for (const c of Array.from(b.classList)) if (c.startsWith("mica-theme-")) b.removeClass(c);
		b.removeClass("mica-animate");
		b.removeAttribute("data-mica-density");
		b.removeAttribute("data-mica-tabstyle");
		for (const k of [
			"--mica-accent",
			"--mica-radius",
			"--mica-tab-gap",
			"--mica-content-max-height",
			"--mica-editor-max-height",
		]) {
			b.style.removeProperty(k);
		}
		console.info("Mica: unloaded");
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Push appearance settings onto `body`: the theme as a class, density + tab
	 * style as data-attributes, motion as a class, and per-item overrides as
	 * inline CSS variables (which win over the theme preset). One accent drives
	 * the whole palette (chrome + borders retint from it in CSS).
	 */
	applyStyleVars(): void {
		const s = this.settings;
		const b = document.body;
		for (const c of Array.from(b.classList)) if (c.startsWith("mica-theme-")) b.removeClass(c);
		b.addClass(`mica-theme-${s.theme}`);
		b.setAttribute("data-mica-density", s.density);
		b.setAttribute("data-mica-tabstyle", s.tabStyle);
		b.toggleClass("mica-animate", s.animations);
		const set = (k: string, v: string | null): void => {
			if (v === null) b.style.removeProperty(k);
			else b.style.setProperty(k, v);
		};
		set("--mica-accent", s.accentColor || null); // empty = theme/Obsidian accent
		set("--mica-radius", `${s.cardRadiusPx}px`);
		set("--mica-tab-gap", `${s.tabGapPx}px`);
		set("--mica-content-max-height", s.limitContentHeight ? `${s.contentMaxHeightPx}px` : "none");
		set("--mica-editor-max-height", `${s.editorMaxHeightPx}px`);
	}

	private async reconcileOnLoad(): Promise<void> {
		try {
			const { actions, rehomed } = await repair(this);
			if (actions.length || rehomed.length) {
				new Notice(`Mica: reconciled — ${rehomed.length} rehomed, ${actions.length} issue(s). See console.`);
				console.info("Mica startup reconcile:", { rehomed, actions });
			}
		} catch (e) {
			console.error("Mica: startup reconcile failed", e);
		}
	}

	private async prepareActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		await ensureNoteId(this, file);
		await ensureBlockIds(this, file);
	}

	private async snapshotActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file) await this.engine.snapshot(file);
	}

	private async diffActiveBlock(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const block = scanBlocksView(await this.app.vault.read(file)).find((b) => b.id);
		if (!block?.id) {
			new Notice("No Mica block with an id in this note. Run “Prepare note for Mica” first.");
			return;
		}
		new DiffModal(this, file, block.id).open();
	}

	private async followRename(file: TFile, oldPath: string): Promise<void> {
		const oldSidecar = `${oldPath.slice(0, oldPath.length - file.extension.length - 1)}.mica`;
		const af = this.app.vault.getAbstractFileByPath(oldSidecar);
		if (af) await this.app.vault.rename(af, sidecarDir(file)).catch(() => undefined);
	}

	private async runRepair(): Promise<void> {
		const { actions, rehomed } = await repair(this);
		new Notice(`Mica repair: ${rehomed.length} rehomed, ${actions.length} issue(s). See console.`);
		if (actions.length || rehomed.length) console.info("Mica repair:", { rehomed, actions });
	}

	private async runInstructionFromClipboard(): Promise<void> {
		try {
			const result = await this.api.runInstruction(JSON.parse(await navigator.clipboard.readText()));
			new Notice("Mica: instruction ran (result in console).");
			console.info("Mica instruction result:", result);
		} catch (e) {
			new Notice(`Mica instruction failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async migrateActive(dryRun: boolean): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const report = await migrateFile(this, file, dryRun);
		if (!report) {
			new Notice("No convertible obsidian-tabs blocks found (Templater notes are skipped).");
			return;
		}
		this.noticeMigration([report], dryRun);
	}

	private async migrateWholeVault(dryRun: boolean): Promise<void> {
		const reports = await migrateVault(this, dryRun);
		if (!reports.length) {
			new Notice("No convertible obsidian-tabs blocks found anywhere in the vault.");
			return;
		}
		this.noticeMigration(reports, dryRun);
	}

	private noticeMigration(reports: MigrateFileReport[], dryRun: boolean): void {
		const blocks = reports.reduce((n, r) => n + r.blocks, 0);
		const versions = reports.reduce((n, r) => n + r.versionsImported, 0);
		const verb = dryRun ? "would convert" : "converted";
		new Notice(
			`Mica: ${reports.length} note(s), ${blocks} block(s) ${verb}, ${versions} archived version(s) imported. Details in console.`,
		);
		console.info(`Mica migration ${dryRun ? "(dry run)" : ""}:`, reports);
	}
}
