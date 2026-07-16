import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { coreVersion, initCore, scanBlocksView } from "./wasm/bridge";
import { setEditorBehavior } from "./ui/quickEdit";
import { registerViewPrefsPersistence, setEditorViewPrefs } from "./ui/mdEditor";
import { bumpConfigEpoch, micaRefreshEffect } from "./cm/micaLivePreview";
import { micaSourceHighlight } from "./cm/micaSourceHighlight";
import { micaLivePreview } from "./cm/micaLivePreview";
import { registerReadingRenderer } from "./render/readingRenderer";
import { VersionEngine } from "./version/engine";
import { ensureBlockIds, ensureNoteId } from "./identity/identity";
import { repair } from "./identity/reconcile";
import { sidecarDir } from "./storage/sidecar";
import { VersionsModal } from "./ui/versionsModal";
import { MicaApi } from "./api/mica";
import { migrateFile, migrateVault, type MigrateFileReport } from "./migrate/migrate";
import { DEFAULT_SETTINGS, MicaSettingTab, type MicaSettings } from "./settings";
import { setToolbarConfig } from "./ui/toolSpec";
import type { BlockUi } from "./ui/blockShell";

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
		this.applyToolbarConfig();
		this.engine = new VersionEngine(this);
		this.api = new MicaApi(this);
		this.api.registerBridge();
		(window as unknown as { mica?: MicaApi }).mica = this.api;

		registerReadingRenderer(this);
		this.registerEditorExtension(micaLivePreview(this));
		this.registerEditorExtension(micaSourceHighlight());
		this.addSettingTab(new MicaSettingTab(this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.engine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.engine.forgetFile(oldPath);
				if (file instanceof TFile && file.extension === "md") void this.followRename(file, oldPath);
			}),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.engine.forgetFile(file.path)));

		this.app.workspace.onLayoutReady(() => {
			this.registerSidecarExclusion();
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
			id: "insert-block",
			name: "Insert Mica block (tabs) here",
			editorCallback: (editor) => {
				const cur = editor.getCursor();
				editor.replaceRange("\n```mica\ntab: New tab\n\n```\n", cur);
				editor.setCursor({ line: cur.line + 3, ch: 0 });
			},
		});
		this.addCommand({
			id: "wrap-selection",
			name: "Wrap selection in a Mica block",
			editorCallback: (editor) => {
				const sel = editor.getSelection();
				if (!sel.trim()) {
					new Notice("Select the markdown to wrap first.");
					return;
				}
				// The fence must out-size any fence inside the selection.
				let run = 2;
				for (const m of sel.matchAll(/`+/g)) run = Math.max(run, m[0].length);
				const fence = "`".repeat(Math.max(3, run + 1));
				editor.replaceSelection(
					`${fence}mica\ntab: New tab\n${sel}${sel.endsWith("\n") ? "" : "\n"}${fence}\n`,
				);
			},
		});
		this.addCommand({
			id: "toggle-collapse",
			name: "Collapse / expand all Mica blocks in this note",
			callback: () => {
				const anyOpen = Array.from(this.micaUi.values()).some((u) => !u.collapsed);
				for (const u of this.micaUi.values()) u.collapsed = anyOpen;
				// Nudge the active editor so widgets rebuild with the new state —
				// re-dispatching the CURRENT selection rebuilds without moving it.
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				view?.previewMode?.rerender(true);
				const cm = (
					view?.editor as unknown as {
						cm?: { dispatch: (tr: object) => void; state: { selection: { main: unknown } } };
					}
				)?.cm;
				if (cm) cm.dispatch({ selection: cm.state.selection.main });
			},
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
		b.removeAttribute("data-mica-grip");
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

	/** Push the editor-toolbar configuration (layout, defaults, custom buttons). */
	applyToolbarConfig(): void {
		setToolbarConfig({
			layout: this.settings.toolbarLayout,
			defaults: this.settings.toolbarDefaults,
			customs: this.settings.customTools,
			onDefaultChange: (groupId, variantId) => {
				this.settings.toolbarDefaults[groupId] = variantId;
				void this.saveSettings();
			},
		});
	}

	/**
	 * Push appearance settings onto `body`: the theme as a class, density + tab
	 * style as data-attributes, motion as a class, and per-item overrides as
	 * inline CSS variables (which win over the theme preset). One accent drives
	 * the whole palette (chrome + borders retint from it in CSS).
	 */
	/**
	 * Rebuild every open mica widget. Needed for settings that are read at
	 * RENDER time (header mode, version chip) — CSS-variable settings apply
	 * instantly without this, and calling it is safe (drafts reopen).
	 */
	refreshViews(): void {
		bumpConfigEpoch();
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			const cm = (view.editor as unknown as { cm?: { dispatch(spec: unknown): void } }).cm;
			cm?.dispatch({ effects: micaRefreshEffect.of(null) });
			view.previewMode?.rerender(true);
		}
	}

	/**
	 * Keep `.mica/` sidecars out of search/graph/switcher: add a regex filter
	 * to Obsidian's "Excluded files" once (idempotent; user can remove it).
	 */
	private registerSidecarExclusion(): void {
		const FILTER = "/\\.mica\\//";
		type Cfg = { getConfig?(k: string): unknown; setConfig?(k: string, v: unknown): void };
		const vault = this.app.vault as unknown as Cfg;
		const current = vault.getConfig?.("userIgnoreFilters");
		if (!Array.isArray(current)) {
			if (current === undefined || current === null) vault.setConfig?.("userIgnoreFilters", [FILTER]);
			return;
		}
		if (!current.includes(FILTER)) vault.setConfig?.("userIgnoreFilters", [...current, FILTER]);
	}

	applyStyleVars(): void {
		const s = this.settings;
		const b = document.body;
		for (const c of Array.from(b.classList)) if (c.startsWith("mica-theme-")) b.removeClass(c);
		b.addClass(`mica-theme-${s.theme}`);
		b.setAttribute("data-mica-density", s.density);
		b.setAttribute("data-mica-tabstyle", s.tabStyle);
		b.setAttribute("data-mica-grip", s.dragHandlePosition);
		setEditorBehavior(s.editorClickOutside);
		setEditorViewPrefs({ lineNumbers: s.editorLineNumbers, whitespace: s.editorWhitespace });
		registerViewPrefsPersistence((p) => {
			this.settings.editorLineNumbers = p.lineNumbers;
			this.settings.editorWhitespace = p.whitespace;
			void this.saveSettings();
		});
		b.toggleClass("mica-animate", s.animations);
		b.toggleClass("mica-outlines", s.showOutlines);
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
			const { actions, rehomed, forked, buried } = await repair(this);
			if (actions.length || rehomed.length || forked.length || buried.length) {
				new Notice(
					`Mica: reconciled — ${rehomed.length} rehomed, ${forked.length} forked, ${buried.length} buried, ${actions.length} issue(s). See console.`,
				);
				console.info("Mica startup reconcile:", { rehomed, forked, buried, actions });
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
		new VersionsModal(this, file, block.id).open();
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
