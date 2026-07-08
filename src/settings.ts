import { PluginSettingTab, Setting } from "obsidian";
import type MicaPlugin from "./main";
import { OBSIDIAN_CALLOUT_TYPES, type DiffGranularity } from "./wasm/bridge";

export interface MicaSettings {
	/** Master switch for auto-snapshotting (toggled live from each block's footer). */
	autoSnapshotEnabled: boolean;
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
	/** Gap (px) between tab chips in the tab bar. */
	tabGapPx: number;
	/** Comma-separated callout types imported as versions on migration (empty = any). */
	versionCalloutTypes: string;
}

export const DEFAULT_SETTINGS: MicaSettings = {
	autoSnapshotEnabled: true,
	snapshotDebounceMs: 5000,
	defaultGranularity: "line",
	defaultDiffMode: "inline",
	showVersionChip: true,
	reconcileOnLoad: true,
	autoAddIds: true,
	limitContentHeight: false,
	contentMaxHeightPx: 400,
	editorAutosize: true,
	editorMaxHeightPx: 400,
	tabGapPx: 6,
	versionCalloutTypes: OBSIDIAN_CALLOUT_TYPES,
};

export class MicaSettingTab extends PluginSettingTab {
	constructor(private readonly micaPlugin: MicaPlugin) {
		super(micaPlugin.app, micaPlugin);
	}

	/** Grouped by intent: Versioning, Comparing, Appearance, Migration. Knobs that
	 * only matter when a toggle is on are hidden until then, and fine-grained
	 * visual tuning is left to CSS variables rather than a wall of sliders. */
	display(): void {
		const { containerEl } = this;
		const s = this.micaPlugin.settings;
		const save = (): Promise<void> => this.micaPlugin.saveSettings();
		containerEl.empty();

		// ---------- Versioning ----------
		new Setting(containerEl).setHeading().setName("Versioning");

		new Setting(containerEl)
			.setName("Auto-save versions")
			.setDesc(
				"Snapshot a version as you edit content. Structural changes — adding empty tabs or cells, reordering, renaming — never create a version; only real edits do. Also toggleable per session from the dot in each block's footer.",
			)
			.addToggle((t) =>
				t.setValue(s.autoSnapshotEnabled).onChange(async (v) => {
					s.autoSnapshotEnabled = v;
					this.micaPlugin.engine.resetDebouncers();
					await save();
					this.display(); // reveal/hide the interval knob
				}),
			);

		if (s.autoSnapshotEnabled) {
			new Setting(containerEl)
				.setName("Idle before saving")
				.setDesc("How long after you stop editing before a version is saved (seconds).")
				.addSlider((sl) =>
					sl
						.setLimits(1, 15, 1)
						.setValue(Math.round(s.snapshotDebounceMs / 1000))
						.setDynamicTooltip()
						.onChange(async (v) => {
							s.snapshotDebounceMs = v * 1000;
							this.micaPlugin.engine.resetDebouncers();
							await save();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Auto-add block ids")
			.setDesc(
				"Stamp a stable id onto each block shortly after you edit, so history and inline editing work without running a command.",
			)
			.addToggle((t) =>
				t.setValue(s.autoAddIds).onChange(async (v) => {
					s.autoAddIds = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Reconcile history on startup")
			.setDesc("On vault open, re-home version histories whose notes were renamed or moved, and report orphans.")
			.addToggle((t) =>
				t.setValue(s.reconcileOnLoad).onChange(async (v) => {
					s.reconcileOnLoad = v;
					await save();
				}),
			);

		// ---------- Comparing ----------
		new Setting(containerEl).setHeading().setName("Comparing");

		new Setting(containerEl)
			.setName("Default granularity")
			.setDesc("How the compare view first splits changes.")
			.addDropdown((d) =>
				d
					.addOption("line", "Line")
					.addOption("word", "Word")
					.addOption("char", "Character")
					.setValue(s.defaultGranularity)
					.onChange(async (v) => {
						s.defaultGranularity = v as DiffGranularity;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Default layout")
			.setDesc("How the compare view first arranges the two versions.")
			.addDropdown((d) =>
				d
					.addOption("inline", "Inline")
					.addOption("side-by-side", "Side by side")
					.addOption("patch", "Patch")
					.setValue(s.defaultDiffMode)
					.onChange(async (v) => {
						s.defaultDiffMode = v as MicaSettings["defaultDiffMode"];
						await save();
					}),
			);

		// ---------- Appearance ----------
		new Setting(containerEl).setHeading().setName("Appearance");

		new Setting(containerEl)
			.setName("Version chip on blocks")
			.setDesc("Show the history-count chip (and unsaved-changes dot) in each block's footer.")
			.addToggle((t) =>
				t.setValue(s.showVersionChip).onChange(async (v) => {
					s.showVersionChip = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Tab spacing")
			.setDesc("Gap between tab chips in the tab bar.")
			.addSlider((sl) =>
				sl
					.setLimits(0, 24, 1)
					.setValue(s.tabGapPx)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.tabGapPx = v;
						this.micaPlugin.applyStyleVars();
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Editor grows with content")
			.setDesc("The inline editor expands as you type (up to its max); off = a fixed height with a scrollbar.")
			.addToggle((t) =>
				t.setValue(s.editorAutosize).onChange(async (v) => {
					s.editorAutosize = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Editor max height")
			.setDesc(
				"Where the inline editor stops growing and scrolls (px). Drag its corner to resize within this bound.",
			)
			.addSlider((sl) =>
				sl
					.setLimits(120, 1200, 20)
					.setValue(s.editorMaxHeightPx)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.editorMaxHeightPx = v;
						this.micaPlugin.applyStyleVars();
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Cap content height")
			.setDesc("Limit a tab or grid cell's height and scroll past it, instead of letting it grow unbounded.")
			.addToggle((t) =>
				t.setValue(s.limitContentHeight).onChange(async (v) => {
					s.limitContentHeight = v;
					this.micaPlugin.applyStyleVars();
					await save();
					this.display(); // reveal/hide the height knob
				}),
			);

		if (s.limitContentHeight) {
			new Setting(containerEl)
				.setName("Content max height")
				.setDesc("Height (px) at which a tab/cell starts scrolling.")
				.addSlider((sl) =>
					sl
						.setLimits(120, 1200, 20)
						.setValue(s.contentMaxHeightPx)
						.setDynamicTooltip()
						.onChange(async (v) => {
							s.contentMaxHeightPx = v;
							this.micaPlugin.applyStyleVars();
							await save();
						}),
				);
		}

		new Setting(containerEl).setDesc(
			"Finer visual tuning — colors, radii, control sizes — is exposed as CSS custom properties on `body` (see the plugin's styles.css). Override them with the Style Settings plugin or your theme.",
		);

		// ---------- Migration ----------
		new Setting(containerEl).setHeading().setName("Migration");

		new Setting(containerEl)
			.setName("Import callouts as versions")
			.setDesc(
				"When migrating from obsidian-tabs, callouts of these comma-separated types become version history. Defaults to every built-in Obsidian type; leave empty to import ANY type (including custom ones), or narrow it (e.g. “success, bug, todo”).",
			)
			.addTextArea((t) => {
				t.setPlaceholder(OBSIDIAN_CALLOUT_TYPES)
					.setValue(s.versionCalloutTypes)
					.onChange(async (v) => {
						s.versionCalloutTypes = v;
						await save();
					});
				t.inputEl.rows = 3;
				t.inputEl.addClass("mica-settings-wide");
			})
			.addExtraButton((b) =>
				b
					.setIcon("reset")
					.setTooltip("Reset to all built-in Obsidian callout types")
					.onClick(async () => {
						s.versionCalloutTypes = OBSIDIAN_CALLOUT_TYPES;
						await save();
						this.display();
					}),
			);
	}
}
