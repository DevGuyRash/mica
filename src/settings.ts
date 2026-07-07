import { PluginSettingTab, Setting } from "obsidian";
import type MicaPlugin from "./main";
import type { DiffGranularity } from "./wasm/bridge";

export interface MicaSettings {
	/** Idle time before an auto-snapshot fires after an edit. */
	snapshotDebounceMs: number;
	defaultGranularity: DiffGranularity;
	defaultDiffMode: "inline" | "side-by-side" | "patch";
	showVersionChip: boolean;
	reconcileOnLoad: boolean;
}

export const DEFAULT_SETTINGS: MicaSettings = {
	snapshotDebounceMs: 1500,
	defaultGranularity: "line",
	defaultDiffMode: "inline",
	showVersionChip: true,
	reconcileOnLoad: true,
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
	}
}
