import { PluginSettingTab, Setting } from "obsidian";
import type MicaPlugin from "./main";
import { OBSIDIAN_CALLOUT_TYPES, type DiffGranularity } from "./wasm/bridge";

export interface MicaSettings {
	/** Idle time before an auto-snapshot fires after an edit. */
	snapshotDebounceMs: number;
	defaultGranularity: DiffGranularity;
	defaultDiffMode: "inline" | "side-by-side" | "patch";
	showVersionChip: boolean;
	reconcileOnLoad: boolean;
	/** Auto-stamp a stable id on `mica` blocks so versioning + inline editing just work. */
	autoAddIds: boolean;
	/** Cap tab/cell height and show a scrollbar past it. */
	limitContentHeight: boolean;
	contentMaxHeightPx: number;
	/** Grow the inline editor with content (up to its max); otherwise fixed + scroll. */
	editorAutosize: boolean;
	editorMaxHeightPx: number;
	/** Comma-separated callout types imported as versions on migration (empty = any). */
	versionCalloutTypes: string;
}

export const DEFAULT_SETTINGS: MicaSettings = {
	snapshotDebounceMs: 1500,
	defaultGranularity: "line",
	defaultDiffMode: "inline",
	showVersionChip: true,
	reconcileOnLoad: true,
	autoAddIds: true,
	limitContentHeight: false,
	contentMaxHeightPx: 400,
	editorAutosize: true,
	editorMaxHeightPx: 400,
	versionCalloutTypes: OBSIDIAN_CALLOUT_TYPES,
};

export class MicaSettingTab extends PluginSettingTab {
	constructor(private readonly micaPlugin: MicaPlugin) {
		super(micaPlugin.app, micaPlugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Snapshot debounce")
			.setDesc("Idle milliseconds after an edit before versions auto-snapshot (500–10000).")
			.addSlider((s) =>
				s
					.setLimits(500, 10000, 250)
					.setValue(this.micaPlugin.settings.snapshotDebounceMs)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.micaPlugin.settings.snapshotDebounceMs = v;
						this.micaPlugin.engine.resetDebouncers();
						await this.micaPlugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Default diff granularity").addDropdown((d) =>
			d
				.addOption("line", "Line")
				.addOption("word", "Word")
				.addOption("char", "Char")
				.setValue(this.micaPlugin.settings.defaultGranularity)
				.onChange(async (v) => {
					this.micaPlugin.settings.defaultGranularity = v as DiffGranularity;
					await this.micaPlugin.saveSettings();
				}),
		);

		new Setting(containerEl).setName("Default diff mode").addDropdown((d) =>
			d
				.addOption("inline", "Inline")
				.addOption("side-by-side", "Side by side")
				.addOption("patch", "Patch")
				.setValue(this.micaPlugin.settings.defaultDiffMode)
				.onChange(async (v) => {
					this.micaPlugin.settings.defaultDiffMode = v as MicaSettings["defaultDiffMode"];
					await this.micaPlugin.saveSettings();
				}),
		);

		new Setting(containerEl)
			.setName("Automatically add block ids")
			.setDesc(
				"Stamp a stable id onto each Mica block shortly after you edit, so version history and the inline editor work without running a command. Turn off if you prefer to add ids manually.",
			)
			.addToggle((t) =>
				t.setValue(this.micaPlugin.settings.autoAddIds).onChange(async (v) => {
					this.micaPlugin.settings.autoAddIds = v;
					await this.micaPlugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Show version chip on blocks")
			.setDesc("The v-count badge (with dirty dot) and History button under each rendered block.")
			.addToggle((t) =>
				t.setValue(this.micaPlugin.settings.showVersionChip).onChange(async (v) => {
					this.micaPlugin.settings.showVersionChip = v;
					await this.micaPlugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Reconcile history on startup")
			.setDesc("Scan for orphaned/moved histories when the vault opens and report issues.")
			.addToggle((t) =>
				t.setValue(this.micaPlugin.settings.reconcileOnLoad).onChange(async (v) => {
					this.micaPlugin.settings.reconcileOnLoad = v;
					await this.micaPlugin.saveSettings();
				}),
			);

		new Setting(containerEl).setHeading().setName("Layout & editing");

		new Setting(containerEl)
			.setName("Limit content height")
			.setDesc("Cap the height of a tab or grid cell and show a scrollbar past it.")
			.addToggle((t) =>
				t.setValue(this.micaPlugin.settings.limitContentHeight).onChange(async (v) => {
					this.micaPlugin.settings.limitContentHeight = v;
					this.micaPlugin.applyStyleVars();
					await this.micaPlugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Content max height")
			.setDesc("Height (px) at which tab/cell content starts scrolling, when the cap above is on.")
			.addSlider((s) =>
				s
					.setLimits(120, 1200, 20)
					.setValue(this.micaPlugin.settings.contentMaxHeightPx)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.micaPlugin.settings.contentMaxHeightPx = v;
						this.micaPlugin.applyStyleVars();
						await this.micaPlugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Editor grows with content")
			.setDesc("The inline editor expands as you type (up to its max). Off = fixed height with a scrollbar.")
			.addToggle((t) =>
				t.setValue(this.micaPlugin.settings.editorAutosize).onChange(async (v) => {
					this.micaPlugin.settings.editorAutosize = v;
					await this.micaPlugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Editor max height")
			.setDesc(
				"Height (px) at which the inline editor stops growing and scrolls. Drag the corner to resize within this bound.",
			)
			.addSlider((s) =>
				s
					.setLimits(120, 1200, 20)
					.setValue(this.micaPlugin.settings.editorMaxHeightPx)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.micaPlugin.settings.editorMaxHeightPx = v;
						this.micaPlugin.applyStyleVars();
						await this.micaPlugin.saveSettings();
					}),
			);

		new Setting(containerEl).setHeading().setName("Migration");

		new Setting(containerEl)
			.setName("Version callout types (migration)")
			.setDesc(
				"Comma-separated callout types whose callouts are imported as version history when migrating from obsidian-tabs. Defaults to every built-in Obsidian type; leave empty to import ANY type (including custom ones), or narrow it (e.g. “success, bug, todo”).",
			)
			.addTextArea((t) => {
				t.setPlaceholder(OBSIDIAN_CALLOUT_TYPES)
					.setValue(this.micaPlugin.settings.versionCalloutTypes)
					.onChange(async (v) => {
						this.micaPlugin.settings.versionCalloutTypes = v;
						await this.micaPlugin.saveSettings();
					});
				t.inputEl.rows = 3;
				t.inputEl.addClass("mica-settings-wide");
			})
			.addExtraButton((b) =>
				b
					.setIcon("reset")
					.setTooltip("Reset to all built-in Obsidian callout types")
					.onClick(async () => {
						this.micaPlugin.settings.versionCalloutTypes = OBSIDIAN_CALLOUT_TYPES;
						await this.micaPlugin.saveSettings();
						this.display();
					}),
			);
	}
}
