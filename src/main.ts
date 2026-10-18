import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { initCore, scanBlocksView } from "./wasm/bridge";
import { installStoreLifecycle, isLiveNote } from "./storage/store";
import { initializeStorageLocation, requestStorageFolder } from "./storage/location";
import { installQuickEditGlobalListeners, setEditorBehavior } from "./ui/quickEdit";
import { registerViewPrefsPersistence, setEditorViewPrefs, setSaveShortcut } from "./ui/mdEditor";
import { bumpConfigEpoch, micaRefreshEffect } from "./cm/micaLivePreview";
import { micaSourceHighlight } from "./cm/micaSourceHighlight";
import { micaLivePreview } from "./cm/micaLivePreview";
import { registerReadingRenderer } from "./render/readingRenderer";
import { VersionEngine } from "./version/engine";
import { ensureBlockIds, ensureNoteId } from "./identity/identity";
import { repair } from "./identity/reconcile";
import { VersionsModal } from "./ui/versionsModal";
import { MicaApi } from "./api/mica";
import { createBlockSource } from "./api/blockSource";
import { migrateFile, migrateVault, type MigrateFileReport } from "./migrate/migrate";
import { DEFAULT_SETTINGS, MicaSettingTab, type MicaSettings } from "./settings";
import { setToolbarConfig } from "./ui/toolSpec";
import { disposeToolbarUi } from "./ui/toolbarView";
import type { BlockUi } from "./ui/blockShell";
import { setActionMenuTrigger } from "./ui/actionMenu";
import { normalizeCustomToolConfig } from "./ui/customToolConfig";
import { invalidateResponsiveActionStrips } from "./ui/responsiveActionStrip";
import { normalizeHiddenSectionActions } from "./ui/sectionActionPrefs";
import { normalizeDockActionLayout } from "./ui/dockConfig";

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
		try {
			await initializeStorageLocation(this);
		} catch (error) {
			new Notice(error instanceof Error ? error.message : "Mica: storage startup failed");
			throw error;
		}
		this.register(
			installStoreLifecycle(this.app.vault, async () => {
				await Promise.all([this.engine?.settled(), this.api?.settled()]);
			}),
		);
		const customConfig = normalizeCustomToolConfig(this.settings.customTools ?? [], this.settings.toolbarLayout);
		const sectionActionConfig = normalizeHiddenSectionActions(this.settings.hiddenSectionActions);
		const dockActionLayout = normalizeDockActionLayout(this.settings.dockActionLayout);
		const dockConfigChanged = JSON.stringify(dockActionLayout) !== JSON.stringify(this.settings.dockActionLayout);
		this.settings.customTools = customConfig.customTools;
		this.settings.toolbarLayout = customConfig.toolbarLayout;
		this.settings.hiddenSectionActions = sectionActionConfig.hidden;
		this.settings.dockActionLayout = dockActionLayout;
		if (customConfig.changed || sectionActionConfig.changed || dockConfigChanged) await this.saveSettings();
		this.applyStyleVars();
		this.applyToolbarConfig();
		this.engine = new VersionEngine(this);
		this.register(installQuickEditGlobalListeners());
		this.register(disposeToolbarUi);
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
				if (file instanceof TFile && file.extension === "md") {
					void this.engine
						.handleRename(file, oldPath)
						.catch((error: unknown) => {
							const detail = error instanceof Error ? error.message : String(error);
							console.error("Mica: note rename follow-up failed", { oldPath, newPath: file.path, error });
							new Notice(
								`Mica: note renamed, but its history needs attention — ${detail}. Run “Repair history”.`,
							);
						})
						.finally(() => this.refreshViews());
				} else {
					this.engine.forgetFile(oldPath);
				}
			}),
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.engine.forgetFile(file.path)));

		this.app.workspace.onLayoutReady(() => {
			if (this.settings.reconcileOnLoad) void this.reconcileOnLoad();
		});

		this.addCommand({
			id: "prepare-note",
			name: "Prepare note (add ids)",
			callback: () => void this.prepareActiveNote(),
		});
		this.addCommand({
			id: "snapshot-now",
			name: "Save versions now",
			callback: () => void this.snapshotActiveNote(),
		});
		this.addCommand({
			id: "diff-versions",
			name: "Compare block versions",
			callback: () => void this.diffActiveBlock(),
		});
		this.addCommand({
			id: "insert-block",
			name: "Insert block (tabs) here",
			editorCallback: (editor, context) => {
				if (context.file && !isLiveNote(context.file)) {
					new Notice("Mica: choose a live note outside history storage");
					return;
				}
				const cur = editor.getCursor();
				editor.replaceRange(`\n${createBlockSource({ body: "tab: New tab\n\n" })}`, cur);
				editor.setCursor({ line: cur.line + 3, ch: 0 });
			},
		});
		this.addCommand({
			id: "wrap-selection",
			name: "Wrap selection in a block",
			editorCallback: (editor, context) => {
				if (context.file && !isLiveNote(context.file)) {
					new Notice("Mica: choose a live note outside history storage");
					return;
				}
				const sel = editor.getSelection();
				if (!sel.trim()) {
					new Notice("Select the Markdown to wrap first.");
					return;
				}
				editor.replaceSelection(createBlockSource({ body: `tab: New tab\n${sel}` }));
			},
		});
		this.addCommand({
			id: "toggle-collapse",
			name: "Collapse / expand all blocks in this note",
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
			name: "Migrate legacy tabs (dry run, active note)",
			callback: () => void this.migrateActive(true),
		});
		this.addCommand({
			id: "migrate-tabs",
			name: "Migrate legacy tabs (active note)",
			callback: () => void this.migrateActive(false),
		});
		this.addCommand({
			id: "migrate-vault-dry-run",
			name: "Migrate legacy tabs (dry run, whole vault)",
			callback: () => void this.migrateWholeVault(true),
		});
		this.addCommand({
			id: "migrate-vault",
			name: "Migrate legacy tabs (whole vault)",
			callback: () => void this.migrateWholeVault(false),
		});
	}

	onunload(): void {
		this.api?.dispose();
		this.engine?.dispose();
		delete (window as unknown as { mica?: MicaApi }).mica;
		const b = document.body;
		for (const c of Array.from(b.classList)) if (c.startsWith("mica-theme-")) b.removeClass(c);
		b.removeClass("mica-animate");
		b.removeAttribute("data-mica-density");
		b.removeAttribute("data-mica-tabstyle");
		b.removeAttribute("data-mica-grip");
		b.removeAttribute("data-mica-dock-surface");
		for (const k of [
			"--mica-accent",
			"--mica-radius",
			"--mica-tab-gap",
			"--mica-content-max-height",
			"--mica-editor-max-height",
			"--mica-long-dock-custom-background",
			"--mica-long-dock-custom-foreground",
		]) {
			b.style.removeProperty(k);
		}
	}

	changeStorageFolder(draft: string): Promise<void> {
		return requestStorageFolder(this, draft);
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
				// Repaint the same default in every mounted toolbar without replacing
				// any editor document or undo history.
				this.applyToolbarConfig();
				void this.saveSettings();
			},
		});
		invalidateResponsiveActionStrips();
	}

	/** Preferences whose observable contract begins with the next editor/modal. */
	applyNextOpenSettings(): void {
		setSaveShortcut(this.settings.saveShortcut);
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

	applyStyleVars(): void {
		const s = this.settings;
		const b = document.body;
		for (const c of Array.from(b.classList)) if (c.startsWith("mica-theme-")) b.removeClass(c);
		b.addClass(`mica-theme-${s.theme}`);
		b.setAttribute("data-mica-density", s.density);
		b.setAttribute("data-mica-tabstyle", s.tabStyle);
		b.setAttribute("data-mica-grip", s.dragHandlePosition);
		b.setAttribute("data-mica-dock-surface", s.dockSurface);
		setEditorBehavior(s.editorClickOutside);
		setActionMenuTrigger(s.actionMenuTrigger);
		setEditorViewPrefs({
			lineNumbers: s.editorLineNumbers,
			whitespace: s.editorWhitespace,
			liveSyntax: s.editorLiveSyntaxStyling,
		});
		this.applyNextOpenSettings();
		registerViewPrefsPersistence((p) => {
			this.settings.editorLineNumbers = p.lineNumbers;
			this.settings.editorWhitespace = p.whitespace;
			this.settings.editorLiveSyntaxStyling = p.liveSyntax;
			void this.saveSettings();
		});
		document.dispatchEvent(new CustomEvent("mica-settings-change"));
		invalidateResponsiveActionStrips();
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
		set("--mica-long-dock-custom-background", s.dockCustomBackground);
		set("--mica-long-dock-custom-foreground", s.dockCustomForeground);
	}

	private async reconcileOnLoad(): Promise<void> {
		try {
			const { actions, rehomed, conflicted, forked, buried } = await repair(this);
			if (actions.length || rehomed.length || conflicted.length || forked.length || buried.length) {
				new Notice(
					`Mica: reconciled — ${rehomed.length} rehomed, ${forked.length} forked, ${buried.length} buried, ${conflicted.length} conflict(s), ${actions.length} issue(s).`,
				);
			}
		} catch (error) {
			this.noticeFailure("reconcile history on startup", error);
		}
	}

	private async prepareActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !isLiveNote(file)) return;
		try {
			await ensureNoteId(this, file);
			await ensureBlockIds(this, file);
			new Notice("Mica: note prepared.");
		} catch (error) {
			this.noticeFailure("prepare note", error);
		}
	}

	private async snapshotActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !isLiveNote(file)) return;
		try {
			const result = await this.engine.snapshot(file, true);
			new Notice(
				result.versionsCreated
					? `Mica: saved ${result.versionsCreated} version${result.versionsCreated === 1 ? "" : "s"}.`
					: "Mica: no versions saved — there were no changes.",
			);
		} catch (error) {
			new Notice(`Mica: could not save versions — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async diffActiveBlock(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !isLiveNote(file)) return;
		const blocks = scanBlocksView(await this.app.vault.read(file));
		const counts = new Map<string, number>();
		for (const candidate of blocks) {
			if (candidate.id) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1);
		}
		if ([...counts.values()].some((count) => count > 1)) {
			new Notice("Mica: block IDs are duplicated in this note. Repair history before comparing versions.");
			return;
		}
		const block = blocks.find((candidate) => candidate.id);
		if (!block?.id) {
			new Notice("Mica: this note has no block with an ID. Prepare the note first.");
			return;
		}
		new VersionsModal(this, file, block.id).open();
	}

	private async runRepair(): Promise<void> {
		try {
			const report = await repair(this);
			new Notice(
				`Mica repair: ${report.rehomed.length} rehomed, ${report.forked.length} forked, ${report.buried.length} buried, ${report.conflicted.length} conflict(s), ${report.actions.length} issue(s).`,
			);
		} catch (error) {
			this.noticeFailure("repair history", error);
		}
	}

	private async runInstructionFromClipboard(): Promise<void> {
		try {
			const value: unknown = JSON.parse(await navigator.clipboard.readText());
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error("Instruction must be an object with a verb and optional string arguments.");
			}
			const instruction = value as Record<string, unknown>;
			const { verb, args } = instruction;
			if (
				typeof verb !== "string" ||
				(args !== undefined &&
					(!Array.isArray(args) || !args.every((argument: unknown) => typeof argument === "string")))
			) {
				throw new Error("Instruction must have a string verb and optional string arguments.");
			}
			await this.api.runInstruction({ verb, args });
			new Notice("Mica: instruction ran.");
		} catch (e) {
			new Notice(`Mica instruction failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async migrateActive(dryRun: boolean): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !isLiveNote(file)) return;
		try {
			const report = await migrateFile(this, file, dryRun);
			if (!report) {
				new Notice("Mica: no convertible blocks from obsidian-tabs were found. Templater notes are skipped.");
				return;
			}
			this.noticeMigration([report], dryRun);
		} catch (error) {
			this.noticeFailure("migrate note", error);
		}
	}

	private async migrateWholeVault(dryRun: boolean): Promise<void> {
		try {
			const reports = await migrateVault(this, dryRun);
			if (!reports.length) {
				new Notice("Mica: no convertible blocks from obsidian-tabs were found in the vault.");
				return;
			}
			this.noticeMigration(reports, dryRun);
		} catch (error) {
			this.noticeFailure("migrate vault", error);
		}
	}

	private noticeFailure(action: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		new Notice(`Mica: could not ${action} — ${message}`);
		console.error(`Mica: could not ${action}`, error);
	}

	private noticeMigration(reports: MigrateFileReport[], dryRun: boolean): void {
		const blocks = reports.reduce((n, r) => n + r.blocks, 0);
		const versions = reports.reduce((n, r) => n + r.versionsImported, 0);
		const verb = dryRun ? "would convert" : "converted";
		const backup = reports.length === 1 ? reports[0].backup : undefined;
		new Notice(
			`Mica: ${reports.length} note(s), ${blocks} block(s) ${verb}, ${versions} archived version(s) imported.${backup ? ` Backup: ${backup}.` : ""}`,
		);
	}
}
