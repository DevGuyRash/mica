import { getIcon, Modal, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import { builtinTools, DEFAULT_TOOLBAR_LAYOUT, type CustomTool } from "./ui/toolSpec";
import type MicaPlugin from "./main";
import { OBSIDIAN_CALLOUT_TYPES } from "./wasm/bridge";

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
	/** Master switch for auto-snapshotting (toggled live from each block's footer). */
	autoSnapshotEnabled: boolean;
	/** Idle time before an auto-snapshot fires after an edit. */
	snapshotDebounceMs: number;
	/** Intra-line highlight refinement in diffs. */
	diffRefine: "none" | "word" | "char";
	/** Exclude mica layout lines (`:::`, `tab:`) from diffs. */
	diffHideSyntax: boolean;
	/** Collapse runs of spaces/tabs before diffing. */
	diffIgnoreWs: boolean;
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
	autoSnapshotEnabled: true,
	snapshotDebounceMs: 5000,
	diffRefine: "word",
	diffHideSyntax: true,
	diffIgnoreWs: false,
	defaultDiffMode: "inline",
	showVersionChip: true,
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
	| "debouncer-runtime";

export const SETTING_LIFECYCLES = {
	autoSnapshotEnabled: "debouncer-runtime",
	snapshotDebounceMs: "debouncer-runtime",
	diffRefine: "next-open",
	diffHideSyntax: "next-open",
	diffIgnoreWs: "next-open",
	defaultDiffMode: "next-open",
	showVersionChip: "open-widget-rerender",
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
} as const satisfies Record<keyof MicaSettings, SettingLifecycle>;

/** Apply the declared lifecycle first, then persist the already-mutated value. */
export async function commitSetting(plugin: MicaPlugin, key: keyof MicaSettings): Promise<void> {
	switch (SETTING_LIFECYCLES[key]) {
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

export class MicaSettingTab extends PluginSettingTab {
	constructor(private readonly micaPlugin: MicaPlugin) {
		super(micaPlugin.app, micaPlugin);
	}

	/** The accent as a hex for the color picker: the user's override if set, else
	 * the theme/Obsidian accent resolved to a concrete color via a probe element. */
	private resolvedAccent(): string {
		if (this.micaPlugin.settings.accentColor) return this.micaPlugin.settings.accentColor;
		const probe = document.body.createSpan();
		probe.style.color = "var(--mica-accent)";
		const rgb = getComputedStyle(probe).color;
		probe.remove();
		const m = rgb.match(/\d+/g);
		if (!m || m.length < 3) return "#8b5cf6";
		return `#${m
			.slice(0, 3)
			.map((n) => Number(n).toString(16).padStart(2, "0"))
			.join("")}`;
	}

	/** Grouped by intent: Versioning, Comparing, Appearance, Migration. Knobs that
	 * only matter when a toggle is on are hidden until then, and fine-grained
	 * visual tuning is left to CSS variables rather than a wall of sliders. */
	display(): void {
		const { containerEl } = this;
		const s = this.micaPlugin.settings;
		const commit = (key: keyof MicaSettings): Promise<void> => commitSetting(this.micaPlugin, key);
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
					await commit("autoSnapshotEnabled");
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
							await commit("snapshotDebounceMs");
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
					await commit("autoAddIds");
				}),
			);

		new Setting(containerEl)
			.setName("Reconcile history on startup")
			.setDesc("On vault open, re-home version histories whose notes were renamed or moved, and report orphans.")
			.addToggle((t) =>
				t.setValue(s.reconcileOnLoad).onChange(async (v) => {
					s.reconcileOnLoad = v;
					await commit("reconcileOnLoad");
				}),
			);

		// ---------- Comparing ----------
		new Setting(containerEl).setHeading().setName("Comparing");

		new Setting(containerEl)
			.setName("Highlight changes within lines")
			.setDesc("Meld-style sub-line emphasis on changed lines: by word, by character, or off.")
			.addDropdown((d) =>
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
						await commit("defaultDiffMode");
					}),
			);

		new Setting(containerEl)
			.setName("Show exact version times")
			.setDesc("Append the local date and time to each relative age in version history.")
			.addToggle((t) =>
				t.setValue(s.showVersionExactTimestamps).onChange(async (v) => {
					s.showVersionExactTimestamps = v;
					await commit("showVersionExactTimestamps");
				}),
			);

		new Setting(containerEl)
			.setName("Hide mica syntax in diffs")
			.setDesc("Ignore layout lines (:::, tab:) when comparing — only real content differences show.")
			.addToggle((t) =>
				t.setValue(s.diffHideSyntax).onChange(async (v) => {
					s.diffHideSyntax = v;
					await commit("diffHideSyntax");
				}),
			);

		new Setting(containerEl)
			.setName("Ignore whitespace in diffs")
			.setDesc("Collapse runs of spaces and tabs before comparing.")
			.addToggle((t) =>
				t.setValue(s.diffIgnoreWs).onChange(async (v) => {
					s.diffIgnoreWs = v;
					await commit("diffIgnoreWs");
				}),
			);

		// ---------- Appearance ----------
		new Setting(containerEl).setHeading().setName("Appearance");

		new Setting(containerEl)
			.setName("Theme")
			.setDesc(
				"A named look. Each sets an accent that retints the whole block; “Match Obsidian” follows your theme's accent.",
			);
		const gallery = containerEl.createDiv({ cls: "mica-theme-gallery" });
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
				card.addEventListener("click", async () => {
					s.theme = t.id;
					await commit("theme");
					paintGallery();
				});
			}
		};
		paintGallery();

		new Setting(containerEl)
			.setName("Accent color")
			.setDesc("Override the theme's accent — it drives tabs, borders, and state. Reset to follow the theme.")
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
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Density")
			.setDesc("Comfortable or compact padding and control sizes.")
			.addDropdown((d) =>
				d
					.addOption("comfortable", "Comfortable")
					.addOption("compact", "Compact")
					.setValue(s.density)
					.onChange(async (v) => {
						s.density = v as MicaDensity;
						await commit("density");
					}),
			);

		new Setting(containerEl)
			.setName("Corner radius")
			.setDesc("Roundness of the block's corners (px).")
			.addSlider((sl) =>
				sl
					.setLimits(0, 20, 1)
					.setValue(s.cardRadiusPx)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.cardRadiusPx = v;
						await commit("cardRadiusPx");
					}),
			);

		new Setting(containerEl)
			.setName("Tab style")
			.setDesc("How the active tab is drawn: connected to its panel, a minimal underline, or a filled pill.")
			.addDropdown((d) =>
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

		new Setting(containerEl)
			.setName("Block header")
			.setDesc("The per-block bar with the name and action menu: show on hover, always, or never.")
			.addDropdown((d) =>
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

		new Setting(containerEl)
			.setName("Hover tools position")
			.setDesc("Which corner a section's drag grip and action menu (and a cell's controls) appear in.")
			.addDropdown((d) =>
				d
					.addOption("right", "Top right")
					.addOption("left", "Top left")
					.setValue(s.dragHandlePosition)
					.onChange(async (v) => {
						s.dragHandlePosition = v as MicaSettings["dragHandlePosition"];
						await commit("dragHandlePosition");
					}),
			);

		new Setting(containerEl)
			.setName("Action menus")
			.setDesc(
				"Open section, grid, cell, and tab ellipsis menus on click or after a short hover. Click always works.",
			)
			.addDropdown((d) =>
				d
					.addOption("click", "Click")
					.addOption("hover", "Hover")
					.setValue(s.actionMenuTrigger)
					.onChange(async (v) => {
						s.actionMenuTrigger = v as MicaSettings["actionMenuTrigger"];
						await commit("actionMenuTrigger");
					}),
			);

		new Setting(containerEl)
			.setName("Rendered action layout")
			.setDesc(
				"Show copy, edit, fold, and other actions directly when they fit, or always keep secondary actions in the three-dot menu. Tabs are always menu-only; drag stays direct.",
			)
			.addDropdown((d) =>
				d
					.addOption("responsive", "Responsive")
					.addOption("menu-only", "Always use three-dot menu")
					.setValue(s.entityActionLayout)
					.onChange(async (v) => {
						s.entityActionLayout = v as MicaSettings["entityActionLayout"];
						await commit("entityActionLayout");
					}),
			);

		new Setting(containerEl)
			.setName("Show tab action dots on hover")
			.setDesc(
				"Reveal each tab’s three-dot action menu on hover or keyboard focus. Right-click and keyboard context-menu access remain available when disabled.",
			)
			.addToggle((toggle) =>
				toggle.setValue(s.showTabActionMenuOnHover).onChange(async (value) => {
					s.showTabActionMenuOnHover = value;
					await commit("showTabActionMenuOnHover");
				}),
			);

		new Setting(containerEl)
			.setName("Animations")
			.setDesc(
				"Subtle motion on tab switches and version saves. Always off if your system prefers reduced motion.",
			)
			.addToggle((t) =>
				t.setValue(s.animations).onChange(async (v) => {
					s.animations = v;
					await commit("animations");
				}),
			);

		new Setting(containerEl)
			.setName("Version chip on blocks")
			.setDesc("Show the history-count chip (and unsaved-changes dot) in each block's footer.")
			.addToggle((t) =>
				t.setValue(s.showVersionChip).onChange(async (v) => {
					s.showVersionChip = v;
					await commit("showVersionChip");
				}),
			);

		new Setting(containerEl)
			.setName("Structural outlines")
			.setDesc(
				"Draw subtle borders around tabs, sections, and grid cells so the structure is always visible. Each block can override this via its appearance popover.",
			)
			.addToggle((t) =>
				t.setValue(s.showOutlines).onChange(async (v) => {
					s.showOutlines = v;
					await commit("showOutlines");
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
						await commit("tabGapPx");
					}),
			);

		new Setting(containerEl)
			.setName("Cap content height")
			.setDesc("Limit a tab or grid cell's height and scroll past it, instead of letting it grow unbounded.")
			.addToggle((t) =>
				t.setValue(s.limitContentHeight).onChange(async (v) => {
					s.limitContentHeight = v;
					await commit("limitContentHeight");
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
							await commit("contentMaxHeightPx");
						}),
				);
		}

		new Setting(containerEl).setDesc(
			"Finer visual tuning — colors, radii, control sizes — is exposed as CSS custom properties on `body` (see the plugin's styles.css). Override them with the Style Settings plugin or your theme.",
		);

		// ---------- Copying ----------
		new Setting(containerEl).setHeading().setName("Copying");

		new Setting(containerEl)
			.setName("Include Mica layout syntax")
			.setDesc(
				"Keep tab, grid, and cell wrapper lines in section copies. Standard Markdown such as callouts and code fences is always preserved.",
			)
			.addToggle((t) =>
				t.setValue(s.copyIncludeMicaSyntax).onChange(async (v) => {
					s.copyIncludeMicaSyntax = v;
					await commit("copyIncludeMicaSyntax");
				}),
			);

		new Setting(containerEl)
			.setName("Wrap copies in an outer Mica block")
			.setDesc(
				"Put copied content inside a safely sized Mica code fence. The source block id and appearance attributes are never copied.",
			)
			.addToggle((t) =>
				t.setValue(s.copyIncludeOuterContainer).onChange(async (v) => {
					s.copyIncludeOuterContainer = v;
					await commit("copyIncludeOuterContainer");
				}),
			);

		new Setting(containerEl)
			.setName("Include line numbers")
			.setDesc("Prefix copied lines with aligned plain-text numbers, such as “10 │ text”.")
			.addToggle((t) =>
				t.setValue(s.copyIncludeLineNumbers).onChange(async (v) => {
					s.copyIncludeLineNumbers = v;
					await commit("copyIncludeLineNumbers");
					this.display();
				}),
			);

		if (s.copyIncludeLineNumbers) {
			new Setting(containerEl)
				.setName("Lines to number")
				.setDesc("Number authored content only, or every final line including Mica wrappers.")
				.addDropdown((d) =>
					d
						.addOption("content", "Content only")
						.addOption("output", "Complete copied output")
						.setValue(s.copyLineNumberScope)
						.onChange(async (v) => {
							s.copyLineNumberScope = v as MicaSettings["copyLineNumberScope"];
							await commit("copyLineNumberScope");
						}),
				);
		}

		// ---------- Editors ----------
		new Setting(containerEl).setHeading().setName("Editors");

		new Setting(containerEl)
			.setName("Clicking outside an editor")
			.setDesc(
				"What happens to an open inline editor when you click elsewhere: keep editing, discard, or save & close (also prevents several cells editing at once).",
			)
			.addDropdown((d) =>
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

		new Setting(containerEl)
			.setName("Editor save shortcut")
			.setDesc(
				"The key that saves and closes an editor. New editors, placeholders, and tooltips use the selected shortcut. Esc always cancels.",
			)
			.addDropdown((d) =>
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

		new Setting(containerEl)
			.setName("Editor grows with content")
			.setDesc("The inline editor expands as you type (up to its max); off = a fixed height with a scrollbar.")
			.addToggle((t) =>
				t.setValue(s.editorAutosize).onChange(async (v) => {
					s.editorAutosize = v;
					await commit("editorAutosize");
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
						await commit("editorMaxHeightPx");
					}),
			);

		new Setting(containerEl)
			.setName("Line numbers")
			.setDesc(
				"Show line numbers in every Mica source editor: text, cells, combined sections, callouts, code blocks, whole blocks, and version branches. Also toggleable from editor chrome.",
			)
			.addToggle((t) =>
				t.setValue(s.editorLineNumbers).onChange(async (v) => {
					s.editorLineNumbers = v;
					await commit("editorLineNumbers");
				}),
			);

		new Setting(containerEl)
			.setName("Whitespace characters")
			.setDesc("Render spaces and tabs visibly in every Mica source editor.")
			.addToggle((t) =>
				t.setValue(s.editorWhitespace).onChange(async (v) => {
					s.editorWhitespace = v;
					await commit("editorWhitespace");
				}),
			);

		new Setting(containerEl)
			.setName("Style Markdown while editing")
			.setDesc(
				"Keep source markers visible while applying bold, italic, comment, link, quote, and heading styling.",
			)
			.addToggle((t) =>
				t.setValue(s.editorLiveSyntaxStyling).onChange(async (v) => {
					s.editorLiveSyntaxStyling = v;
					await commit("editorLiveSyntaxStyling");
				}),
			);

		new Setting(containerEl).setHeading().setName("Editor toolbar");
		new Setting(containerEl).setDesc(
			"Compose the Markdown authoring ribbon shown in quick editors and full lightboxes. Built-ins remain Markdown-only; custom buttons can target Markdown editors, code editors, or both.",
		);
		this.renderToolbarEditor(containerEl);

		// ---------- Migration ----------
		new Setting(containerEl).setHeading().setName("Migration");

		new Setting(containerEl)
			.setClass("mica-setting-stack")
			.setName("Import callouts as versions")
			.setDesc(
				"When migrating from obsidian-tabs, callouts of these comma-separated types become version history. Defaults to every built-in Obsidian type; leave empty to import ANY type (including custom ones), or narrow it (e.g. “success, bug, todo”).",
			)
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
						this.display();
					}),
			);
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

		new Setting(containerEl)
			.setName("Custom buttons")
			.setDesc(
				"Your own Markdown/code insert buttons. Templates support {selection}, {all}, {date}, {time}, {datetime}, and {cursor} (where the caret lands).",
			)
			.addButton((b) =>
				b.setButtonText("New custom button…").onClick(() => {
					new CustomToolModal(this.micaPlugin, null, () => this.display()).open();
				}),
			);
		for (const tool of s.customTools) {
			new Setting(containerEl)
				.setName(tool.name)
				.setDesc(
					`${tool.surface === "both" ? "Markdown + code" : tool.surface === "code" ? "Code" : "Markdown"} · ${
						tool.template.length > 80 ? tool.template.slice(0, 80) + "…" : tool.template
					}`,
				)
				.addExtraButton((b) =>
					b
						.setIcon("pencil")
						.setTooltip("Edit")
						.onClick(() => {
							new CustomToolModal(this.micaPlugin, tool, () => this.display()).open();
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
							this.display();
						}),
				);
		}
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
			.setDesc("A Lucide icon name (lucide.dev), e.g. rocket, stamp, wand-2.")
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
