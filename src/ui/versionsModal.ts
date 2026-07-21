import { Component, Menu, Modal, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { contentSignature, diffText, makePatch, parseBlock, scanBlocksView, type VersionMeta } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import { interactiveDiffIssue } from "../diff/budget";
import { renderDiff, renderNUp, renderPatch } from "../diff/diffView";
import { EditorLightbox } from "./lightbox";
import { matchingVersions, VERSION_ROW_PAGE_SIZE, versionPageBounds } from "./versionWindow";
import { renderCst } from "./blockShell";
import {
	buildScopeIndex,
	locatorFor,
	resolveScope,
	scopeBreadcrumb,
	scopeFingerprint,
	scopeSource,
	MAX_SCOPE_INDEX_CODE_UNITS,
	ScopeIndexTooLargeError,
	type ScopeIndex,
	type ScopeLocator,
	type ScopeResolution,
} from "./versionScope";

interface Row {
	meta: VersionMeta;
	/** 1-based add-order number (v1 = oldest) — matches the mica CLI. */
	n: number;
	head: boolean;
}

interface FocusedPair {
	base: string;
	selected: string;
	caption: string;
}

const WORKING = "__working__";
const CONTENT_CACHE_LIMIT = 12;
const MULTI_COMPARE_LIMIT = 4;

/**
 * The version history browser: a timeline (labels, relative times, origin,
 * head marker, the dirty working copy) beside a live diff surface. Every
 * version has one-click Restore / Branch-edit / Label / Copy actions —
 * versions finally have names and faces instead of "v14" in a dropdown.
 */
export class VersionsModal extends Modal {
	private rows: Row[] = [];
	private contents = new Map<string, string>();
	private readonly missing = new Set<string>();
	private readonly loading = new Map<string, Promise<boolean>>();
	private working = "";
	private blockConflict: string | null = null;
	private selected: string = WORKING; // hash or WORKING
	private baseMode: "previous" | "head" | string = "head"; // or a hash
	private refine: "none" | "word" | "char";
	private hideSyntax: boolean;
	private ignoreWs: boolean;
	private layout: "inline" | "side-by-side" | "patch";
	/** Hashes picked for the n-up multi-compare (≥2 switches the surface). */
	private readonly compareSet = new Set<string>();
	private surface: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private initialized = false;
	private rowPageStart = 0;
	private mode: "diff" | "inspect" = "diff";
	private inspectSelectedKey = "block:";
	private focusedLocator: ScopeLocator | null = null;
	private inspectVersionKey: string | null = null;
	private manualPick: { side: "base" | "selected"; key: string; base: string; selected: string } | null = null;
	private readonly scopeIndexes = new Map<string, ScopeIndex>();
	private readonly manualScopes = new Map<string, string>();
	private readonly focusDispositions = new Map<string, "added" | "removed">();
	private readonly scopeStatuses = new Map<
		string,
		"changed" | "unchanged" | "added" | "removed" | "needs matching"
	>();
	private inspectorChild: Component | null = null;
	private removeSettingsListener: (() => void) | null = null;
	private readonly openMenus = new Set<Menu>();

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly file: TFile,
		private readonly blockId: string,
	) {
		super(plugin.app);
		this.refine = plugin.settings.diffRefine;
		this.hideSyntax = plugin.settings.diffHideSyntax;
		this.ignoreWs = plugin.settings.diffIgnoreWs;
		this.layout = plugin.settings.defaultDiffMode;
	}

	/** Persist a diff preference (they survive across sessions). */
	/** The diff granularity for the current refine mode — word and char get
	 * OUR unconditional pairing ("line-word"/"line-char"); plain "line" keeps
	 * no sub-line emphasis (none mode strips what similar may emit). */
	private gran(): "line" | "line-word" | "line-char" {
		if (this.refine === "char") return "line-char";
		if (this.refine === "word") return "line-word";
		return "line";
	}

	private remember(patch: Partial<typeof this.plugin.settings>): void {
		Object.assign(this.plugin.settings, patch);
		void this.plugin.saveSettings();
	}

	/** Apply the active noise filters before any diff/patch computation. */
	private prep(text: string): string {
		let lines = text.split("\n");
		if (this.hideSyntax) {
			lines = lines.filter((l) => {
				const t = l.trim();
				return !t.startsWith(":::") && !/^tab:(\s|$)/.test(t);
			});
		}
		if (this.ignoreWs) lines = lines.map((l) => l.replace(/[ \t]+/g, " ").trimEnd());
		return lines.join("\n");
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("mica-versions-modal");
		this.titleEl.setText("Version history");
		// Walk the timeline from the keyboard.
		this.scope.register([], "ArrowUp", () => {
			this.step(-1);
			return false;
		});
		this.scope.register([], "ArrowDown", () => {
			this.step(1);
			return false;
		});
		const onSettingsChange = (): void => this.renderList();
		document.addEventListener("mica-settings-change", onSettingsChange);
		this.removeSettingsListener = () => document.removeEventListener("mica-settings-change", onSettingsChange);
		await this.reload();
	}

	/** Move the selection up/down the timeline (working copy included). */
	private step(delta: number): void {
		const includesWorking = this.isDirty() || this.selected === WORKING;
		const offset = includesWorking ? 1 : 0;
		const at =
			this.selected === WORKING
				? 0
				: Math.max(0, this.rows.findIndex((row) => row.meta.hash === this.selected) + offset);
		const nextIndex = Math.min(this.rows.length + offset - 1, Math.max(0, at + delta));
		const next = includesWorking && nextIndex === 0 ? WORKING : this.rows[nextIndex - offset]?.meta.hash;
		if (next && next !== this.selected) {
			this.selected = next;
			if (this.mode === "inspect") {
				this.inspectSelectedKey = "block:";
				this.inspectVersionKey = null;
				this.manualPick = null;
			}
			this.revealRowPage(next);
			this.renderList();
			this.renderDiffSurface();
		}
	}

	private async reload(): Promise<void> {
		const state = (await this.plugin.engine.state(this.file))[this.blockId];
		const versions = state?.versions ?? [];
		this.rows = versions.map((meta, i) => ({ meta, n: i + 1, head: state?.head === meta.hash })).reverse(); // newest first
		this.contents.clear();
		this.scopeIndexes.clear();
		this.missing.clear();
		// The live block content = the "working copy" pseudo-version.
		const doc = await this.plugin.app.vault.read(this.file);
		const matches = scanBlocksView(doc).filter((block) => block.id === this.blockId);
		this.blockConflict =
			matches.length === 1
				? null
				: matches.length === 0
					? "This block no longer exists in the note."
					: "This note contains duplicate block IDs. Run Mica: Repair history before using version actions.";
		this.working = matches.length === 1 ? doc.slice(matches[0].content_start, matches[0].content_end) : "";
		const head = this.rows.find((r) => r.head);
		if (head) await this.loadContent(head.meta.hash);
		// First open: a dirty block compares its working copy against head; a
		// clean one shows the LAST CHANGE (head vs previous) — never an empty diff.
		if (!this.initialized) {
			this.initialized = true;
			if (!this.isDirty() && this.rows.length) this.selected = this.rows[0].meta.hash;
		}
		this.revealRowPage(this.selected);
		this.render();
	}

	private revealRowPage(key: string): void {
		if (key === WORKING) {
			if (this.rowPageStart >= this.rows.length) this.rowPageStart = 0;
			return;
		}
		const index = this.rows.findIndex((row) => row.meta.hash === key);
		if (index >= 0 && (index < this.rowPageStart || index >= this.rowPageStart + VERSION_ROW_PAGE_SIZE)) {
			this.rowPageStart = Math.floor(index / VERSION_ROW_PAGE_SIZE) * VERSION_ROW_PAGE_SIZE;
		}
	}

	private text(key: string): string {
		if (key === WORKING) return this.working;
		const value = this.contents.get(key);
		if (value === undefined) return "";
		// LRU touch: selected/base versions stay hot without retaining history.
		this.contents.delete(key);
		this.contents.set(key, value);
		return value;
	}

	private loadContent(hash: string): Promise<boolean> {
		if (this.contents.has(hash)) return Promise.resolve(true);
		if (this.missing.has(hash)) return Promise.resolve(false);
		const pending = this.loading.get(hash);
		if (pending) return pending;
		const task = readObject(this.plugin.app.vault, this.file, hash)
			.then((content) => {
				if (content === null) {
					this.missing.add(hash);
					return false;
				}
				this.contents.set(hash, content);
				while (this.contents.size > CONTENT_CACHE_LIMIT) {
					const oldest = this.contents.keys().next().value as string | undefined;
					if (!oldest) break;
					this.contents.delete(oldest);
					this.scopeIndexes.delete(oldest);
				}
				return true;
			})
			.catch(() => {
				this.missing.add(hash);
				return false;
			})
			.finally(() => this.loading.delete(hash));
		this.loading.set(hash, task);
		return task;
	}

	private isDirty(): boolean {
		const head = this.rows.find((r) => r.head);
		if (!head) return contentSignature(this.working) !== contentSignature("");
		if (this.missing.has(head.meta.hash) || !this.contents.has(head.meta.hash)) return true;
		return contentSignature(this.text(head.meta.hash)) !== contentSignature(this.working);
	}

	/** The base content the selected version is compared against. */
	private baseKey(): string {
		if (this.baseMode !== "previous" && this.baseMode !== "head") return this.baseMode;
		const head = this.rows.find((r) => r.head);
		if (this.baseMode === "head") {
			// Comparing head with itself is meaningless — fall back to the
			// version just before it so the default view always shows a diff.
			if (head && this.selected === head.meta.hash) {
				const idx = this.rows.findIndex((r) => r.meta.hash === head.meta.hash);
				return this.rows[idx + 1]?.meta.hash ?? head.meta.hash;
			}
			return head?.meta.hash ?? WORKING;
		}
		// "previous": the version stored just before the selected one.
		if (this.selected === WORKING) return head?.meta.hash ?? WORKING;
		const idx = this.rows.findIndex((r) => r.meta.hash === this.selected);
		const prev = this.rows[idx + 1]; // rows are newest-first
		return prev?.meta.hash ?? this.selected;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.blockConflict) {
			contentEl.createEl("p", { cls: "mod-warning", text: this.blockConflict });
			return;
		}
		if (!this.rows.length && !this.working.trim()) {
			contentEl.createEl("p", {
				text: "No stored versions yet. Edit the block, or run “Save versions now”.",
			});
			return;
		}
		const root = contentEl.createDiv({ cls: "mica-versions-root" });
		this.listEl = root.createDiv({
			cls: "mica-versions-list",
			attr: { role: "listbox", "aria-label": "Block versions" },
		});
		const main = root.createDiv({ cls: "mica-versions-main" });
		this.renderList();
		this.renderToolbar(main);
		this.surface = main.createDiv({ cls: "mica-versions-surface" });
		this.renderDiffSurface();
	}

	// --- timeline ----------------------------------------------------------

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();

		if (this.isDirty() || this.selected === WORKING) {
			const row = list.createDiv({
				cls: `mica-vrow is-working ${this.selected === WORKING ? "is-selected" : ""}`,
				attr: {
					role: "option",
					tabindex: this.selected === WORKING ? "0" : "-1",
					"aria-selected": String(this.selected === WORKING),
				},
			});
			row.createDiv({ cls: "mica-vrow-title", text: "Working copy" });
			row.createDiv({ cls: "mica-vrow-sub", text: this.isDirty() ? "unsaved changes" : "matches head" });
			const activateWorking = (): void => {
				this.selected = WORKING;
				if (this.mode === "inspect") {
					this.inspectSelectedKey = "block:";
					this.inspectVersionKey = null;
					this.manualPick = null;
				}
				this.renderList();
				this.renderDiffSurface();
			};
			row.addEventListener("click", activateWorking);
			row.addEventListener("keydown", (event) => {
				if (event.target !== row) return;
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				activateWorking();
			});
		}

		const baseHash = this.baseKey();
		const page = versionPageBounds(this.rows.length, this.rowPageStart);
		this.rowPageStart = page.start;
		for (const r of this.rows.slice(page.start, page.end)) {
			const row = list.createDiv({
				cls: `mica-vrow ${this.selected === r.meta.hash ? "is-selected" : ""} ${r.head ? "is-head" : ""} ${
					baseHash === r.meta.hash ? "is-base" : ""
				}`,
				attr: {
					role: "option",
					tabindex: this.selected === r.meta.hash ? "0" : "-1",
					"aria-selected": String(this.selected === r.meta.hash),
				},
			});
			const title = row.createDiv({ cls: "mica-vrow-title" });
			title.createSpan({ cls: "mica-vrow-n", text: `v${r.n}` });
			if (baseHash === r.meta.hash) title.createSpan({ cls: "mica-vrow-basebadge", text: "base" });
			if (r.meta.label) title.createSpan({ cls: "mica-vrow-label", text: r.meta.label });
			if (r.head) {
				const headIco = title.createSpan({ cls: "mica-vrow-head", attr: { "aria-label": "Current head" } });
				setIcon(headIco, "check");
			}
			const sub = row.createDiv({ cls: "mica-vrow-sub" });
			const time = sub.createEl("time", {
				text: versionTime(r.meta.ts, this.plugin.settings.showVersionExactTimestamps),
				attr: { datetime: new Date(r.meta.ts).toISOString(), title: exactTimeTitle(r.meta.ts) },
			});
			void time;
			const scopeStatus = this.scopeStatuses.get(r.meta.hash);
			if (scopeStatus)
				sub.createSpan({
					cls: `mica-vrow-scope is-${scopeStatus.replace(" ", "-")}`,
					text: ` · ${scopeStatus}`,
				});
			const preview = this.contents.has(r.meta.hash) ? firstLine(this.text(r.meta.hash)) : "";
			if (this.missing.has(r.meta.hash)) sub.createSpan({ cls: "mica-vrow-preview", text: " · object missing" });
			if (preview) sub.createSpan({ cls: "mica-vrow-preview", text: ` · ${preview}` });

			const activateVersion = async (): Promise<void> => {
				this.selected = r.meta.hash;
				if (this.mode === "inspect") {
					this.inspectSelectedKey = "block:";
					this.inspectVersionKey = null;
					this.manualPick = null;
				}
				await this.loadContent(r.meta.hash);
				this.renderList();
				this.renderDiffSurface();
			};
			row.addEventListener("click", () => void activateVersion());
			row.addEventListener("keydown", (event) => {
				if (event.target !== row) return;
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				void activateVersion();
			});
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.versionMenu(e, r);
			});
			const cmp = row.createEl("button", {
				cls: `clickable-icon mica-vrow-more mica-vrow-cmp ${this.compareSet.has(r.meta.hash) ? "is-on" : ""}`,
				attr: { type: "button", "aria-label": "Toggle in multi-compare (2+ shows all side by side)" },
			});
			setIcon(cmp, "columns-3");
			cmp.addEventListener("click", (e) => {
				e.stopPropagation();
				if (!this.compareSet.delete(r.meta.hash)) {
					if (this.compareSet.size >= MULTI_COMPARE_LIMIT) {
						new Notice(`Choose at most ${MULTI_COMPARE_LIMIT} versions at once.`);
						return;
					}
					this.compareSet.add(r.meta.hash);
				}
				this.render();
			});
			const more = row.createEl("button", {
				cls: "clickable-icon mica-vrow-more",
				attr: { type: "button", "aria-label": "Version actions" },
			});
			setIcon(more, "ellipsis");
			more.addEventListener("click", (e) => {
				e.stopPropagation();
				this.versionMenu(e, r);
			});
		}
		if (this.rows.length > VERSION_ROW_PAGE_SIZE) {
			const pager = list.createDiv({ cls: "mica-vrow mica-vrow-pager" });
			pager.createSpan({
				text: `Versions ${page.start + 1}–${page.end} of ${this.rows.length}`,
			});
			if (this.rowPageStart > 0) {
				const newer = pager.createEl("button", { text: "Newer", attr: { type: "button" } });
				newer.addEventListener("click", () => {
					this.rowPageStart = Math.max(0, this.rowPageStart - VERSION_ROW_PAGE_SIZE);
					this.renderList();
				});
			}
			if (page.end < this.rows.length) {
				const older = pager.createEl("button", { text: "Older", attr: { type: "button" } });
				older.addEventListener("click", () => {
					this.rowPageStart += VERSION_ROW_PAGE_SIZE;
					this.renderList();
				});
			}
		}
	}

	private versionMenu(e: MouseEvent, r: Row): void {
		const menu = this.ownMenu(new Menu());
		menu.addItem((i) =>
			i
				.setTitle("Restore this version")
				.setIcon("archive-restore")
				.onClick(async () => {
					try {
						await this.plugin.engine.revert(this.file, this.blockId, r.meta.hash);
						new Notice(`Restored v${r.n} (previous state was snapshotted first).`);
						await this.reload();
					} catch (error) {
						new Notice(`Mica: restore failed — ${error instanceof Error ? error.message : String(error)}`);
					}
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Edit as new version (branch)")
				.setIcon("git-branch")
				.onClick(async () => {
					if (!(await this.loadContent(r.meta.hash))) {
						new Notice("Mica: this version object is missing or unreadable.");
						this.render();
						return;
					}
					new EditorLightbox({
						app: this.app,
						title: `Branch from v${r.n}${r.meta.label ? ` — ${r.meta.label}` : ""}`,
						initial: this.text(r.meta.hash),
						sourcePath: this.file.path,
						onSave: async (value) => {
							try {
								await this.plugin.engine.editVersion(this.file, this.blockId, r.meta.hash, value);
								new Notice(`New version created (branched from v${r.n}).`);
								await this.reload();
								return true;
							} catch (error) {
								new Notice(
									`Mica: branch edit failed — ${error instanceof Error ? error.message : String(error)}`,
								);
								return false;
							}
						},
					}).open();
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle(r.meta.label ? "Edit label…" : "Add label…")
				.setIcon("tag")
				.onClick(async () => {
					const label = window.prompt("Label for this version (empty removes):", r.meta.label ?? "");
					if (label === null) return;
					try {
						await this.plugin.engine.labelVersion(this.file, this.blockId, r.meta.hash, label.trim());
						await this.reload();
					} catch (error) {
						new Notice(`Mica: label failed — ${error instanceof Error ? error.message : String(error)}`);
					}
				}),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Copy content")
				.setIcon("copy")
				.onClick(async () => {
					if (!(await this.loadContent(r.meta.hash))) {
						new Notice("Mica: this version object is missing or unreadable.");
						this.render();
						return;
					}
					void navigator.clipboard.writeText(this.text(r.meta.hash)).then(
						() => new Notice("Version content copied."),
						() => new Notice("Couldn't access the clipboard."),
					);
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Use as diff base")
				.setIcon("git-compare")
				.onClick(() => {
					this.baseMode = r.meta.hash;
					this.render();
				}),
		);
		menu.showAtMouseEvent(e);
	}

	// --- diff surface ------------------------------------------------------

	private renderToolbar(main: HTMLElement): void {
		const bar = main.createDiv({ cls: "mica-versions-toolbar" });
		/** A labelled control cluster — the toolbar reads as sentences. */
		const group = (label: string): HTMLElement => {
			const g = bar.createDiv({ cls: "mica-vt-group" });
			g.createSpan({ cls: "mica-vt-label", text: label });
			return g.createDiv({ cls: "mica-vt-body" });
		};

		const seg = <T extends string>(
			host: HTMLElement,
			opts: [T, string][],
			value: T,
			pick: (v: T) => void,
		): void => {
			const wrap = host.createDiv({ cls: "mica-seg" });
			for (const [v, label] of opts) {
				const b = wrap.createEl("button", {
					cls: `clickable-icon mica-pop-seg ${v === value ? "is-on" : ""}`,
					text: label,
					attr: { type: "button" },
				});
				b.addEventListener("click", () => pick(v));
			}
		};

		seg(
			group("View"),
			[
				["diff", "Diff"],
				["inspect", "Inspect"],
			],
			this.mode,
			(mode) => {
				this.mode = mode;
				if (mode === "diff") {
					this.manualPick = null;
					this.inspectVersionKey = null;
				}
				this.render();
			},
		);

		// The base is always shown RESOLVED — "previous" names the version
		// stored just before the SELECTED one, never relative to head.
		const bk = this.baseKey();
		const resolved = bk === WORKING ? "working copy" : this.nameOf(bk);
		const suffix =
			this.baseMode === "previous"
				? " · auto: before selected"
				: this.baseMode === "head"
					? " · head"
					: " · pinned";
		const baseHost = group("Compare against");
		const baseBtn = baseHost.createEl("button", {
			cls: "mica-base-pick",
			text: `${resolved}${suffix}`,
			attr: { type: "button", "aria-label": "Choose what the selected version is compared against" },
		});
		baseBtn.addEventListener("click", (e) => {
			const menu = this.ownMenu(new Menu());
			menu.addItem((i) =>
				i
					.setTitle("Auto — the version before the selected one")
					.setChecked(this.baseMode === "previous")
					.onClick(() => this.setBase("previous")),
			);
			menu.addItem((i) =>
				i
					.setTitle("Head — the current version")
					.setChecked(this.baseMode === "head")
					.onClick(() => this.setBase("head")),
			);
			menu.addSeparator();
			if (this.selected !== WORKING) {
				const selected = this.rows.find((row) => row.meta.hash === this.selected);
				if (selected) {
					menu.addItem((i) =>
						i
							.setTitle(
								`Selected — v${selected.n}${selected.meta.label ? ` — ${selected.meta.label}` : ""}`,
							)
							.setChecked(this.baseMode === selected.meta.hash)
							.onClick(() => this.setBase(selected.meta.hash)),
					);
				}
			}
			menu.addItem((i) =>
				i.setTitle("Find version by number, label, or hash…").onClick(() => this.promptForBase()),
			);
			menu.showAtMouseEvent(e);
		});

		// Meld-style refinement: word/char highlights are exclusive checkboxes;
		// both off = plain line colors.
		const check = (
			host: HTMLElement,
			label: string,
			tip: string,
			on: boolean,
			flip: (next: boolean) => void,
		): void => {
			const lab = host.createEl("label", {
				cls: `mica-diff-check ${on ? "is-on" : ""}`,
				attr: { "aria-label": tip },
			});
			const box = lab.createEl("input", { attr: { type: "checkbox" } });
			box.checked = on;
			lab.createSpan({ text: label });
			box.addEventListener("change", () => flip(box.checked));
		};
		const hlHost = group("Highlight");
		check(hlHost, "Word", "Highlight changed words inside changed lines", this.refine === "word", (next) => {
			this.refine = next ? "word" : "none";
			this.remember({ diffRefine: this.refine });
			this.render();
		});
		check(hlHost, "Char", "Highlight changed characters inside changed lines", this.refine === "char", (next) => {
			this.refine = next ? "char" : "none";
			this.remember({ diffRefine: this.refine });
			this.render();
		});
		const filterHost = group("Filters");
		check(filterHost, "Hide syntax", "Ignore mica layout lines (:::, tab:) entirely", this.hideSyntax, (next) => {
			this.hideSyntax = next;
			this.remember({ diffHideSyntax: next });
			this.render();
		});
		check(filterHost, "Whitespace", "Collapse runs of spaces/tabs before comparing", this.ignoreWs, (next) => {
			this.ignoreWs = next;
			this.remember({ diffIgnoreWs: next });
			this.render();
		});
		seg(
			group("Layout"),
			[
				["inline", "Inline"],
				["side-by-side", "Split"],
				["patch", "Patch"],
			],
			this.layout,
			(v) => {
				this.layout = v;
				this.remember({ defaultDiffMode: v });
				this.render();
			},
		);

		if (this.compareSet.size) {
			const chip = bar.createEl("button", {
				cls: "mica-base-pick",
				text: `n-up: ${this.compareSet.size} picked · clear`,
				attr: { type: "button", "aria-label": "Clear the multi-compare selection" },
			});
			chip.addEventListener("click", () => {
				this.compareSet.clear();
				this.render();
			});
		}

		bar.createDiv({ cls: "mica-footer-spacer" });
		const copyPatch = bar.createEl("button", {
			cls: "mica-base-pick",
			text: "Copy patch",
			attr: { type: "button" },
		});
		copyPatch.addEventListener("click", () => void this.copyPatch());
	}

	private setBase(mode: "previous" | "head" | string): void {
		this.baseMode = mode;
		this.manualPick = null;
		this.inspectVersionKey = null;
		this.revealRowPage(mode);
		this.render();
	}

	private promptForBase(): void {
		const query = window.prompt("Version to use as base (v123, exact label, or hash prefix):", "");
		if (query === null || !query.trim()) return;
		const normalized = query.trim();
		const matches = matchingVersions(this.rows, normalized);
		if (matches.length !== 1) {
			new Notice(
				matches.length
					? `Mica: “${normalized}” matches ${matches.length} versions; enter more hash characters.`
					: `Mica: no version matches “${normalized}”.`,
			);
			return;
		}
		this.setBase(matches[0].meta.hash);
	}

	private nameOf(hash: string): string {
		const r = this.rows.find((x) => x.meta.hash === hash);
		return r ? `v${r.n}` : hash.slice(0, 10);
	}

	private ownMenu(menu: Menu): Menu {
		this.openMenus.add(menu);
		menu.onHide(() => this.openMenus.delete(menu));
		return menu;
	}

	private scopeIndexFor(key: string): ScopeIndex {
		const cached = this.scopeIndexes.get(key);
		if (cached) {
			this.scopeIndexes.delete(key);
			this.scopeIndexes.set(key, cached);
			return cached;
		}
		const index = buildScopeIndex(this.text(key));
		this.scopeIndexes.set(key, index);
		while (this.scopeIndexes.size > CONTENT_CACHE_LIMIT) {
			const oldest = this.scopeIndexes.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			this.scopeIndexes.delete(oldest);
		}
		return index;
	}

	private disposeInspector(): void {
		if (!this.inspectorChild) return;
		this.inspectorChild.unload();
		this.inspectorChild = null;
	}

	private renderInspectSurface(surface: HTMLElement): void {
		const key = this.inspectVersionKey ?? this.selected;
		if (key !== WORKING && this.missing.has(key)) {
			surface.createDiv({ cls: "mica-diff-caption", text: "This version object is missing or unreadable." });
			return;
		}
		if (key !== WORKING && !this.contents.has(key)) {
			surface.createDiv({ cls: "mica-diff-caption", text: "Loading the selected version…" });
			void this.loadContent(key).then(() => {
				this.renderList();
				this.renderDiffSurface();
			});
			return;
		}
		let index: ScopeIndex;
		try {
			index = this.scopeIndexFor(key);
		} catch (error) {
			const detail =
				error instanceof ScopeIndexTooLargeError
					? `This snapshot exceeds the ${Math.floor(MAX_SCOPE_INDEX_CODE_UNITS / 1024)} KiB interactive inspector limit. Whole-block history remains available.`
					: `This snapshot could not be inspected: ${error instanceof Error ? error.message : String(error)}`;
			surface.createDiv({ cls: "mica-diff-caption", text: detail });
			return;
		}
		if (!index.byKey.has(this.inspectSelectedKey)) this.inspectSelectedKey = "block:";
		surface.createDiv({
			cls: "mica-diff-caption",
			text: `Inspecting ${key === WORKING ? "working copy" : this.nameOf(key)} · choose a Mica object, then compare it`,
		});
		const viewport = surface.createDiv({ cls: "mica-inspector-viewport" });
		const render = viewport.createDiv({ cls: "mica-inspector-render" });
		const footer = surface.createDiv({ cls: "mica-inspector-footer" });
		const child = new Component();
		child.load();
		this.inspectorChild = child;

		const paintFooter = (scopeKey: string): void => {
			const selected = index.byKey.get(scopeKey) ?? index.byKey.get("block:");
			if (!selected) return;
			this.inspectSelectedKey = selected.key;
			footer.empty();
			const breadcrumb = footer.createDiv({
				cls: "mica-inspector-breadcrumb",
				attr: { "aria-label": "Selected scope ancestry" },
			});
			const ancestors = index.scopes
				.filter((scope) => scope.start <= selected.start && scope.end >= selected.end)
				.sort((left, right) => right.end - right.start - (left.end - left.start));
			for (const [position, scope] of ancestors.entries()) {
				if (position) breadcrumb.createSpan({ cls: "mica-inspector-separator", text: "›" });
				const label = scopeBreadcrumb(scope).at(-1) ?? scope.kind;
				const button = breadcrumb.createEl("button", { text: label, attr: { type: "button" } });
				button.toggleClass("is-current", scope.key === selected.key);
				button.addEventListener("click", () => {
					render
						.querySelectorAll(".is-inspect-selected")
						.forEach((node) => node.removeClass("is-inspect-selected"));
					render.querySelectorAll<HTMLElement>("[data-mica-inspect-key]").forEach((node) => {
						if (node.dataset.micaInspectKey === scope.key) node.addClass("is-inspect-selected");
					});
					paintFooter(scope.key);
				});
			}
			footer.createDiv({ cls: "mica-footer-spacer" });
			const compare = footer.createEl("button", {
				cls: "mod-cta",
				text: "Compare selected",
				attr: { type: "button" },
			});
			if (this.manualPick) compare.setText("Pair selected scope");
			compare.addEventListener("click", () => {
				if (this.manualPick) {
					const pick = this.manualPick;
					this.manualScopes.set(
						this.manualScopeKey(pick.base, pick.selected, pick.side, pick.key),
						selected.key,
					);
					this.manualPick = null;
					this.inspectVersionKey = null;
				} else {
					this.focusedLocator = locatorFor(selected, index);
					this.manualScopes.clear();
					this.focusDispositions.clear();
					this.scopeStatuses.clear();
				}
				this.mode = "diff";
				this.render();
			});
		};

		renderCst(parseBlock(this.text(key)), render, {
			app: this.app,
			sourcePath: this.file.path,
			component: child,
			headerMode: "never",
			inspection: { selectedKey: this.inspectSelectedKey, onSelect: paintFooter },
		});
		paintFooter(this.inspectSelectedKey);
	}

	private locatorId(): string {
		const locator = this.focusedLocator;
		return locator ? JSON.stringify([locator.kind, locator.signature, locator.label, locator.ancestry]) : "";
	}

	private manualScopeKey(base: string, selected: string, side: "base" | "selected", key: string): string {
		return JSON.stringify([base, selected, side, key, this.locatorId()]);
	}

	private resolveFocused(key: string, base: string, selected: string, side: "base" | "selected"): ScopeResolution {
		if (!this.focusedLocator) return { kind: "missing" };
		return resolveScope(
			this.scopeIndexFor(key),
			this.focusedLocator,
			this.manualScopes.get(this.manualScopeKey(base, selected, side, key)),
		);
	}

	private renderResolutionPicker(
		surface: HTMLElement,
		side: "base" | "selected",
		key: string,
		resolution: Exclude<ScopeResolution, { kind: "exact" }>,
		base: string,
		selected: string,
		allowedDisposition: "added" | "removed" | null,
	): void {
		const label = side === "base" ? "comparison base" : "selected snapshot";
		surface.createDiv({
			cls: "mica-diff-caption",
			text:
				resolution.kind === "missing"
					? `The focused object is missing from the ${label}. Choose how to compare it.`
					: `More than one object could be the focused object in the ${label}. Choose the counterpart explicitly.`,
		});
		const picker = surface.createDiv({ cls: "mica-scope-picker" });
		if (resolution.kind === "ambiguous") {
			for (const candidate of resolution.candidates) {
				const button = picker.createEl("button", {
					cls: "mica-scope-candidate",
					attr: { type: "button" },
				});
				button.createDiv({ cls: "mica-scope-candidate-title", text: scopeBreadcrumb(candidate).join(" › ") });
				button.createDiv({
					cls: "mica-scope-candidate-preview",
					text: firstLine(scopeSource(this.scopeIndexFor(key), candidate)) || "Empty scope",
				});
				button.addEventListener("click", () => {
					this.manualScopes.set(this.manualScopeKey(base, selected, side, key), candidate.key);
					this.renderDiffSurface();
				});
			}
			if (resolution.truncated)
				picker.createDiv({
					cls: "mica-diff-caption",
					text: "More matching scopes exist; inspect the snapshot to choose one that is not listed.",
				});
		}
		const actions = surface.createDiv({ cls: "mica-scope-picker-actions" });
		if (side === "base") {
			const chooseBase = actions.createEl("button", { text: "Choose another base…", attr: { type: "button" } });
			chooseBase.addEventListener("click", () => this.promptForBase());
		}
		const inspect = actions.createEl("button", { text: "Inspect snapshot to choose…", attr: { type: "button" } });
		inspect.addEventListener("click", () => {
			this.manualPick = { side, key, base, selected };
			this.inspectVersionKey = key;
			this.inspectSelectedKey = "block:";
			this.mode = "inspect";
			this.render();
		});
		for (const disposition of allowedDisposition ? [allowedDisposition] : []) {
			const button = actions.createEl("button", {
				text: disposition === "added" ? "Treat it as added" : "Treat it as removed",
				attr: { type: "button" },
			});
			button.addEventListener("click", () => {
				this.focusDispositions.set(`${base}→${selected}|${this.locatorId()}`, disposition);
				this.renderDiffSurface();
			});
		}
		const cancel = actions.createEl("button", { text: "Cancel focused comparison", attr: { type: "button" } });
		cancel.addEventListener("click", () => {
			this.focusedLocator = null;
			this.scopeStatuses.clear();
			this.render();
		});
	}

	private focusedPair(surface: HTMLElement, baseKey: string): FocusedPair | null {
		if (!this.focusedLocator || this.compareSet.size >= 2) return null;
		if (
			this.text(baseKey).length > MAX_SCOPE_INDEX_CODE_UNITS ||
			this.text(this.selected).length > MAX_SCOPE_INDEX_CODE_UNITS
		) {
			surface.createDiv({
				cls: "mica-diff-caption",
				text: `Focused comparison exceeds the ${Math.floor(MAX_SCOPE_INDEX_CODE_UNITS / 1024)} KiB interactive inspector limit. Cancel focused comparison to use the whole-block view.`,
			});
			return null;
		}
		const baseResolution = this.resolveFocused(baseKey, baseKey, this.selected, "base");
		const selectedResolution = this.resolveFocused(this.selected, baseKey, this.selected, "selected");
		const disposition = this.focusDispositions.get(`${baseKey}→${this.selected}|${this.locatorId()}`);
		if (disposition === "added" && baseResolution.kind === "missing" && selectedResolution.kind === "exact") {
			this.updateScopeStatus();
			return {
				base: "",
				selected: scopeSource(this.scopeIndexFor(this.selected), selectedResolution.scope),
				caption: `${this.focusedLocator.label || this.focusedLocator.kind} · added`,
			};
		}
		if (disposition === "removed" && baseResolution.kind === "exact" && selectedResolution.kind === "missing") {
			this.updateScopeStatus();
			return {
				base: scopeSource(this.scopeIndexFor(baseKey), baseResolution.scope),
				selected: "",
				caption: `${this.focusedLocator.label || this.focusedLocator.kind} · removed`,
			};
		}
		if (selectedResolution.kind !== "exact") {
			this.renderResolutionPicker(
				surface,
				"selected",
				this.selected,
				selectedResolution,
				baseKey,
				this.selected,
				selectedResolution.kind === "missing" && baseResolution.kind === "exact" ? "removed" : null,
			);
			this.updateScopeStatus();
			return null;
		}
		if (baseResolution.kind !== "exact") {
			this.renderResolutionPicker(
				surface,
				"base",
				baseKey,
				baseResolution,
				baseKey,
				this.selected,
				baseResolution.kind === "missing" && selectedResolution.kind === "exact" ? "added" : null,
			);
			this.updateScopeStatus();
			return null;
		}
		this.updateScopeStatus();
		return {
			base: scopeSource(this.scopeIndexFor(baseKey), baseResolution.scope),
			selected: scopeSource(this.scopeIndexFor(this.selected), selectedResolution.scope),
			caption: scopeBreadcrumb(selectedResolution.scope).join(" › "),
		};
	}

	private updateScopeStatus(): void {
		if (!this.focusedLocator || this.selected === WORKING) return;
		const rowIndex = this.rows.findIndex((row) => row.meta.hash === this.selected);
		if (rowIndex < 0) return;
		const previous = this.rows[rowIndex + 1];
		if (previous && !this.contents.has(previous.meta.hash) && !this.missing.has(previous.meta.hash)) {
			void this.loadContent(previous.meta.hash).then(() => this.updateScopeStatus());
			return;
		}
		const previousKey = previous?.meta.hash ?? this.selected;
		const currentResolution = this.resolveFocused(this.selected, previousKey, this.selected, "selected");
		const previousResolution = previous
			? this.resolveFocused(previous.meta.hash, previousKey, this.selected, "base")
			: { kind: "missing" as const };
		const disposition = this.focusDispositions.get(`${previousKey}→${this.selected}|${this.locatorId()}`);
		let status: "changed" | "unchanged" | "added" | "removed" | "needs matching";
		if (disposition === "added") status = "added";
		else if (disposition === "removed") status = "removed";
		else if (currentResolution.kind === "ambiguous" || previousResolution.kind === "ambiguous")
			status = "needs matching";
		else if (currentResolution.kind === "missing")
			status = previousResolution.kind === "exact" ? "removed" : "needs matching";
		else if (previousResolution.kind === "missing") status = "added";
		else {
			status =
				scopeFingerprint(this.scopeIndexFor(this.selected), currentResolution.scope) ===
				scopeFingerprint(this.scopeIndexFor(previous.meta.hash), previousResolution.scope)
					? "unchanged"
					: "changed";
		}
		if (this.scopeStatuses.get(this.selected) !== status) {
			this.scopeStatuses.set(this.selected, status);
			queueMicrotask(() => this.renderList());
		}
	}

	private renderDiffSurface(): void {
		const surface = this.surface;
		if (!surface) return;
		this.disposeInspector();
		surface.empty();
		if (this.mode === "inspect") {
			this.renderInspectSurface(surface);
			return;
		}
		const bk = this.baseKey();
		const needed = new Set<string>();
		if (bk !== WORKING) needed.add(bk);
		if (this.selected !== WORKING) needed.add(this.selected);
		if (this.compareSet.size >= 2) for (const hash of this.compareSet) needed.add(hash);
		const missing = [...needed].filter((hash) => this.missing.has(hash));
		if (missing.length) {
			surface.createDiv({
				cls: "mica-diff-caption",
				text: `Version object missing or unreadable: ${missing.map((hash) => hash.slice(0, 12)).join(", ")}`,
			});
			return;
		}
		const unloaded = [...needed].filter((hash) => !this.contents.has(hash));
		if (unloaded.length) {
			surface.createDiv({ cls: "mica-diff-caption", text: "Loading selected versions…" });
			void Promise.all(unloaded.map((hash) => this.loadContent(hash))).then(() => {
				this.renderList();
				this.renderDiffSurface();
			});
			return;
		}
		let baseRaw = this.text(bk);
		let selectedRaw = this.text(this.selected);
		const focused = this.focusedPair(surface, bk);
		if (this.focusedLocator && this.compareSet.size < 2 && !focused) return;
		if (focused) {
			baseRaw = focused.base;
			selectedRaw = focused.selected;
		}
		const caption = surface.createDiv({ cls: "mica-diff-caption" });
		const names = `${focused ? `${focused.caption} · ` : ""}${bk === WORKING ? "working copy" : this.nameOf(bk)} → ${
			this.selected === WORKING ? "working copy" : this.nameOf(this.selected)
		}`;
		const body = surface.createDiv();
		if (this.compareSet.size >= 2) {
			// N-up: every picked version diffed against the SAME base, column each.
			const gran = this.gran();
			const picked = this.rows.filter((r) => this.compareSet.has(r.meta.hash));
			for (const row of picked) {
				const issue = interactiveDiffIssue(baseRaw, this.text(row.meta.hash), gran);
				if (issue) {
					caption.setText(`Interactive diff unavailable: ${issue}. Use the mica CLI for this comparison.`);
					return;
				}
			}
			const base = this.prep(baseRaw);
			caption.setText(`${bk === WORKING ? "working copy" : this.nameOf(bk)} → ${picked.length} versions`);
			renderNUp(
				body,
				{ label: this.nameOf(bk), text: base },
				picked.map((r) => {
					const result = diffText(base, this.prep(this.text(r.meta.hash)), gran, 3);
					if (this.refine === "none") for (const h of result.hunks) for (const c of h.changes) c.inline = [];
					return { label: `v${r.n}${r.meta.label ? ` — ${r.meta.label}` : ""}`, result };
				}),
			);
			return;
		}
		if (this.layout === "patch") {
			const issue = interactiveDiffIssue(baseRaw, selectedRaw, "line");
			if (issue) {
				caption.setText(`Interactive diff unavailable: ${issue}. Use the mica CLI for this comparison.`);
				return;
			}
			const base = this.prep(baseRaw);
			const to = this.prep(selectedRaw);
			caption.setText(names);
			renderPatch(body, makePatch(base, to, 3));
			return;
		}
		const issue = interactiveDiffIssue(baseRaw, selectedRaw, this.gran());
		if (issue) {
			caption.setText(`Interactive diff unavailable: ${issue}. Use the mica CLI for this comparison.`);
			return;
		}
		const base = this.prep(baseRaw);
		const to = this.prep(selectedRaw);
		const result = diffText(base, to, this.gran(), 3);
		if (this.refine === "none") {
			for (const h of result.hunks) for (const c of h.changes) c.inline = [];
		}
		caption.setText(`${names} · ${Math.round(result.similarity * 100)}% similar`);
		renderDiff(body, result, this.layout);
	}

	private async copyPatch(): Promise<void> {
		const keys = [this.baseKey(), this.selected].filter((key) => key !== WORKING);
		if (!(await Promise.all(keys.map((hash) => this.loadContent(hash)))).every(Boolean)) {
			new Notice("Mica: a selected version object is missing or unreadable.");
			this.render();
			return;
		}
		let baseRaw = this.text(this.baseKey());
		let selectedRaw = this.text(this.selected);
		if (this.focusedLocator && this.compareSet.size < 2) {
			const focused = this.focusedPair(document.createElement("div"), this.baseKey());
			if (!focused) {
				new Notice("Choose the focused object's counterpart before copying its patch.");
				return;
			}
			baseRaw = focused.base;
			selectedRaw = focused.selected;
		}
		const issue = interactiveDiffIssue(baseRaw, selectedRaw, "line");
		if (issue) {
			new Notice(`Mica: ${issue}. Use the mica CLI for this comparison.`);
			return;
		}
		const base = this.prep(baseRaw);
		const selected = this.prep(selectedRaw);
		const patch = makePatch(base, selected, 3);
		if (!patch.trim()) {
			new Notice("No differences to copy.");
			return;
		}
		try {
			await navigator.clipboard.writeText(patch);
			new Notice("Patch copied.");
		} catch {
			new Notice("Couldn't access the clipboard.");
		}
	}

	onClose(): void {
		for (const menu of this.openMenus) menu.hide();
		this.openMenus.clear();
		this.disposeInspector();
		this.removeSettingsListener?.();
		this.removeSettingsListener = null;
		this.surface = null;
		this.listEl = null;
		this.contents.clear();
		this.scopeIndexes.clear();
		this.manualScopes.clear();
		this.focusDispositions.clear();
		this.scopeStatuses.clear();
		this.missing.clear();
		this.contentEl.empty();
	}
}

function relTime(ts: number): string {
	const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (secs < 5) return "just now";
	if (secs < 60) return `${secs}s ago`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
	if (secs < 30 * 86400) return `${Math.floor(secs / 86400)}d ago`;
	if (secs < 365 * 86400) return `${Math.floor(secs / (30 * 86400))}mo ago`;
	return `${Math.floor(secs / (365 * 86400))}y ago`;
}

function versionTime(ts: number, exact: boolean): string {
	const relative = relTime(ts);
	return exact
		? `${relative} · ${new Date(ts).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "medium",
			})}`
		: relative;
}

function exactTimeTitle(ts: number): string {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
	return `${new Date(ts).toISOString()} · ${zone}`;
}

function firstLine(content: string): string {
	const prefix = content.slice(0, 64 * 1024);
	let start = 0;
	while (start <= prefix.length) {
		const newline = prefix.indexOf("\n", start);
		const end = newline < 0 ? prefix.length : newline;
		const sampleEnd = Math.min(end, start + 256);
		const line = prefix.slice(start, sampleEnd);
		const t = line.trim();
		if (t && !t.startsWith(":::") && !t.startsWith("tab:") && !t.startsWith("```")) {
			return t.length > 48 ? `${t.slice(0, 48)}…` : t;
		}
		if (newline < 0) break;
		start = newline + 1;
	}
	return "";
}
