import { Modal, PluginSettingTab, Setting, setIcon } from "obsidian";
import { builtinTools, DEFAULT_TOOLBAR_LAYOUT, type CustomTool } from "./ui/toolSpec";
import type MicaPlugin from "./main";
import { OBSIDIAN_CALLOUT_TYPES, type DiffGranularity } from "./wasm/bridge";

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
	/** Ordered editor-toolbar item ids ("|" = separator). */
	toolbarLayout: string[];
	/** Variant-group defaults (group id → variant id), following last use. */
	toolbarDefaults: Record<string, string>;
	/** User-defined template buttons (espanso-style placeholders). */
	customTools: CustomTool[];
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
	theme: "default",
	accentColor: "",
	density: "comfortable",
	cardRadiusPx: 10,
	tabStyle: "connected",
	animations: true,
	versionCalloutTypes: OBSIDIAN_CALLOUT_TYPES,
	blockHeaderMode: "hover",
	dragHandlePosition: "right",
	toolbarLayout: DEFAULT_TOOLBAR_LAYOUT,
	toolbarDefaults: {},
	customTools: [],
};

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
					this.micaPlugin.applyStyleVars();
					await save();
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
					this.micaPlugin.applyStyleVars();
					await save();
				}),
			)
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Follow the theme's accent")
					.onClick(async () => {
						s.accentColor = "";
						this.micaPlugin.applyStyleVars();
						await save();
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
						this.micaPlugin.applyStyleVars();
						await save();
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
						this.micaPlugin.applyStyleVars();
						await save();
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
						this.micaPlugin.applyStyleVars();
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Block header")
			.setDesc("The per-block bar with the name, navigator, and menu: show on hover, always, or never.")
			.addDropdown((d) =>
				d
					.addOption("hover", "On hover")
					.addOption("always", "Always")
					.addOption("never", "Never")
					.setValue(s.blockHeaderMode)
					.onChange(async (v) => {
						s.blockHeaderMode = v as MicaSettings["blockHeaderMode"];
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Hover tools position")
			.setDesc("Which corner a section's drag grip and edit pencil (and a cell's toolbar) appear in.")
			.addDropdown((d) =>
				d
					.addOption("right", "Top right")
					.addOption("left", "Top left")
					.setValue(s.dragHandlePosition)
					.onChange(async (v) => {
						s.dragHandlePosition = v as MicaSettings["dragHandlePosition"];
						this.micaPlugin.applyStyleVars();
						await save();
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
					this.micaPlugin.applyStyleVars();
					await save();
				}),
			);

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

		// ---------- Editor toolbar ----------
		new Setting(containerEl).setHeading().setName("Editor toolbar");
		new Setting(containerEl).setDesc(
			"Compose the ribbon shown in the quick editor and the lightbox: move items between the lists, reorder, add separators, and define your own template buttons.",
		);
		this.renderToolbarEditor(containerEl);

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

	/**
	 * The ribbon composer: available items on the left, the current toolbar on
	 * the right, arrows in the middle (add / remove / add-all / remove-all),
	 * reorder buttons, a separator well, and user-defined template buttons.
	 */
	private renderToolbarEditor(containerEl: HTMLElement): void {
		const s = this.micaPlugin.settings;
		const save = async (): Promise<void> => {
			await this.micaPlugin.saveSettings();
			this.micaPlugin.applyToolbarConfig();
		};

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
				"Your own insert buttons. Templates support {selection}, {all}, {date}, {time}, {datetime}, and {cursor} (where the caret lands).",
			)
			.addButton((b) =>
				b.setButtonText("New custom button…").onClick(() => {
					new CustomToolModal(this.micaPlugin, null, () => this.display()).open();
				}),
			);
		for (const tool of s.customTools) {
			new Setting(containerEl)
				.setName(tool.name)
				.setDesc(tool.template.length > 80 ? tool.template.slice(0, 80) + "…" : tool.template)
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
							await this.micaPlugin.saveSettings();
							this.micaPlugin.applyToolbarConfig();
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

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly existing: CustomTool | null,
		private readonly onDone: () => void,
	) {
		super(plugin.app);
		this.name = existing?.name ?? "";
		this.icon = existing?.icon ?? "sparkles";
		this.template = existing?.template ?? "";
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
					setIcon(preview, this.icon || "sparkles");
				}),
			)
			.then((st) => {
				preview = st.controlEl.createSpan({ cls: "mica-icon-preview" });
				setIcon(preview, this.icon || "sparkles");
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
						if (!name || !this.template) return;
						const s = this.plugin.settings;
						if (this.existing) {
							this.existing.name = name;
							this.existing.icon = this.icon;
							this.existing.template = this.template;
						} else {
							const id =
								name
									.toLowerCase()
									.replace(/[^a-z0-9]+/g, "-")
									.replace(/(^-|-$)/g, "") || String(Date.now());
							s.customTools.push({ id, name, icon: this.icon, template: this.template });
							s.toolbarLayout.push(`custom:${id}`);
						}
						await this.plugin.saveSettings();
						this.plugin.applyToolbarConfig();
						this.close();
						this.onDone();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
