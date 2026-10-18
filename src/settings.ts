import {
	getIcon,
	Modal,
	Notice,
	PluginSettingTab,
	Setting,
	setIcon,
	type SettingDefinitionItem,
	type SliderComponent,
	type TextComponent,
} from "obsidian";
import { ICON_PACKS, requiredAttribution } from "./icons/iconPacks";
import { forgetIconPack } from "./icons/iconPackRuntime";
import { builtinTools, DEFAULT_TOOLBAR_LAYOUT, type CustomTool } from "./ui/toolSpec";
import type MicaPlugin from "./main";
import { OBSIDIAN_CALLOUT_TYPES } from "./wasm/bridge";
import { SECTION_ACTION_OPTIONS, type SectionActionPreferenceId } from "./ui/sectionActionPrefs";
import {
	DEFAULT_DOCK_ACTION_LAYOUT,
	DOCK_ACTION_OPTIONS,
	type DockActionId,
	type DockCopyTargetMode,
	type DockSurfaceMode,
} from "./ui/dockConfig";

export type MicaTabStyle = "underline" | "connected" | "pill";
export type MicaDensity = "comfortable" | "compact";

/** Selectable themes. `default` inherits Obsidian's accent; the rest set a
 * distinctive accent that retints Mica's chrome + borders cohesively. */
export const MICA_THEMES: { id: string; name: string }[] = [
	{ id: "default", name: "Match Obsidian" },
	{ id: "slate", name: "Slate" },
	{ id: "ocean", name: "Ocean" },
	{ id: "forest", name: "Forest" },
	{ id: "sunset", name: "Sunset" },
	{ id: "grape", name: "Grape" },
	{ id: "rose", name: "Rose" },
	{ id: "carbon", name: "Carbon" },
	{ id: "cyber", name: "Cyber" },
	{ id: "solar", name: "Solar" },
];

export interface MicaSettings {
	/** Active vault-relative storage folder mirrored from the shared mica.json locator. */
	storageFolder: string;
	/** Explicitly requested folder to preflight now and move to on next startup. */
	pendingStorageFolder: string | null;
	/** Master switch for auto-snapshotting (toggled live from each block's footer). */
	autoSnapshotEnabled: boolean;
	/** Idle time before an auto-snapshot fires after an edit. */
	snapshotDebounceMs: number;
	/** Intra-line highlight refinement in diffs. */
	diffRefine: "none" | "word" | "char";
	/** Exclude mica layout lines (`:::`, `tab:`) from diffs. */
	diffHideSyntax: boolean;
	/** Opt-in icon packs, by id. Empty means Obsidian's built-in icons only. */
	enabledIconPacks: string[];
	/** Collapse runs of spaces/tabs before diffing. */
	diffIgnoreWs: boolean;
	defaultDiffMode: "inline" | "side-by-side" | "patch";
	showVersionChip: boolean;
	/** Keep navigation and version status reachable inside exceptionally tall blocks. */
	longBlockControls: "contextual" | "jumps-only" | "off";
	/** How the traveling dock chooses the clipboard scope. */
	dockCopyTargetMode: DockCopyTargetMode;
	/** Ordered actions shown by the traveling dock. */
	dockActionLayout: DockActionId[];
	/** Floating dock surface treatment; header/footer placements keep normal chrome. */
	dockSurface: DockSurfaceMode;
	dockCustomBackground: string;
	dockCustomForeground: string;
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
	/** Named look; `default` inherits Obsidian's accent. */
	theme: string;
	/** Custom accent (CSS color); empty = the theme's accent. Drives chrome + borders. */
	accentColor: string;
	/** Overall control/padding density. */
	density: MicaDensity;
	/** Card corner radius (px). */
	cardRadiusPx: number;
	/** How the active tab is styled. */
	tabStyle: MicaTabStyle;
	/** Enable tab/version motion (respects prefers-reduced-motion regardless). */
	animations: boolean;
	/** Comma-separated callout types imported as versions on migration (empty = any). */
	versionCalloutTypes: string;
	/** Block header bar: revealed on hover, always shown, or never. */
	blockHeaderMode: "hover" | "always" | "never";
	/** Which side hover tools (drag grip, pencil, cell bar) sit on. */
	dragHandlePosition: "left" | "right";
	/** How vertical-ellipsis entity menus normally open. Click always remains available. */
	actionMenuTrigger: "click" | "hover";
	/** Promote rendered-entity actions while they fit, or keep them in the ellipsis. */
	entityActionLayout: "responsive" | "menu-only";
	showTabActionMenuOnHover: boolean;
	/** Section action groups suppressed from direct controls and section menus. */
	hiddenSectionActions: SectionActionPreferenceId[];
	/** What clicking outside an inline editor does. */
	editorClickOutside: "nothing" | "cancel" | "save";
	/** Draw structural outlines (tabs, sections, cells) by default; per-block
	 * `outline=on|off` fence attr overrides. */
	showOutlines: boolean;
	/** The editor save key; placeholders and tooltips follow it. */
	saveShortcut: "mod-enter" | "mod-s" | "shift-enter" | "none";
	/** Show line numbers in the markdown editors. */
	editorLineNumbers: boolean;
	/** Render whitespace characters in the markdown editors. */
	editorWhitespace: boolean;
	/** Apply semantic Markdown styling while keeping source markers visible. */
	editorLiveSyntaxStyling: boolean;
	/** Preserve tab/grid/cell layout directives in section clipboard copies. */
	copyIncludeMicaSyntax: boolean;
	/** Wrap section clipboard copies in a fresh, identity-free Mica code fence. */
	copyIncludeOuterContainer: boolean;
	/** Prefix copied lines with aligned plain-text line numbers. */
	copyIncludeLineNumbers: boolean;
	/** Number only authored content or every final output line. */
	copyLineNumberScope: "content" | "output";
	/** Append locale-aware exact times to relative version ages. */
	showVersionExactTimestamps: boolean;
	/** Ordered editor-toolbar item ids ("|" = separator). */
	toolbarLayout: string[];
	/** Variant-group defaults (group id → variant id), following last use. */
	toolbarDefaults: Record<string, string>;
	/** User-defined template buttons (espanso-style placeholders). */
	customTools: CustomTool[];
	/** Persisted fold keys per block id (folds survive restarts). */
	foldState: Record<string, string[]>;
}

export const DEFAULT_SETTINGS: MicaSettings = {
	storageFolder: "mica-data",
	pendingStorageFolder: null,
	autoSnapshotEnabled: true,
	snapshotDebounceMs: 5000,
	diffRefine: "word",
	diffHideSyntax: true,
	diffIgnoreWs: false,
	// Nothing is downloaded until the user asks for a pack.
	enabledIconPacks: [],
	defaultDiffMode: "inline",
	showVersionChip: true,
	longBlockControls: "contextual",
	dockCopyTargetMode: "contextual",
	dockActionLayout: [...DEFAULT_DOCK_ACTION_LAYOUT],
	dockSurface: "frosted",
	dockCustomBackground: "#20252b",
	dockCustomForeground: "#f1f3f5",
	reconcileOnLoad: true,
	autoAddIds: true,
	limitContentHeight: false,
	contentMaxHeightPx: 400,
	editorAutosize: true,
	editorMaxHeightPx: 400,
	tabGapPx: 6,
	theme: "default",
	accentColor: "",
	density: "comfortable",
	cardRadiusPx: 10,
	tabStyle: "connected",
	animations: true,
	versionCalloutTypes: OBSIDIAN_CALLOUT_TYPES,
	blockHeaderMode: "hover",
	dragHandlePosition: "right",
	actionMenuTrigger: "click",
	entityActionLayout: "responsive",
	showTabActionMenuOnHover: true,
	hiddenSectionActions: [],
	editorClickOutside: "nothing",
	showOutlines: false,
	saveShortcut: "mod-enter",
	editorLineNumbers: false,
	editorWhitespace: false,
	editorLiveSyntaxStyling: true,
	copyIncludeMicaSyntax: false,
	copyIncludeOuterContainer: false,
	copyIncludeLineNumbers: false,
	copyLineNumberScope: "content",
	showVersionExactTimestamps: false,
	toolbarLayout: DEFAULT_TOOLBAR_LAYOUT,
	toolbarDefaults: {},
	customTools: [],
	foldState: {},
};

/** Every persisted preference declares when its observable effect occurs. The
 * exhaustive record makes adding a setting without choosing a lifecycle a
 * type error instead of a latent UI-wiring bug. */
export type SettingLifecycle =
	| "immediate-runtime"
	| "open-widget-rerender"
	| "toolbar-rerender"
	| "read-at-use"
	| "next-open"
	| "next-startup"
	| "debouncer-runtime"
	| "storage-relocation";

export const SETTING_LIFECYCLES = {
	storageFolder: "read-at-use",
	pendingStorageFolder: "storage-relocation",
	autoSnapshotEnabled: "debouncer-runtime",
	snapshotDebounceMs: "debouncer-runtime",
	diffRefine: "next-open",
	diffHideSyntax: "next-open",
	diffIgnoreWs: "next-open",
	defaultDiffMode: "next-open",
	showVersionChip: "open-widget-rerender",
	longBlockControls: "open-widget-rerender",
	dockCopyTargetMode: "open-widget-rerender",
	dockActionLayout: "open-widget-rerender",
	dockSurface: "immediate-runtime",
	dockCustomBackground: "immediate-runtime",
	dockCustomForeground: "immediate-runtime",
	reconcileOnLoad: "next-startup",
	autoAddIds: "read-at-use",
	limitContentHeight: "immediate-runtime",
	contentMaxHeightPx: "immediate-runtime",
	editorAutosize: "open-widget-rerender",
	editorMaxHeightPx: "immediate-runtime",
	tabGapPx: "immediate-runtime",
	theme: "immediate-runtime",
	accentColor: "immediate-runtime",
	density: "immediate-runtime",
	cardRadiusPx: "immediate-runtime",
	tabStyle: "immediate-runtime",
	animations: "immediate-runtime",
	versionCalloutTypes: "read-at-use",
	blockHeaderMode: "open-widget-rerender",
	dragHandlePosition: "immediate-runtime",
	actionMenuTrigger: "immediate-runtime",
	entityActionLayout: "open-widget-rerender",
	showTabActionMenuOnHover: "open-widget-rerender",
	hiddenSectionActions: "open-widget-rerender",
	editorClickOutside: "immediate-runtime",
	showOutlines: "immediate-runtime",
	saveShortcut: "next-open",
	editorLineNumbers: "immediate-runtime",
	editorWhitespace: "immediate-runtime",
	editorLiveSyntaxStyling: "immediate-runtime",
	copyIncludeMicaSyntax: "read-at-use",
	copyIncludeOuterContainer: "read-at-use",
	copyIncludeLineNumbers: "read-at-use",
	copyLineNumberScope: "read-at-use",
	showVersionExactTimestamps: "immediate-runtime",
	toolbarLayout: "toolbar-rerender",
	toolbarDefaults: "toolbar-rerender",
	customTools: "toolbar-rerender",
	foldState: "read-at-use",
	// Pack membership is consulted whenever an icon is resolved, so a toggle
	// takes effect on the next lookup without reopening anything.
	enabledIconPacks: "read-at-use",
} as const satisfies Record<keyof MicaSettings, SettingLifecycle>;

/** Ordinary preferences apply their lifecycle before saving. Storage requests
 * receive an explicit draft; the controller preflights and persists the pending folder. */
export async function commitSetting(plugin: MicaPlugin, key: keyof MicaSettings, value?: string): Promise<void> {
	switch (SETTING_LIFECYCLES[key]) {
		case "storage-relocation":
			if (value === undefined) throw new Error("Mica: storage relocation requires an explicit destination");
			await plugin.changeStorageFolder(value);
			return;
		case "immediate-runtime":
			plugin.applyStyleVars();
			break;
		case "open-widget-rerender":
			plugin.refreshViews();
			break;
		case "toolbar-rerender":
			plugin.applyToolbarConfig();
			break;
		case "debouncer-runtime":
			plugin.engine.resetDebouncers();
			break;
		case "next-open":
			plugin.applyNextOpenSettings();
			break;
		case "read-at-use":
		case "next-startup":
			break;
	}
	await plugin.saveSettings();
}

interface MicaSettingDefinition {
	name: string;
	desc: string;
	render: (setting: Setting) => void;
}

interface MicaSettingGroup {
	type: "group";
	heading: string;
	items: MicaSettingDefinition[];
}

/** Current hosts show slider values inline; retain native value feedback on 1.12.7. */
function showSliderValue(slider: SliderComponent): void {
	const updateTitle = (): void => {
		slider.sliderEl.title = slider.getValuePretty();
	};
	updateTitle();
	slider.sliderEl.addEventListener("input", updateTitle);
}

export class MicaSettingTab extends PluginSettingTab {
	constructor(private readonly micaPlugin: MicaPlugin) {
		super(micaPlugin.app, micaPlugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.settingGroups();
	}

	private refreshSettings(): void {
		this.update();
	}

	/** The accent as a hex for the color picker: the user's override if set, else
	 * the theme/Obsidian accent resolved to a concrete color via a probe element. */
	private resolvedAccent(): string {
		if (this.micaPlugin.settings.accentColor) return this.micaPlugin.settings.accentColor;
		const probe = document.body.createSpan({ cls: "mica-settings-accent-probe" });
		const rgb = getComputedStyle(probe).color;
		probe.remove();
		const m = rgb.match(/\d+/g);
		if (!m || m.length < 3) return "#8b5cf6";
		return `#${m
			.slice(0, 3)
			.map((n) => Number(n).toString(16).padStart(2, "0"))
			.join("")}`;
	}

	/** Grouped by intent: Storage, Versioning, Comparing, Appearance, Migration. Knobs that
	 * only matter when a toggle is on are hidden until then. Callbacks retain each setting’s lifecycle effects. */
	private settingGroups(): MicaSettingGroup[] {
		const s = this.micaPlugin.settings;
		const commit = (key: keyof MicaSettings): Promise<void> => commitSetting(this.micaPlugin, key);
		const groups: MicaSettingGroup[] = [];
		let items: MicaSettingDefinition[] = [];
		const group = (heading: string): void => {
			items = [];
			groups.push({ type: "group", heading, items });
		};
		const add = (name: string, desc: string, render: (setting: Setting) => void = () => undefined): void => {
			items.push({ name, desc, render });
		};

		group("Storage");
		add(
			"Storage folder",
			"Visible folder inside this vault, relative to the vault root. Existing history moves at next startup; stop Mica CLI/watch before restarting.",
			(setting) => {
				let draft = this.micaPlugin.settings.pendingStorageFolder ?? this.micaPlugin.settings.storageFolder;
				let moving = false;
				let input: TextComponent | undefined;
				setting
					.addText((text) => {
						input = text;
						text.setPlaceholder(DEFAULT_SETTINGS.storageFolder)
							.setValue(draft)
							.onChange((value) => {
								draft = value;
							});
					})
					.addButton((button) => {
						button
							.setButtonText("Apply after restart")
							.setCta()
							.onClick(() => {
								if (moving) return;
								moving = true;
								input?.setDisabled(true);
								button.setDisabled(true);
								void (async () => {
									try {
										await this.micaPlugin.changeStorageFolder(draft);
										draft =
											this.micaPlugin.settings.pendingStorageFolder ??
											this.micaPlugin.settings.storageFolder;
										input?.setValue(draft);
									} catch (error) {
										console.error("Mica: storage folder request failed", error);
									} finally {
										moving = false;
										input?.setDisabled(false);
										button.setDisabled(false);
									}
								})();
							});
					});
			},
		);

		// ---------- Versioning ----------
		group("Versioning");

		add(
			"Auto-save versions",
			"Snapshot a version as you edit content. Structural changes — adding empty tabs or cells, reordering, renaming — never create a version; only real edits do. Also toggleable per session from the dot in each block's footer.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.autoSnapshotEnabled).onChange(async (v) => {
						s.autoSnapshotEnabled = v;
						await commit("autoSnapshotEnabled");
						this.refreshSettings(); // reveal/hide the interval knob
					}),
				);
			},
		);

		if (s.autoSnapshotEnabled) {
			add(
				"Idle before saving",
				"How long after you stop editing before a version is saved (seconds).",
				(setting) => {
					setting.addSlider((sl) =>
						sl
							.setLimits(1, 15, 1)
							.setValue(Math.round(s.snapshotDebounceMs / 1000))
							.then(showSliderValue)
							.onChange(async (v) => {
								s.snapshotDebounceMs = v * 1000;
								await commit("snapshotDebounceMs");
							}),
					);
				},
			);
		}

		add(
			"Auto-add block ids",
			"Stamp a stable id onto each block shortly after you edit, so history and inline editing work without running a command.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.autoAddIds).onChange(async (v) => {
						s.autoAddIds = v;
						await commit("autoAddIds");
					}),
				);
			},
		);

		add(
			"Reconcile history on startup",
			"On vault open, re-home version histories whose notes were renamed or moved, and report orphans.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.reconcileOnLoad).onChange(async (v) => {
						s.reconcileOnLoad = v;
						await commit("reconcileOnLoad");
					}),
				);
			},
		);

		// ---------- Comparing ----------
		group("Comparing");

		add(
			"Highlight changes within lines",
			"Meld-style sub-line emphasis on changed lines: by word, by character, or off.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("word", "Word")
						.addOption("char", "Character")
						.addOption("none", "Off")
						.setValue(s.diffRefine)
						.onChange(async (v) => {
							s.diffRefine = v as MicaSettings["diffRefine"];
							await commit("diffRefine");
						}),
				);
			},
		);

		add("Default layout", "How the compare view first arranges the two versions.", (setting) => {
			setting.addDropdown((d) =>
				d
					.addOption("inline", "Inline")
					.addOption("side-by-side", "Side by side")
					.addOption("patch", "Patch")
					.setValue(s.defaultDiffMode)
					.onChange(async (v) => {
						s.defaultDiffMode = v as MicaSettings["defaultDiffMode"];
						await commit("defaultDiffMode");
					}),
			);
		});

		add(
			"Show exact version times",
			"Append the local date and time to each relative age in version history.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.showVersionExactTimestamps).onChange(async (v) => {
						s.showVersionExactTimestamps = v;
						await commit("showVersionExactTimestamps");
					}),
				);
			},
		);

		add(
			"Hide mica syntax in diffs",
			"Ignore layout lines (:::, tab:) when comparing — only real content differences show.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.diffHideSyntax).onChange(async (v) => {
						s.diffHideSyntax = v;
						await commit("diffHideSyntax");
					}),
				);
			},
		);

		add("Ignore whitespace in diffs", "Collapse runs of spaces and tabs before comparing.", (setting) => {
			setting.addToggle((t) =>
				t.setValue(s.diffIgnoreWs).onChange(async (v) => {
					s.diffIgnoreWs = v;
					await commit("diffIgnoreWs");
				}),
			);
		});

		// ---------- Appearance ----------
		group("Icon packs");
		add(
			"",
			"Obsidian's built-in icons are always available. Extra packs are downloaded from jsDelivr the first time you use one, and only while enabled.",
		);
		for (const pack of ICON_PACKS) {
			const size = pack.approxBytes
				? `${Math.round(pack.approxBytes / 1024)} KB, loaded once`
				: "loaded one icon at a time";
			const credit = pack.license.attribution ? " · credit shown with the icons" : "";
			add(
				pack.name,
				`${pack.license.spdx} · ${size}${credit}${pack.license.note ? ` · ${pack.license.note}` : ""}`,
				(setting) => {
					setting.addToggle((toggle) =>
						toggle.setValue(s.enabledIconPacks.includes(pack.id)).onChange(async (on) => {
							const next = new Set(s.enabledIconPacks);
							if (on) next.add(pack.id);
							else {
								next.delete(pack.id);
								// Disabling releases whatever the pack had loaded.
								forgetIconPack(pack.id);
							}
							s.enabledIconPacks = [...next];
							await commitSetting(this.micaPlugin, "enabledIconPacks");
							this.refreshSettings();
						}),
					);
				},
			);
		}
		const credits = requiredAttribution(s.enabledIconPacks);
		if (credits.length) add("Attribution", `${credits.join(" · ")} — required by these packs' licences.`);

		group("Appearance");

		add(
			"Theme",
			"A named look. Each sets an accent that retints the whole block; “Match Obsidian” follows your theme's accent.",
			(setting) => {
				setting.setClass("mica-setting-stack").then((setting) => {
					const gallery = setting.settingEl.createDiv({ cls: "mica-theme-gallery" });
					const paintGallery = (): void => {
						gallery.empty();
						for (const t of MICA_THEMES) {
							const card = gallery.createEl("button", {
								cls: `mica-theme-card mica-theme-${t.id} ${s.theme === t.id ? "is-on" : ""}`,
								attr: { type: "button", "aria-label": `Use the ${t.name} theme` },
							});
							const mini = card.createDiv({ cls: "mica-theme-mini" });
							const tabs = mini.createDiv({ cls: "mica-theme-mini-tabs" });
							tabs.createSpan({ cls: "is-active" });
							tabs.createSpan();
							tabs.createSpan();
							mini.createDiv({ cls: "mica-theme-mini-body" });
							card.createDiv({ cls: "mica-theme-card-name", text: t.name });
							card.addEventListener("click", () => {
								s.theme = t.id;
								void commit("theme")
									.then(paintGallery)
									.catch((error: unknown) => {
										const detail = error instanceof Error ? error.message : String(error);
										console.error("Mica: could not update theme", error);
										new Notice(`Mica: could not update theme — ${detail}`);
									});
							});
						}
					};
					paintGallery();
				});
			},
		);

		add(
			"Accent color",
			"Override the theme's accent — it drives tabs, borders, and state. Reset to follow the theme.",
			(setting) => {
				setting
					.addColorPicker((c) =>
						c.setValue(this.resolvedAccent()).onChange(async (v) => {
							s.accentColor = v;
							await commit("accentColor");
						}),
					)
					.addExtraButton((b) =>
						b
							.setIcon("rotate-ccw")
							.setTooltip("Follow the theme's accent")
							.onClick(async () => {
								s.accentColor = "";
								await commit("accentColor");
								this.refreshSettings();
							}),
					);
			},
		);

		add("Density", "Comfortable or compact padding and control sizes.", (setting) => {
			setting.addDropdown((d) =>
				d
					.addOption("comfortable", "Comfortable")
					.addOption("compact", "Compact")
					.setValue(s.density)
					.onChange(async (v) => {
						s.density = v as MicaDensity;
						await commit("density");
					}),
			);
		});

		add("Corner radius", "Roundness of the block's corners (px).", (setting) => {
			setting.addSlider((sl) =>
				sl
					.setLimits(0, 20, 1)
					.setValue(s.cardRadiusPx)
					.then(showSliderValue)
					.onChange(async (v) => {
						s.cardRadiusPx = v;
						await commit("cardRadiusPx");
					}),
			);
		});

		add(
			"Tab style",
			"How the active tab is drawn: connected to its panel, a minimal underline, or a filled pill.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("connected", "Connected")
						.addOption("underline", "Underline")
						.addOption("pill", "Pill")
						.setValue(s.tabStyle)
						.onChange(async (v) => {
							s.tabStyle = v as MicaTabStyle;
							await commit("tabStyle");
						}),
				);
			},
		);

		add(
			"Block header",
			"The per-block bar with the name and action menu: show on hover, always, or never.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("hover", "On hover")
						.addOption("always", "Always")
						.addOption("never", "Never")
						.setValue(s.blockHeaderMode)
						.onChange(async (v) => {
							s.blockHeaderMode = v as MicaSettings["blockHeaderMode"];
							await commit("blockHeaderMode");
						}),
				);
			},
		);

		add(
			"Hover tools position",
			"Which corner a section's drag grip and action menu (and a cell's controls) appear in.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("right", "Top right")
						.addOption("left", "Top left")
						.setValue(s.dragHandlePosition)
						.onChange(async (v) => {
							s.dragHandlePosition = v as MicaSettings["dragHandlePosition"];
							await commit("dragHandlePosition");
						}),
				);
			},
		);

		add(
			"Action menus",
			"Open section, grid, cell, and tab ellipsis menus on click or after a short hover. Click always works.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("click", "Click")
						.addOption("hover", "Hover")
						.setValue(s.actionMenuTrigger)
						.onChange(async (v) => {
							s.actionMenuTrigger = v as MicaSettings["actionMenuTrigger"];
							await commit("actionMenuTrigger");
						}),
				);
			},
		);

		add(
			"Rendered action layout",
			"Show copy, edit, fold, and other actions directly when they fit, or always keep secondary actions in the three-dot menu. Tabs are always menu-only; drag stays direct.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("responsive", "Responsive")
						.addOption("menu-only", "Always use three-dot menu")
						.setValue(s.entityActionLayout)
						.onChange(async (v) => {
							s.entityActionLayout = v as MicaSettings["entityActionLayout"];
							await commit("entityActionLayout");
						}),
				);
			},
		);

		add(
			"Show tab action dots on hover",
			"Reveal each tab’s three-dot action menu on hover or keyboard focus. Right-click and keyboard context-menu access remain available when disabled.",
			(setting) => {
				setting.addToggle((toggle) =>
					toggle.setValue(s.showTabActionMenuOnHover).onChange(async (value) => {
						s.showTabActionMenuOnHover = value;
						await commit("showTabActionMenuOnHover");
					}),
				);
			},
		);

		add(
			"Section actions",
			"Choose which commands appear on text, callout, code, and combined sections. Drag and drop is always available and is not part of this list.",
			(setting) => {
				setting
					.setClass("mica-setting-stack")
					.then((setting) => this.renderSectionActionEditor(setting.controlEl));
			},
		);

		add(
			"Animations",
			"Subtle motion on tab switches and version saves. Always off if your system prefers reduced motion.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.animations).onChange(async (v) => {
						s.animations = v;
						await commit("animations");
					}),
				);
			},
		);

		add(
			"Version chip on blocks",
			"Show the history-count chip (and unsaved-changes dot) in each block's footer.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.showVersionChip).onChange(async (v) => {
						s.showVersionChip = v;
						await commit("showVersionChip");
					}),
				);
			},
		);

		add(
			"Controls for long blocks",
			"Keep navigation and version status reachable while scrolling a very tall Mica block, show only jump controls, or leave controls at the block edges.",
			(setting) => {
				setting.addDropdown((dropdown) =>
					dropdown
						.addOption("contextual", "Contextual status dock")
						.addOption("jumps-only", "Jump controls only")
						.addOption("off", "Off")
						.setValue(s.longBlockControls)
						.onChange(async (value) => {
							s.longBlockControls = value as MicaSettings["longBlockControls"];
							await commit("longBlockControls");
						}),
				);
			},
		);

		add(
			"Dock clipboard target",
			"Follow the stable reading context, always copy the whole block, or change scope only through the dock picker.",
			(setting) => {
				setting.addDropdown((dropdown) =>
					dropdown
						.addOption("contextual", "Follow reading context")
						.addOption("block", "Always copy the whole block")
						.addOption("manual", "Manual scope only")
						.setValue(s.dockCopyTargetMode)
						.onChange(async (value) => {
							s.dockCopyTargetMode = value as DockCopyTargetMode;
							await commit("dockCopyTargetMode");
						}),
				);
			},
		);

		add(
			"Floating dock surface",
			"Choose an opaque Obsidian surface, the current frosted treatment, a block-accent tint, or custom colors.",
			(setting) => {
				setting.addDropdown((dropdown) =>
					dropdown
						.addOption("theme", "Theme surface")
						.addOption("frosted", "Frosted glass")
						.addOption("accent", "Block accent")
						.addOption("custom", "Custom colors")
						.setValue(s.dockSurface)
						.onChange(async (value) => {
							s.dockSurface = value as DockSurfaceMode;
							await commit("dockSurface");
							this.refreshSettings();
						}),
				);
			},
		);

		if (s.dockSurface === "custom") {
			add(
				"Custom dock colors",
				"Background and foreground for the floating dock. The preview warns when contrast is low.",
				(setting) => {
					setting
						.setClass("mica-setting-stack")
						.addColorPicker((picker) =>
							picker.setValue(s.dockCustomBackground).onChange(async (value) => {
								s.dockCustomBackground = value;
								await commit("dockCustomBackground");
								this.paintDockContrast(setting.settingEl);
							}),
						)
						.addColorPicker((picker) =>
							picker.setValue(s.dockCustomForeground).onChange(async (value) => {
								s.dockCustomForeground = value;
								await commit("dockCustomForeground");
								this.paintDockContrast(setting.settingEl);
							}),
						)
						.then((setting) => {
							const preview = setting.settingEl.createDiv({ cls: "mica-dock-settings-preview" });
							preview.createSpan({ text: "Scope · Active tab" });
							const contrast = preview.createSpan({
								cls: "mica-dock-contrast",
								attr: { "aria-live": "polite" },
							});
							contrast.dataset.micaDockContrast = "1";
							this.paintDockContrast(setting.settingEl);
						});
				},
			);
		}

		add(
			"Traveling dock actions",
			"Choose and order block-wide controls. Hidden actions remain available from their normal block or entity controls.",
			(setting) => {
				setting
					.setClass("mica-setting-stack")
					.then((setting) => this.renderDockActionEditor(setting.controlEl));
			},
		);

		add(
			"Structural outlines",
			"Draw subtle borders around tabs, sections, and grid cells so the structure is always visible. Each block can override this via its appearance popover.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.showOutlines).onChange(async (v) => {
						s.showOutlines = v;
						await commit("showOutlines");
					}),
				);
			},
		);

		add("Tab spacing", "Gap between tab chips in the tab bar.", (setting) => {
			setting.addSlider((sl) =>
				sl
					.setLimits(0, 24, 1)
					.setValue(s.tabGapPx)
					.then(showSliderValue)
					.onChange(async (v) => {
						s.tabGapPx = v;
						await commit("tabGapPx");
					}),
			);
		});

		add(
			"Cap content height",
			"Limit a tab or grid cell's height and scroll past it, instead of letting it grow unbounded.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.limitContentHeight).onChange(async (v) => {
						s.limitContentHeight = v;
						await commit("limitContentHeight");
						this.refreshSettings(); // reveal/hide the height knob
					}),
				);
			},
		);

		if (s.limitContentHeight) {
			add("Content max height", "Height (px) at which a tab/cell starts scrolling.", (setting) => {
				setting.addSlider((sl) =>
					sl
						.setLimits(120, 1200, 20)
						.setValue(s.contentMaxHeightPx)
						.then(showSliderValue)
						.onChange(async (v) => {
							s.contentMaxHeightPx = v;
							await commit("contentMaxHeightPx");
						}),
				);
			});
		}

		add(
			"",
			"Finer visual tuning — colors, radii, control sizes — is exposed as CSS custom properties on `body` (see the plugin's styles.css). Override them with the Style Settings plugin or your theme.",
		);

		// ---------- Copying ----------
		group("Copying");

		add(
			"Include Mica layout syntax",
			"Keep tab, grid, and cell wrapper lines in section copies. Standard Markdown such as callouts and code fences is always preserved.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.copyIncludeMicaSyntax).onChange(async (v) => {
						s.copyIncludeMicaSyntax = v;
						await commit("copyIncludeMicaSyntax");
					}),
				);
			},
		);

		add(
			"Wrap copies in an outer Mica block",
			"Put copied content inside a safely sized Mica code fence. The source block id and appearance attributes are never copied.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.copyIncludeOuterContainer).onChange(async (v) => {
						s.copyIncludeOuterContainer = v;
						await commit("copyIncludeOuterContainer");
					}),
				);
			},
		);

		add(
			"Include line numbers",
			"Prefix copied lines with aligned plain-text numbers, such as “10 │ text”.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.copyIncludeLineNumbers).onChange(async (v) => {
						s.copyIncludeLineNumbers = v;
						await commit("copyIncludeLineNumbers");
						this.refreshSettings();
					}),
				);
			},
		);

		if (s.copyIncludeLineNumbers) {
			add(
				"Lines to number",
				"Number authored content only, or every final line including Mica wrappers.",
				(setting) => {
					setting.addDropdown((d) =>
						d
							.addOption("content", "Content only")
							.addOption("output", "Complete copied output")
							.setValue(s.copyLineNumberScope)
							.onChange(async (v) => {
								s.copyLineNumberScope = v as MicaSettings["copyLineNumberScope"];
								await commit("copyLineNumberScope");
							}),
					);
				},
			);
		}

		// ---------- Editors ----------
		group("Editors");

		add(
			"Clicking outside an editor",
			"What happens to an open inline editor when you click elsewhere: keep editing, discard, or save & close (also prevents several cells editing at once).",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("nothing", "Keep editing")
						.addOption("cancel", "Discard changes")
						.addOption("save", "Save & close")
						.setValue(s.editorClickOutside)
						.onChange(async (v) => {
							s.editorClickOutside = v as MicaSettings["editorClickOutside"];
							await commit("editorClickOutside");
						}),
				);
			},
		);

		add(
			"Editor save shortcut",
			"The key that saves and closes an editor. New editors, placeholders, and tooltips use the selected shortcut. Esc always cancels.",
			(setting) => {
				setting.addDropdown((d) =>
					d
						.addOption("mod-enter", "Ctrl/Cmd+Enter")
						.addOption("mod-s", "Ctrl/Cmd+S")
						.addOption("shift-enter", "Shift+Enter")
						.addOption("none", "None (buttons only)")
						.setValue(s.saveShortcut)
						.onChange(async (v) => {
							s.saveShortcut = v as MicaSettings["saveShortcut"];
							await commit("saveShortcut");
						}),
				);
			},
		);

		add(
			"Editor grows with content",
			"The inline editor expands as you type (up to its max); off = a fixed height with a scrollbar.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.editorAutosize).onChange(async (v) => {
						s.editorAutosize = v;
						await commit("editorAutosize");
					}),
				);
			},
		);

		add(
			"Editor max height",
			"Where the inline editor stops growing and scrolls (px). Drag its corner to resize within this bound.",
			(setting) => {
				setting.addSlider((sl) =>
					sl
						.setLimits(120, 1200, 20)
						.setValue(s.editorMaxHeightPx)
						.then(showSliderValue)
						.onChange(async (v) => {
							s.editorMaxHeightPx = v;
							await commit("editorMaxHeightPx");
						}),
				);
			},
		);

		add(
			"Line numbers",
			"Show line numbers in every Mica source editor: text, cells, combined sections, callouts, code blocks, whole blocks, and version branches. Also toggleable from editor chrome.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.editorLineNumbers).onChange(async (v) => {
						s.editorLineNumbers = v;
						await commit("editorLineNumbers");
					}),
				);
			},
		);

		add("Whitespace characters", "Render spaces and tabs visibly in every Mica source editor.", (setting) => {
			setting.addToggle((t) =>
				t.setValue(s.editorWhitespace).onChange(async (v) => {
					s.editorWhitespace = v;
					await commit("editorWhitespace");
				}),
			);
		});

		add(
			"Style Markdown while editing",
			"Keep source markers visible while applying bold, italic, comment, link, quote, and heading styling.",
			(setting) => {
				setting.addToggle((t) =>
					t.setValue(s.editorLiveSyntaxStyling).onChange(async (v) => {
						s.editorLiveSyntaxStyling = v;
						await commit("editorLiveSyntaxStyling");
					}),
				);
			},
		);

		group("Editor toolbar");
		add(
			"Toolbar layout",
			"Compose the Markdown authoring ribbon shown in quick editors and full lightboxes. Built-ins remain Markdown-only; custom buttons can target Markdown editors, code editors, or both.",
			(setting) => {
				setting.setClass("mica-setting-stack").then((setting) => this.renderToolbarEditor(setting.controlEl));
			},
		);
		items.push(...this.customToolDefinitions());

		// ---------- Migration ----------
		group("Migration");

		add(
			"Import callouts as versions",
			"When migrating from obsidian-tabs, callouts of these comma-separated types become version history. Defaults to every built-in Obsidian type; leave empty to import ANY type (including custom ones), or narrow it (e.g. “success, bug, todo”).",
			(setting) => {
				setting
					.setClass("mica-setting-stack")
					.addTextArea((t) => {
						t.setPlaceholder(OBSIDIAN_CALLOUT_TYPES)
							.setValue(s.versionCalloutTypes)
							.onChange(async (v) => {
								s.versionCalloutTypes = v;
								await commit("versionCalloutTypes");
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
								await commit("versionCalloutTypes");
								this.refreshSettings();
							}),
					);
			},
		);
		return groups;
	}

	/** A compact two-pane chooser. Preferences hide action groups rather than
	 * storing a whitelist, so future actions remain discoverable by default. */
	private renderSectionActionEditor(containerEl: HTMLElement): void {
		const s = this.micaPlugin.settings;
		const hidden = new Set<SectionActionPreferenceId>(s.hiddenSectionActions);
		const root = containerEl.createDiv({ cls: "mica-ribbon-editor mica-section-action-editor" });
		let selectedHidden: SectionActionPreferenceId | null = null;
		let selectedShown: SectionActionPreferenceId | null = null;

		const save = async (): Promise<void> => {
			s.hiddenSectionActions = SECTION_ACTION_OPTIONS.map((option) => option.id).filter((id) => hidden.has(id));
			await commitSetting(this.micaPlugin, "hiddenSectionActions");
		};

		const paint = (): void => {
			root.empty();
			const makePane = (
				title: string,
				options: readonly (typeof SECTION_ACTION_OPTIONS)[number][],
				selected: SectionActionPreferenceId | null,
				onSelect: (id: SectionActionPreferenceId) => void,
				onActivate: (id: SectionActionPreferenceId) => void,
			): void => {
				const pane = root.createDiv({ cls: "mica-ribbon-pane" });
				pane.createDiv({ cls: "mica-ribbon-title", text: title });
				const list = pane.createDiv({ cls: "mica-ribbon-list" });
				for (const option of options) {
					const row = list.createEl("button", {
						cls: `clickable-icon mica-ribbon-item ${selected === option.id ? "is-selected" : ""}`,
						attr: { type: "button" },
					});
					setIcon(row.createSpan({ cls: "mica-ribbon-ico" }), option.icon);
					row.createSpan({ text: option.label });
					row.addEventListener("click", () => onSelect(option.id));
					row.addEventListener("dblclick", () => onActivate(option.id));
				}
				if (!options.length)
					list.createDiv({
						cls: "mica-section-action-empty",
						text: title === "Hidden" ? "No actions hidden" : "Only drag and drop remains",
					});
			};

			makePane(
				"Hidden",
				SECTION_ACTION_OPTIONS.filter((option) => hidden.has(option.id)),
				selectedHidden,
				(id) => {
					selectedHidden = id;
					selectedShown = null;
					paint();
				},
				(id) => {
					hidden.delete(id);
					selectedHidden = null;
					void save().then(paint);
				},
			);

			const mid = root.createDiv({ cls: "mica-ribbon-mid" });
			const midButton = (icon: string, label: string, run: () => void): void => {
				const button = mid.createEl("button", {
					cls: "clickable-icon mica-ribbon-btn",
					attr: { type: "button", "aria-label": label },
				});
				setIcon(button, icon);
				button.addEventListener("click", () => {
					run();
					void save().then(paint);
				});
			};
			midButton("chevron-right", "Show selected action", () => {
				if (selectedHidden) hidden.delete(selectedHidden);
				selectedHidden = null;
			});
			midButton("chevron-left", "Hide selected action", () => {
				if (selectedShown) hidden.add(selectedShown);
				selectedShown = null;
			});
			midButton("chevrons-right", "Show every section action", () => {
				hidden.clear();
				selectedHidden = null;
			});
			midButton("chevrons-left", "Hide every optional section action", () => {
				for (const option of SECTION_ACTION_OPTIONS) hidden.add(option.id);
				selectedShown = null;
			});
			midButton("rotate-ccw", "Reset section actions", () => {
				hidden.clear();
				selectedHidden = null;
				selectedShown = null;
			});

			makePane(
				"Shown on sections",
				SECTION_ACTION_OPTIONS.filter((option) => !hidden.has(option.id)),
				selectedShown,
				(id) => {
					selectedShown = id;
					selectedHidden = null;
					paint();
				},
				(id) => {
					hidden.add(id);
					selectedShown = null;
					void save().then(paint);
				},
			);
		};
		paint();
	}

	private renderDockActionEditor(containerEl: HTMLElement): void {
		const s = this.micaPlugin.settings;
		const root = containerEl.createDiv({ cls: "mica-ribbon-editor mica-dock-action-editor" });
		let selectedAvailable: DockActionId | null = null;
		let selectedCurrent = -1;

		const save = async (): Promise<void> => {
			await commitSetting(this.micaPlugin, "dockActionLayout");
		};
		const paint = (): void => {
			root.empty();
			const available = root.createDiv({ cls: "mica-ribbon-pane" });
			available.createDiv({ cls: "mica-ribbon-title", text: "Available controls" });
			const availableList = available.createDiv({ cls: "mica-ribbon-list" });
			for (const option of DOCK_ACTION_OPTIONS.filter((item) => !s.dockActionLayout.includes(item.id))) {
				const row = availableList.createEl("button", {
					cls: `clickable-icon mica-ribbon-item ${selectedAvailable === option.id ? "is-selected" : ""}`,
					attr: { type: "button" },
				});
				setIcon(row.createSpan({ cls: "mica-ribbon-ico" }), option.icon);
				row.createSpan({ text: option.label });
				row.addEventListener("click", () => {
					selectedAvailable = option.id;
					selectedCurrent = -1;
					paint();
				});
				row.addEventListener("dblclick", () => {
					s.dockActionLayout.push(option.id);
					selectedAvailable = null;
					void save().then(paint);
				});
			}

			const middle = root.createDiv({ cls: "mica-ribbon-mid" });
			const middleButton = (icon: string, label: string, run: () => void): void => {
				const button = middle.createEl("button", {
					cls: "clickable-icon mica-ribbon-btn",
					attr: { type: "button", "aria-label": label },
				});
				setIcon(button, icon);
				button.addEventListener("click", () => {
					run();
					void save().then(paint);
				});
			};
			middleButton("chevron-right", "Add selected control", () => {
				if (selectedAvailable) s.dockActionLayout.push(selectedAvailable);
				selectedAvailable = null;
			});
			middleButton("chevron-left", "Remove selected control", () => {
				if (selectedCurrent >= 0) s.dockActionLayout.splice(selectedCurrent, 1);
				selectedCurrent = -1;
			});
			middleButton("rotate-ccw", "Reset dock controls", () => {
				s.dockActionLayout = [...DEFAULT_DOCK_ACTION_LAYOUT];
				selectedAvailable = null;
				selectedCurrent = -1;
			});

			const current = root.createDiv({ cls: "mica-ribbon-pane" });
			current.createDiv({ cls: "mica-ribbon-title", text: "Your dock (in order)" });
			const currentList = current.createDiv({ cls: "mica-ribbon-list" });
			s.dockActionLayout.forEach((id, index) => {
				const option = DOCK_ACTION_OPTIONS.find((item) => item.id === id);
				if (!option) return;
				const row = currentList.createEl("button", {
					cls: `clickable-icon mica-ribbon-item ${selectedCurrent === index ? "is-selected" : ""}`,
					attr: { type: "button" },
				});
				setIcon(row.createSpan({ cls: "mica-ribbon-ico" }), option.icon);
				row.createSpan({ text: option.label });
				row.addEventListener("click", () => {
					selectedCurrent = index;
					selectedAvailable = null;
					paint();
				});
			});
			const order = current.createDiv({ cls: "mica-ribbon-order" });
			const orderButton = (icon: string, label: string, delta: -1 | 1): void => {
				const button = order.createEl("button", {
					cls: "clickable-icon mica-ribbon-btn",
					attr: { type: "button", "aria-label": label },
				});
				setIcon(button, icon);
				button.addEventListener("click", () => {
					const next = selectedCurrent + delta;
					if (selectedCurrent < 0 || next < 0 || next >= s.dockActionLayout.length) return;
					[s.dockActionLayout[selectedCurrent], s.dockActionLayout[next]] = [
						s.dockActionLayout[next],
						s.dockActionLayout[selectedCurrent],
					];
					selectedCurrent = next;
					void save().then(paint);
				});
			};
			orderButton("arrow-up", "Move selected control up", -1);
			orderButton("arrow-down", "Move selected control down", 1);
		};
		paint();
	}

	private paintDockContrast(containerEl: HTMLElement): void {
		const preview = containerEl.querySelector<HTMLElement>(".mica-dock-settings-preview");
		const status = containerEl.querySelector<HTMLElement>("[data-mica-dock-contrast]");
		if (!preview || !status) return;
		const { dockCustomBackground: background, dockCustomForeground: foreground } = this.micaPlugin.settings;
		preview.style.background = background;
		preview.style.color = foreground;
		const ratio = contrastRatio(background, foreground);
		status.setText(
			ratio === null ? "Invalid color" : `${ratio.toFixed(1)}:1${ratio < 4.5 ? " · low contrast" : ""}`,
		);
		status.toggleClass("is-warning", ratio !== null && ratio < 4.5);
	}

	/**
	 * The ribbon composer: available items on the left, the current toolbar on
	 * the right, arrows in the middle (add / remove / add-all / remove-all),
	 * reorder buttons, a separator well, and user-defined template buttons.
	 */
	private renderToolbarEditor(containerEl: HTMLElement): void {
		const s = this.micaPlugin.settings;
		const save = (): Promise<void> => commitSetting(this.micaPlugin, "toolbarLayout");

		const root = containerEl.createDiv({ cls: "mica-ribbon-editor" });
		let selectedAvail: string | null = null;
		let selectedCurrent = -1;

		const catalog = (): { id: string; icon: string; label: string }[] => [
			...builtinTools().map((t) => ({ id: t.id, icon: t.icon, label: t.label })),
			...s.customTools.map((c) => ({ id: `custom:${c.id}`, icon: c.icon || "sparkles", label: c.name })),
		];
		const labelOf = (id: string): { icon: string; label: string } => {
			if (id === "|") return { icon: "separator-vertical", label: "Separator" };
			return catalog().find((t) => t.id === id) ?? { icon: "help-circle", label: id };
		};

		const paint = (): void => {
			root.empty();
			const avail = root.createDiv({ cls: "mica-ribbon-pane" });
			avail.createDiv({ cls: "mica-ribbon-title", text: "Available" });
			const availList = avail.createDiv({ cls: "mica-ribbon-list" });
			const inLayout = new Set(s.toolbarLayout.filter((x) => x !== "|"));
			const availIds = [
				"|",
				...catalog()
					.map((t) => t.id)
					.filter((id) => !inLayout.has(id)),
			];
			for (const id of availIds) {
				const { icon, label } = labelOf(id);
				const row = availList.createEl("button", {
					cls: `clickable-icon mica-ribbon-item ${selectedAvail === id ? "is-selected" : ""}`,
					attr: { type: "button" },
				});
				setIcon(row.createSpan({ cls: "mica-ribbon-ico" }), icon);
				row.createSpan({ text: id === "|" ? "Separator (repeatable)" : label });
				row.addEventListener("click", () => {
					selectedAvail = id;
					selectedCurrent = -1;
					paint();
				});
				row.addEventListener("dblclick", () => {
					s.toolbarLayout.push(id);
					void save().then(paint);
				});
			}

			const mid = root.createDiv({ cls: "mica-ribbon-mid" });
			const midBtn = (icon: string, label: string, fn: () => void): void => {
				const b = mid.createEl("button", {
					cls: "clickable-icon mica-ribbon-btn",
					attr: { type: "button", "aria-label": label },
				});
				setIcon(b, icon);
				b.addEventListener("click", () => {
					fn();
					void save().then(paint);
				});
			};
			midBtn("chevron-right", "Add selected", () => {
				if (selectedAvail) s.toolbarLayout.push(selectedAvail);
			});
			midBtn("chevron-left", "Remove selected", () => {
				if (selectedCurrent >= 0) {
					s.toolbarLayout.splice(selectedCurrent, 1);
					selectedCurrent = -1;
				}
			});
			midBtn("chevrons-right", "Add everything", () => {
				for (const t of catalog()) if (!s.toolbarLayout.includes(t.id)) s.toolbarLayout.push(t.id);
			});
			midBtn("chevrons-left", "Empty the toolbar", () => {
				s.toolbarLayout = [];
				selectedCurrent = -1;
			});
			midBtn("rotate-ccw", "Reset to the default layout", () => {
				s.toolbarLayout = [...DEFAULT_TOOLBAR_LAYOUT];
				selectedCurrent = -1;
			});

			const cur = root.createDiv({ cls: "mica-ribbon-pane" });
			cur.createDiv({ cls: "mica-ribbon-title", text: "Your toolbar (in order)" });
			const curList = cur.createDiv({ cls: "mica-ribbon-list" });
			s.toolbarLayout.forEach((id, i) => {
				const { icon, label } = labelOf(id);
				const row = curList.createEl("button", {
					cls: `clickable-icon mica-ribbon-item ${selectedCurrent === i ? "is-selected" : ""}`,
					attr: { type: "button" },
				});
				setIcon(row.createSpan({ cls: "mica-ribbon-ico" }), icon);
				row.createSpan({ text: label });
				row.addEventListener("click", () => {
					selectedCurrent = i;
					selectedAvail = null;
					paint();
				});
				row.addEventListener("dblclick", () => {
					s.toolbarLayout.splice(i, 1);
					selectedCurrent = -1;
					void save().then(paint);
				});
			});
			const curBtns = cur.createDiv({ cls: "mica-ribbon-order" });
			const orderBtn = (icon: string, label: string, fn: () => void): void => {
				const b = curBtns.createEl("button", {
					cls: "clickable-icon mica-ribbon-btn",
					attr: { type: "button", "aria-label": label },
				});
				setIcon(b, icon);
				b.addEventListener("click", () => {
					fn();
					void save().then(paint);
				});
			};
			orderBtn("arrow-up", "Move up", () => {
				const i = selectedCurrent;
				if (i > 0) {
					[s.toolbarLayout[i - 1], s.toolbarLayout[i]] = [s.toolbarLayout[i], s.toolbarLayout[i - 1]];
					selectedCurrent = i - 1;
				}
			});
			orderBtn("arrow-down", "Move down", () => {
				const i = selectedCurrent;
				if (i >= 0 && i < s.toolbarLayout.length - 1) {
					[s.toolbarLayout[i + 1], s.toolbarLayout[i]] = [s.toolbarLayout[i], s.toolbarLayout[i + 1]];
					selectedCurrent = i + 1;
				}
			});
		};
		paint();
	}

	private customToolDefinitions(): MicaSettingDefinition[] {
		const s = this.micaPlugin.settings;
		const items: MicaSettingDefinition[] = [];
		const add = (name: string, desc: string, render: (setting: Setting) => void): void => {
			items.push({ name, desc, render });
		};

		add(
			"Custom buttons",
			"Your own Markdown/code insert buttons. Templates support {selection}, {all}, {date}, {time}, {datetime}, and {cursor} (where the caret lands).",
			(setting) => {
				setting.addButton((b) =>
					b.setButtonText("New custom button…").onClick(() => {
						new CustomToolModal(this.micaPlugin, null, () => this.refreshSettings()).open();
					}),
				);
			},
		);
		for (const tool of s.customTools) {
			add(
				tool.name,
				`${tool.surface === "both" ? "Markdown + code" : tool.surface === "code" ? "Code" : "Markdown"} · ${
					tool.template.length > 80 ? tool.template.slice(0, 80) + "…" : tool.template
				}`,
				(setting) => {
					setting
						.addExtraButton((b) =>
							b
								.setIcon("pencil")
								.setTooltip("Edit")
								.onClick(() => {
									new CustomToolModal(this.micaPlugin, tool, () => this.refreshSettings()).open();
								}),
						)
						.addExtraButton((b) =>
							b
								.setIcon("trash-2")
								.setTooltip("Delete")
								.onClick(async () => {
									s.customTools = s.customTools.filter((t) => t.id !== tool.id);
									s.toolbarLayout = s.toolbarLayout.filter((id) => id !== `custom:${tool.id}`);
									await commitSetting(this.micaPlugin, "customTools");
									this.refreshSettings();
								}),
						);
				},
			);
		}
		return items;
	}
}

/** Create/edit one custom template button: name, Lucide icon (live preview), template. */
class CustomToolModal extends Modal {
	private name: string;
	private icon: string;
	private template: string;
	private surface: "markdown" | "code" | "both";

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly existing: CustomTool | null,
		private readonly onDone: () => void,
	) {
		super(plugin.app);
		this.name = existing?.name ?? "";
		this.icon = existing?.icon ?? "sparkles";
		this.template = existing?.template ?? "";
		this.surface = existing?.surface ?? "markdown";
	}

	onOpen(): void {
		this.titleEl.setText(this.existing ? "Edit custom button" : "New custom button");
		const { contentEl } = this;

		let preview: HTMLElement;
		new Setting(contentEl).setName("Name").addText((t) =>
			t.setValue(this.name).onChange((v) => {
				this.name = v;
			}),
		);
		new Setting(contentEl)
			.setName("Icon")
			.setDesc("Choose an icon from lucide.dev, such as rocket, stamp, or wand-2.")
			.addText((t) =>
				t.setValue(this.icon).onChange((v) => {
					this.icon = v.trim();
					preview.empty();
					const icon = this.icon && getIcon(this.icon) ? this.icon : "sparkles";
					setIcon(preview, icon);
					preview.toggleClass("is-invalid", Boolean(this.icon) && icon === "sparkles");
				}),
			)
			.then((st) => {
				preview = st.controlEl.createSpan({ cls: "mica-icon-preview" });
				const icon = this.icon && getIcon(this.icon) ? this.icon : "sparkles";
				setIcon(preview, icon);
				preview.toggleClass("is-invalid", Boolean(this.icon) && icon === "sparkles");
			});
		new Setting(contentEl)
			.setName("Template")
			.setDesc("Placeholders: {selection} {all} {date} {time} {datetime} {cursor}")
			.addTextArea((t) => {
				t.setValue(this.template)
					.setPlaceholder("> [!quote] {date}\n> {selection}{cursor}")
					.onChange((v) => {
						this.template = v;
					});
				t.inputEl.rows = 5;
				t.inputEl.addClass("mica-settings-wide");
			});
		new Setting(contentEl)
			.setName("Show in")
			.setDesc("Choose which editor ribbons expose this button.")
			.addDropdown((d) =>
				d
					.addOption("markdown", "Markdown editors")
					.addOption("code", "Code editors")
					.addOption("both", "Markdown and code editors")
					.setValue(this.surface)
					.onChange((v) => {
						this.surface = v as typeof this.surface;
					}),
			);

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => {
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setCta()
					.setButtonText(this.existing ? "Save" : "Create")
					.onClick(async () => {
						const name = this.name.trim();
						if (!name) {
							new Notice("Give the custom button a name.");
							return;
						}
						if (!this.template.trim()) {
							new Notice("Give the custom button something to insert.");
							return;
						}
						if (this.icon && !getIcon(this.icon)) {
							new Notice(`“${this.icon}” is not an available Lucide icon in this Obsidian version.`);
							return;
						}
						const s = this.plugin.settings;
						if (this.existing) {
							this.existing.name = name;
							this.existing.icon = this.icon;
							this.existing.template = this.template;
							this.existing.surface = this.surface;
						} else {
							const base =
								name
									.toLowerCase()
									.replace(/[^a-z0-9]+/g, "-")
									.replace(/(^-|-$)/g, "") || "button";
							const ids = new Set(s.customTools.map((tool) => tool.id));
							let id = base;
							for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
							s.customTools.push({
								id,
								name,
								icon: this.icon || "sparkles",
								template: this.template,
								surface: this.surface,
							});
							s.toolbarLayout.push(`custom:${id}`);
						}
						await commitSetting(this.plugin, "customTools");
						this.close();
						this.onDone();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function contrastRatio(background: string, foreground: string): number | null {
	const bg = relativeLuminance(background);
	const fg = relativeLuminance(foreground);
	if (bg === null || fg === null) return null;
	const lighter = Math.max(bg, fg);
	const darker = Math.min(bg, fg);
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color: string): number | null {
	const match = color.trim().match(/^#([\da-f]{6})$/i);
	if (!match) return null;
	const hex = match[1];
	const channel = (start: number): number => {
		const value = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return channel(0) * 0.2126 + channel(2) * 0.7152 + channel(4) * 0.0722;
}
