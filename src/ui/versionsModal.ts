import { Component, Menu, Modal, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { contentSignature, diffText, makePatch, parseBlock, scanBlocksView, type VersionMeta } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import { interactiveDiffIssue } from "../diff/budget";
import { renderDiff, renderNUp, renderNUpPatch, renderPatch } from "../diff/diffView";
import { stripStructuralLines } from "../diff/hideSyntax";
import {
	describePlan,
	MAX_COMPARISON_COLUMNS,
	planCells,
	planComparison,
	planKeys,
	type ComparisonPlan,
	type ComparisonTarget,
} from "./comparisonPlan";
import { EditorLightbox } from "./lightbox";
import { VERSION_ROW_PAGE_SIZE, versionPageBounds } from "./versionWindow";
import { VersionLabelModal, VersionPickerModal } from "./versionPicker";
import {
	buildScopeTransition,
	contentResemblance,
	resolveSelectedTransition,
	type ScopeTransition,
} from "./versionTransition";
import { rangeCandidates, reconcileScopeSelection, selectScope, type ScopeSelectionState } from "./scopeSelection";
import { buildVersionParentIndex, versionLineageRouteFromParents, type LineageStep } from "./versionLineage";
import { mergeTimelineRows, nextPickedSelection, partitionPicked } from "./versionTimeline";
import { buildVersionBaseIndex, resolveVersionBase, type VersionBaseIndex, type VersionBaseMode } from "./versionBase";
import { renderCst } from "./blockShell";
import {
	buildScopeIndex,
	locatorFor,
	resolveScope,
	scopeDisplayName,
	scopeFingerprint,
	scopeSource,
	MAX_SCOPE_INDEX_CODE_UNITS,
	ScopeIndexTooLargeError,
	type ScopeIndex,
	type ScopeLocator,
	type ScopeResolution,
	type VersionScope,
} from "./versionScope";

interface Row {
	meta: VersionMeta;
	/** 1-based dense visible number (v1 = oldest currently visible). */
	n: number;
	head: boolean;
	originalIndex: number;
	timelineIndex: number;
	removed?: boolean;
}

interface FocusedPair {
	base: string;
	selected: string;
	/** Element name plus how it changed — for the whole-block caption and for
	 * copied patch headings, where the name has not been shown yet. */
	caption: string;
	/** How it changed, alone. A row already displays its own name; repeating it
	 * in the status beside it is noise. */
	status: string;
}

interface FocusedSelection {
	locator: ScopeLocator;
	originVersion: string;
	originKey: string;
}

export interface WorkingCopyProvider {
	readDocument(): string | null;
	flush(expectedDocument: string): Promise<boolean>;
}

const WORKING = "__working__";
const EMPTY = "__empty__";
const CONTENT_CACHE_LIMIT = 12;

/**
 * The version history browser: a timeline (labels, relative times, origin,
 * head marker, the dirty working copy) beside a live diff surface. Every
 * version has one-click Restore / Branch-edit / Label / Copy actions —
 * versions finally have names and faces instead of "v14" in a dropdown.
 */
export class VersionsModal extends Modal {
	private rows: Row[] = [];
	private baseIndex: VersionBaseIndex<Row> = { byId: new Map(), head: null };
	private removedRowIds = new Set<string>();
	private versionParents = new Map<string, string | null>();
	private contents = new Map<string, string>();
	private readonly missing = new Set<string>();
	private readonly loading = new Map<string, Promise<boolean>>();
	private working = "";
	private rawHeadHash: string | null = null;
	private blockConflict: string | null = null;
	private selected: string = WORKING; // hash or WORKING
	private baseMode: VersionBaseMode = "auto"; // or a pinned hash
	private refine: "none" | "word" | "char";
	private hideSyntax: boolean;
	private ignoreWs: boolean;
	private layout: "inline" | "side-by-side" | "patch";
	/**
	 * One selection, not three. Checking versions drives the multi-version
	 * comparison AND the bulk timeline actions, so a checkpoint can never be
	 * "compared" and "not selected" at the same time — and `reload` has exactly
	 * one set to prune when a checkpoint leaves the timeline.
	 */
	private readonly picked = new Set<string>();
	private removedRows: Row[] = [];
	/** Removed checkpoints are a filter over the timeline, not a separate mode. */
	private showRemoved = false;
	private compareAnchor: string | null = null;
	private surface: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private initialized = false;
	private rowPageStart = 0;
	private mode: "diff" | "inspect" = "diff";
	private inspectSelection: ScopeSelectionState = { mode: "one", keys: ["block:"], anchor: "block:" };
	private focusedLocator: ScopeLocator | null = null;
	private focusedOriginVersion: string | null = null;
	private focusedOriginKey: string | null = null;
	private focusedSelections: FocusedSelection[] = [];
	/** Which focused-element rows are expanded, keyed by locator id. Owned here
	 * so an async lineage resolve — which repaints the whole surface — cannot
	 * collapse what the user just opened. */
	private readonly openFocusedRows = new Set<string>();
	/** Bumped whenever the surface is rebuilt, so a resolve that lands after a
	 * mode or version change is discarded instead of repainting a stale view. */
	private surfaceGeneration = 0;
	private inspectVersionKey: string | null = null;
	private manualPick: {
		side: "base" | "selected";
		key: string;
		base: string;
		selected: string;
		locatorId: string;
	} | null = null;
	private readonly scopeIndexes = new Map<string, ScopeIndex>();
	private readonly scopeTransitions = new Map<string, ScopeTransition>();
	private readonly lineageResults = new Map<string, ScopeResolution>();
	private readonly lineageLoading = new Map<string, Promise<void>>();
	private lineageGeneration = 0;
	private readonly manualScopes = new Map<string, string>();
	private readonly focusDispositions = new Map<string, "added" | "removed">();
	private readonly scopeStatuses = new Map<
		string,
		"changed" | "unchanged" | "converted" | "combined" | "split" | "added" | "removed" | "needs matching"
	>();
	private inspectorChild: Component | null = null;
	private candidatePreviewChild: Component | null = null;
	private removeSettingsListener: (() => void) | null = null;
	private readonly openMenus = new Set<Menu>();
	private closed = false;

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly file: TFile,
		private readonly blockId: string,
		private readonly workingCopyProvider?: WorkingCopyProvider,
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
		// Scaffolding is identified from the CST, never from line prefixes: a
		// leaf may legitimately begin with `:::`, and dropping it would delete a
		// real change from the diff. Parsing only happens when the filter is on.
		let source = text;
		if (this.hideSyntax) {
			try {
				source = stripStructuralLines(parseBlock(text));
			} catch {
				// An unparseable fragment still deserves a diff; show it whole.
				source = text;
			}
		}
		if (!this.ignoreWs) return source;
		return source
			.split("\n")
			.map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
			.join("\n");
	}

	async onOpen(): Promise<void> {
		this.closed = false;
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
		try {
			await this.reload();
		} catch (error) {
			this.renderUnavailable(error);
		}
	}

	private renderUnavailable(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this.contentEl.empty();
		const panel = this.contentEl.createDiv({ cls: "mica-version-unavailable" });
		panel.createEl("h3", { text: "Version history could not be loaded" });
		panel.createEl("p", {
			text: "Mica did not change or delete the ledger or its stored objects. Resolve the history error below, then retry.",
		});
		panel.createEl("code", { text: message });
		const actions = panel.createDiv({ cls: "mica-version-unavailable-actions" });
		const retry = actions.createEl("button", { cls: "mod-cta", text: "Retry", attr: { type: "button" } });
		actions
			.createEl("button", { text: "Close", attr: { type: "button" } })
			.addEventListener("click", () => this.close());
		retry.addEventListener("click", () => {
			retry.disabled = true;
			retry.setText("Retrying…");
			void this.reload(true).catch((nextError: unknown) => {
				this.renderUnavailable(nextError);
			});
		});
	}

	/** Move the selection up/down the timeline (working copy included). */
	private step(delta: number): void {
		const includesWorking = this.isDirty() || this.selected === WORKING;
		const offset = includesWorking ? 1 : 0;
		const at =
			this.selected === WORKING
				? 0
				: Math.max(0, (this.baseIndex.byId.get(this.selected)?.timelineIndex ?? -1) + offset);
		const nextIndex = Math.min(this.rows.length + offset - 1, Math.max(0, at + delta));
		const next = includesWorking && nextIndex === 0 ? WORKING : this.rows[nextIndex - offset]?.meta.versionId;
		if (next && next !== this.selected) {
			this.lineageGeneration++;
			this.selected = next;
			if (this.mode === "inspect") {
				this.inspectSelection = { mode: "one", keys: ["block:"], anchor: "block:" };
				this.inspectVersionKey = null;
				this.manualPick = null;
			}
			this.revealRowPage(next);
			this.renderPreservingListScroll();
		}
	}

	private async reload(fresh = false): Promise<void> {
		const state = (await (fresh ? this.plugin.engine.freshState(this.file) : this.plugin.engine.state(this.file)))[
			this.blockId
		];
		const visible = state?.versions ?? [];
		const removed = state?.removedVersions ?? [];
		this.rawHeadHash = state?.rawHead ?? state?.head ?? null;
		const all = [...visible, ...removed].sort(
			(left, right) => left.ts - right.ts || left.versionId.localeCompare(right.versionId),
		);
		const originalIndex = new Map(all.map((meta, index) => [meta.versionId, index]));
		this.rows = visible
			.map((meta, index) => ({
				meta,
				n: index + 1,
				head: state?.headVersionId === meta.versionId,
				originalIndex: originalIndex.get(meta.versionId) ?? index,
				timelineIndex: 0,
			}))
			.reverse();
		this.removedRows = removed
			.map((meta) => ({
				meta,
				n: 0,
				head: false,
				originalIndex: originalIndex.get(meta.versionId) ?? 0,
				timelineIndex: 0,
				removed: true,
			}))
			.reverse();
		for (const [index, row] of this.rows.entries()) row.timelineIndex = index;
		for (const [index, row] of this.removedRows.entries()) row.timelineIndex = index;
		this.baseIndex = buildVersionBaseIndex(this.rows);
		this.removedRowIds = new Set(this.removedRows.map((row) => row.meta.versionId));
		this.versionParents = buildVersionParentIndex(this.rows, WORKING, this.baseIndex.head);
		if (this.selected !== WORKING && !this.baseIndex.byId.has(this.selected)) {
			this.selected = this.rows[0]?.meta.versionId ?? WORKING;
		}
		if (this.baseMode !== "auto" && this.baseMode !== "head" && !this.baseIndex.byId.has(this.baseMode)) {
			this.baseMode = "auto";
		}
		// A checkpoint that left the timeline must leave the selection with it.
		// A dangling id has no hash, so it can never load: the surface would sit
		// in "Loading selected versions…" and re-render itself forever.
		for (const id of [...this.picked]) {
			if (!this.baseIndex.byId.has(id) && !this.removedRowIds.has(id)) this.picked.delete(id);
		}
		if (this.compareAnchor && !this.baseIndex.byId.has(this.compareAnchor)) this.compareAnchor = null;
		this.contents.clear();
		this.scopeIndexes.clear();
		this.scopeTransitions.clear();
		this.lineageGeneration++;
		this.lineageResults.clear();
		this.lineageLoading.clear();
		this.missing.clear();
		// The live block content = the "working copy" pseudo-version.
		const doc = this.workingCopyProvider?.readDocument() ?? (await this.plugin.app.vault.read(this.file));
		const matches = scanBlocksView(doc).filter((block) => block.id === this.blockId);
		this.blockConflict =
			matches.length === 1
				? null
				: matches.length === 0
					? "This block no longer exists in the note."
					: "This note contains duplicate block IDs. Run Mica: Repair history before using version actions.";
		this.working = matches.length === 1 ? doc.slice(matches[0].content_start, matches[0].content_end) : "";
		if (this.rawHeadHash) await this.loadContent(this.rawHeadHash);
		// First open: a dirty block compares its working copy against head; a
		// clean one shows the LAST CHANGE (head vs previous) — never an empty diff.
		if (!this.initialized) {
			this.initialized = true;
			if (!this.isDirty() && this.rows.length) this.selected = this.rows[0].meta.versionId;
		}
		this.revealRowPage(this.selected);
		this.render();
	}

	private async flushWorkingCopy(): Promise<boolean> {
		if (!this.workingCopyProvider) return true;
		const expected = this.workingCopyProvider.readDocument();
		if (expected === null || !(await this.workingCopyProvider.flush(expected))) {
			new Notice("Mica: the editor changed while saving. Review the latest text and try again.");
			return false;
		}
		return true;
	}

	private revealRowPage(key: string): void {
		if (key === WORKING) {
			if (this.rowPageStart >= this.rows.length) this.rowPageStart = 0;
			return;
		}
		const index = this.baseIndex.byId.get(key)?.timelineIndex ?? -1;
		if (index >= 0 && (index < this.rowPageStart || index >= this.rowPageStart + VERSION_ROW_PAGE_SIZE)) {
			this.rowPageStart = Math.floor(index / VERSION_ROW_PAGE_SIZE) * VERSION_ROW_PAGE_SIZE;
		}
	}

	private text(key: string): string {
		if (key === EMPTY) return "";
		if (key === WORKING) return this.working;
		const hash = this.hashForKey(key);
		if (!hash) return "";
		const value = this.contents.get(hash);
		if (value === undefined) return "";
		// LRU touch: selected/base versions stay hot without retaining history.
		this.contents.delete(hash);
		this.contents.set(hash, value);
		return value;
	}

	private hashForKey(key: string): string | null {
		return this.baseIndex.byId.get(key)?.meta.hash ?? null;
	}

	private loadKey(key: string): Promise<boolean> {
		if (key === EMPTY || key === WORKING) return Promise.resolve(true);
		const hash = this.hashForKey(key);
		return hash ? this.loadContent(hash) : Promise.resolve(false);
	}

	private hasLoadedKey(key: string): boolean {
		if (key === EMPTY || key === WORKING) return true;
		const hash = this.hashForKey(key);
		return Boolean(hash && this.contents.has(hash));
	}

	private isMissingKey(key: string): boolean {
		const hash = this.hashForKey(key);
		return Boolean(hash && this.missing.has(hash));
	}

	private loadContent(hash: string): Promise<boolean> {
		if (this.contents.has(hash)) return Promise.resolve(true);
		if (this.missing.has(hash)) return Promise.resolve(false);
		const pending = this.loading.get(hash);
		if (pending) return pending;
		const task = readObject(this.plugin.app.vault, this.file, hash)
			.then((content) => {
				if (this.closed) return false;
				if (content === null) {
					this.missing.add(hash);
					return false;
				}
				this.contents.set(hash, content);
				while (this.contents.size > CONTENT_CACHE_LIMIT) {
					const oldest = this.contents.keys().next().value;
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
		if (!this.rawHeadHash) return contentSignature(this.working) !== contentSignature("");
		if (this.missing.has(this.rawHeadHash) || !this.contents.has(this.rawHeadHash)) return true;
		return contentSignature(this.contents.get(this.rawHeadHash) ?? "") !== contentSignature(this.working);
	}

	/** The base content the selected version is compared against. */
	private baseKey(): string {
		return resolveVersionBase(this.rows, this.selected, this.baseMode, WORKING, EMPTY, this.baseIndex).key;
	}

	/** Display text for any version key, including both pseudo-versions. */
	private keyLabel(key: string): string {
		if (key === WORKING) return "working copy";
		if (key === EMPTY) return "before first version";
		const row = this.baseIndex.byId.get(key);
		return row ? `v${row.n}${row.meta.label ? ` — ${row.meta.label}` : ""}` : key.slice(0, 10);
	}

	/**
	 * `this.rows` is newest first, so a row's chronological rank is its distance
	 * from the end. The working copy outranks every checkpoint; anything absent
	 * from the timeline sorts oldest, which keeps the empty-tree sentinel left.
	 *
	 * Callers that already hold a row index pass it — resolving the rank by
	 * search would make building an N-target plan quadratic in the timeline.
	 */
	private target(key: string, rowIndex?: number): ComparisonTarget {
		const at = rowIndex ?? this.rows.findIndex((row) => row.meta.versionId === key);
		const order = key === WORKING ? this.rows.length + 1 : at < 0 ? -1 : this.rows.length - at;
		return { key, label: this.keyLabel(key), order };
	}

	/**
	 * The one answer to "what am I comparing". Rendering, captions, copying and
	 * control enablement all read this, so they cannot drift apart.
	 *
	 * Picks are walked from `this.rows`, which is the live timeline: a removed
	 * checkpoint stays selectable so bulk restore can reach it, but it has no
	 * comparable snapshot and is never a target.
	 */
	private plan(): ComparisonPlan {
		return planComparison({
			base: this.target(this.baseKey()),
			picks: this.rows.flatMap((row, index) =>
				this.picked.has(row.meta.versionId) ? [this.target(row.meta.versionId, index)] : [],
			),
			selected: this.target(this.selected),
			elements: this.focusedSelections.map((selection) => ({
				id: this.locatorId(selection.locator),
				name: scopeDisplayName(selection.locator),
			})),
			// Stacked patches have no column budget, so that layout is the one
			// that can show every picked version at once.
			columnCap: this.layout === "patch" ? Number.POSITIVE_INFINITY : MAX_COMPARISON_COLUMNS,
		});
	}

	/** Timeline rows to paint. Composition lives in `versionTimeline` so the
	 * chronological placement of removed checkpoints is checked exactly, rather
	 * than inferred from a rendered list. */
	private displayRows(): Row[] {
		return this.showRemoved ? mergeTimelineRows(this.rows, this.removedRows) : this.rows;
	}

	private autoBaseUnavailable(): boolean {
		return (
			this.baseMode === "auto" &&
			resolveVersionBase(this.rows, this.selected, this.baseMode, WORKING, EMPTY, this.baseIndex).autoReason ===
				"unavailable-parent"
		);
	}

	private baseDescription(): { resolved: string; suffix: string } {
		const resolution = resolveVersionBase(this.rows, this.selected, this.baseMode, WORKING, EMPTY, this.baseIndex);
		const key = resolution.key;
		const resolved = key === WORKING ? "working copy" : this.nameOf(key);
		if (this.baseMode === "head") return { resolved, suffix: " · head" };
		if (this.baseMode !== "auto") return { resolved, suffix: " · pinned" };
		if (resolution.autoReason === "unavailable-parent")
			return { resolved: "Lineage unavailable", suffix: " · auto: choose a base" };
		if (resolution.autoReason === "before-first") return { resolved, suffix: " · auto: before first version" };
		if (resolution.autoReason === "current-head") return { resolved, suffix: " · auto: current head" };
		return { resolved, suffix: " · auto: parent" };
	}

	private render(): void {
		const { contentEl } = this;
		this.disposeRenderChildren();
		this.surface = null;
		this.listEl = null;
		contentEl.empty();
		if (this.blockConflict) {
			contentEl.createEl("p", { cls: "mod-warning", text: this.blockConflict });
			return;
		}
		if (!this.rows.length && !this.working.trim()) {
			contentEl.createEl("p", {
				text: "No stored versions yet. Edit the block or save a version.",
			});
			return;
		}
		const root = contentEl.createDiv({ cls: "mica-versions-root" });
		this.listEl = root.createDiv({
			cls: "mica-versions-list",
			attr: { role: "list", "aria-label": "Block versions" },
		});
		const main = root.createDiv({ cls: "mica-versions-main" });
		const plan = this.plan();
		this.renderList();
		this.renderToolbar(main, plan);
		this.renderComparisonBar(main, plan);
		this.surface = main.createDiv({ cls: "mica-versions-surface" });
		this.renderDiffSurface();
	}

	private renderPreservingListScroll(): void {
		const scrollTop = this.listEl?.scrollTop ?? 0;
		this.render();
		if (this.listEl) this.listEl.scrollTop = scrollTop;
	}

	// --- timeline ----------------------------------------------------------

	private renderList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		const controls = list.createDiv({ cls: "mica-version-manage-controls" });
		if (this.removedRows.length) {
			const removed = controls.createEl("button", {
				text: `Removed · ${this.removedRows.length}`,
				cls: this.showRemoved ? "is-on" : "",
				attr: {
					type: "button",
					"aria-pressed": String(this.showRemoved),
					"data-mica-action": "toggle-removed",
				},
			});
			removed.addEventListener("click", () => {
				this.showRemoved = !this.showRemoved;
				this.rowPageStart = 0;
				this.renderList();
			});
		}
		controls.createSpan({
			cls: "mica-version-selection-count",
			text: this.picked.size ? `${this.picked.size} selected` : "Select checkpoints to compare",
			attr: { "aria-live": "polite" },
		});

		const baseKey = this.baseKey();
		if (this.isDirty() || this.selected === WORKING) {
			const row = list.createDiv({
				cls: `mica-vrow is-working ${this.selected === WORKING ? "is-selected" : ""}`,
				attr: {
					role: "listitem",
					tabindex: this.selected === WORKING ? "0" : "-1",
					"aria-current": this.selected === WORKING ? "true" : "false",
				},
			});
			// The working copy has no checkpoint identity, so it can hold a role
			// but never joins the picked set. Its empty lead cell keeps the
			// version labels below it aligned.
			row.createDiv({ cls: "mica-vrow-lead" });
			const title = row.createDiv({ cls: "mica-vrow-title" });
			title.createSpan({ text: "Working copy" });
			if (this.selected === WORKING)
				title.createSpan({ cls: "mica-vrow-rolebadge is-selected", text: "Selected" });
			if (baseKey === WORKING)
				title.createSpan({ cls: "mica-vrow-rolebadge mica-vrow-basebadge is-base", text: "Base" });
			row.createDiv({ cls: "mica-vrow-sub", text: this.isDirty() ? "unsaved changes" : "matches head" });
			const activateWorking = (): void => {
				this.selected = WORKING;
				if (this.mode === "inspect") {
					this.inspectSelection = { mode: "one", keys: ["block:"], anchor: "block:" };
					this.inspectVersionKey = null;
					this.manualPick = null;
				}
				this.renderPreservingListScroll();
			};
			row.addEventListener("click", activateWorking);
			row.addEventListener("keydown", (event) => {
				if (event.target !== row) return;
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				activateWorking();
			});
		}

		const sourceRows = this.displayRows();
		const page = versionPageBounds(sourceRows.length, this.rowPageStart);
		this.rowPageStart = page.start;
		const pageRows = sourceRows.slice(page.start, page.end);
		for (const [pageIndex, r] of pageRows.entries()) {
			const row = list.createDiv({
				cls: `mica-vrow ${this.selected === r.meta.versionId ? "is-selected" : ""} ${r.head ? "is-head" : ""} ${
					baseKey === r.meta.versionId ? "is-base" : ""
				} ${r.removed ? "is-removed" : ""}`,
				attr: {
					role: "listitem",
					tabindex: this.selected === r.meta.versionId ? "0" : "-1",
					"aria-current": this.selected === r.meta.versionId ? "true" : "false",
					// Stable across removal and restore; `v{n}` is not.
					"data-mica-version": r.meta.versionId,
				},
			});
			const lead = row.createDiv({ cls: "mica-vrow-lead" });
			const title = row.createDiv({ cls: "mica-vrow-title" });
			title.createSpan({ cls: "mica-vrow-n", text: r.removed ? "Removed" : `v${r.n}` });
			title.title = `Checkpoint ${r.meta.versionId} · ${r.meta.hash}`;
			if (r.meta.label) title.createSpan({ cls: "mica-vrow-label", text: r.meta.label });
			// Roles trail the label so nothing before them can move. A reserved
			// column would align them, but only one or two rows ever carry a role
			// and the timeline is the narrowest surface here.
			this.renderRowRoles(title, r, baseKey);
			const sub = row.createDiv({ cls: "mica-vrow-sub" });
			const time = sub.createEl("time", {
				text: versionTime(r.meta.ts, this.plugin.settings.showVersionExactTimestamps),
				attr: { datetime: new Date(r.meta.ts).toISOString(), title: exactTimeTitle(r.meta.ts) },
			});
			void time;
			const scopeStatus = this.scopeStatuses.get(r.meta.versionId);
			if (scopeStatus)
				sub.createSpan({
					cls: `mica-vrow-scope is-${scopeStatus.replace(" ", "-")}`,
					text: ` · ${scopeStatus}`,
				});
			const preview = this.contents.has(r.meta.hash) ? firstLine(this.text(r.meta.versionId)) : "";
			if (this.missing.has(r.meta.hash)) sub.createSpan({ cls: "mica-vrow-preview", text: " · object missing" });
			if (preview) sub.createSpan({ cls: "mica-vrow-preview", text: ` · ${preview}` });

			const activateVersion = async (): Promise<void> => {
				// A removed checkpoint has left the timeline: it stays selectable
				// for bulk restore, but there is no snapshot to compare against.
				if (r.removed) return;
				this.selected = r.meta.versionId;
				if (this.mode === "inspect") {
					this.inspectSelection = { mode: "one", keys: ["block:"], anchor: "block:" };
					this.inspectVersionKey = null;
					this.manualPick = null;
				}
				await this.loadContent(r.meta.hash);
				this.renderPreservingListScroll();
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
				if (r.removed) this.removedVersionMenu(e, r);
				else this.versionMenu(e, r);
			});
			const checkbox = lead.createEl("input", {
				cls: "mica-vrow-select",
				attr: { type: "checkbox", "aria-label": `Select checkpoint ${r.meta.versionId}` },
			});
			checkbox.checked = this.picked.has(r.meta.versionId);
			// Shift-range needs the raw event, and a change listener would fire
			// after the browser already flipped `checked` past the range logic.
			checkbox.addEventListener("click", (event) => {
				event.stopPropagation();
				event.preventDefault();
				this.togglePicked(r.meta.versionId, event);
			});
			const more = row.createEl("button", {
				cls: "clickable-icon mica-vrow-more",
				attr: { type: "button", "aria-label": "Version actions" },
			});
			setIcon(more, "ellipsis");
			more.addEventListener("click", (e) => {
				e.stopPropagation();
				if (r.removed) this.removedVersionMenu(e, r);
				else this.versionMenu(e, r);
			});
			if (!this.showRemoved) {
				const next = pageRows[pageIndex + 1];
				const hidden = next ? r.originalIndex - next.originalIndex - 1 : 0;
				if (hidden > 0) {
					// The chronological gap is where those checkpoints belong, so it
					// is also the natural place to reveal them.
					const gap = list.createEl("button", {
						cls: "mica-vrow-gap",
						text: `${hidden} removed checkpoint${hidden === 1 ? "" : "s"}`,
						attr: { type: "button", "data-mica-action": "reveal-removed" },
					});
					gap.addEventListener("click", () => {
						this.showRemoved = true;
						this.renderList();
					});
				}
			}
		}
		if (sourceRows.length > VERSION_ROW_PAGE_SIZE) {
			const pager = list.createDiv({ cls: "mica-vrow mica-vrow-pager" });
			pager.createSpan({
				text: `Versions ${page.start + 1}–${page.end} of ${sourceRows.length}`,
			});
			if (this.rowPageStart > 0) {
				const newer = pager.createEl("button", { text: "Newer", attr: { type: "button" } });
				newer.addEventListener("click", () => {
					this.rowPageStart = Math.max(0, this.rowPageStart - VERSION_ROW_PAGE_SIZE);
					this.renderList();
				});
			}
			if (page.end < sourceRows.length) {
				const older = pager.createEl("button", { text: "Older", attr: { type: "button" } });
				older.addEventListener("click", () => {
					this.rowPageStart += VERSION_ROW_PAGE_SIZE;
					this.renderList();
				});
			}
		}
		this.renderBulkActions(list);
	}

	/** Bulk actions appear only once something is selected, so the timeline has
	 * no permanently parked controls competing for touch space. */
	private renderBulkActions(list: HTMLElement): void {
		if (!this.picked.size) return;
		const { live, removed: gone } = partitionPicked(this.picked, (id) => this.removedRowIds.has(id));
		const bar = list.createDiv({ cls: "mica-version-bulk-actions" });
		const clear = bar.createEl("button", {
			text: "Clear",
			attr: { type: "button", "data-mica-action": "clear-selection" },
		});
		clear.addEventListener("click", () => {
			this.picked.clear();
			this.compareAnchor = null;
			this.render();
		});
		if (live.length) {
			const remove = bar.createEl("button", {
				text: `Remove ${live.length} from timeline`,
				attr: {
					type: "button",
					"aria-label": `Remove ${live.length} checkpoints from the timeline`,
					"data-mica-action": "remove-selected",
				},
			});
			remove.addEventListener("click", () => void this.applyVersionVisibility(live, false));
		}
		if (gone.length) {
			const restore = bar.createEl("button", {
				text: `Restore ${gone.length} to timeline`,
				attr: {
					type: "button",
					"aria-label": `Restore ${gone.length} checkpoints to the timeline`,
					"data-mica-action": "restore-selected",
				},
			});
			restore.addEventListener("click", () => void this.applyVersionVisibility(gone, true));
		}
	}

	/** Selected / Base / Head, trailing the version label. A row can hold several
	 * at once — the head can also be the base — so this is not a single badge.
	 * That a picked version is the base is stated once, in the comparison bar,
	 * rather than repeated on the row where space is scarcest. */
	private renderRowRoles(title: HTMLElement, r: Row, baseKey: string): void {
		if (this.selected === r.meta.versionId)
			title.createSpan({
				cls: "mica-vrow-rolebadge is-selected",
				text: "Selected",
				attr: { title: "Selected comparison version" },
			});
		if (baseKey === r.meta.versionId)
			title.createSpan({
				cls: "mica-vrow-rolebadge mica-vrow-basebadge is-base",
				text: "Base",
				attr: { title: "Comparison base" },
			});
		if (r.head) {
			const headIco = title.createSpan({ cls: "mica-vrow-head", attr: { "aria-label": "Current head" } });
			setIcon(headIco, "check");
		}
	}

	private togglePicked(versionId: string, event: MouseEvent): void {
		const result = nextPickedSelection({
			picked: this.picked,
			anchor: this.compareAnchor,
			versionId,
			shift: event.shiftKey,
			additive: event.ctrlKey || event.metaKey,
			positionOf: (id) => this.baseIndex.byId.get(id)?.timelineIndex ?? -1,
			idAt: (position) => this.rows[position]?.meta.versionId ?? null,
		});
		this.picked.clear();
		for (const id of result.picked) this.picked.add(id);
		this.compareAnchor = result.anchor;
		this.render();
	}

	private async applyVersionVisibility(ids: string[], restore: boolean): Promise<void> {
		if (!ids.length) return;
		try {
			const count = await this.plugin.engine.setVersionsVisible(this.file, this.blockId, ids, restore);
			new Notice(
				restore
					? `Mica: restored ${count} checkpoint${count === 1 ? "" : "s"} to the timeline.`
					: `Mica: removed ${count} checkpoint${count === 1 ? "" : "s"} from the timeline.`,
			);
			for (const id of ids) this.picked.delete(id);
			await this.reload();
		} catch (error) {
			new Notice(`Mica: timeline update failed — ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private removedVersionMenu(event: MouseEvent, row: Row): void {
		const menu = this.ownMenu(new Menu());
		menu.addItem((item) =>
			item
				.setTitle("Restore to timeline")
				.setIcon("archive-restore")
				.onClick(async () => {
					try {
						await this.plugin.engine.restoreRemovedVersions(this.file, this.blockId, [row.meta.versionId]);
						new Notice("Mica: checkpoint restored to the timeline.");
						await this.reload();
					} catch (error) {
						new Notice(
							`Mica: checkpoint restore failed — ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}),
		);
		menu.showAtMouseEvent(event);
	}

	private versionMenu(e: MouseEvent, r: Row): void {
		const menu = this.ownMenu(new Menu());
		menu.addItem((i) =>
			i
				.setTitle("Restore as new checkpoint")
				.setIcon("archive-restore")
				.onClick(async () => {
					try {
						if (!(await this.flushWorkingCopy())) return;
						const changed = await this.plugin.engine.restoreAsCheckpoint(this.file, this.blockId, {
							versionId: r.meta.versionId,
						});
						new Notice(
							changed
								? `Restored v${r.n} as a new checkpoint.`
								: "Mica: no restore checkpoint created — there were no changes.",
						);
						await this.reload();
					} catch (error) {
						new Notice(`Mica: restore failed — ${error instanceof Error ? error.message : String(error)}`);
					}
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Reset head here")
				.setIcon("git-branch")
				.onClick(async () => {
					try {
						if (!(await this.flushWorkingCopy())) return;
						const changed = await this.plugin.engine.resetHeadToVersion(this.file, this.blockId, {
							versionId: r.meta.versionId,
						});
						new Notice(
							changed
								? `HEAD reset to v${r.n}; future saves branch from this checkpoint.`
								: `Mica: HEAD already points to v${r.n}.`,
						);
						await this.reload();
					} catch (error) {
						new Notice(`Mica: reset failed — ${error instanceof Error ? error.message : String(error)}`);
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
						initial: this.text(r.meta.versionId),
						sourcePath: this.file.path,
						onSave: async (value) => {
							try {
								if (!(await this.flushWorkingCopy())) return false;
								await this.plugin.engine.editVersion(
									this.file,
									this.blockId,
									{ versionId: r.meta.versionId },
									value,
								);
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
				.onClick(() => {
					new VersionLabelModal({
						app: this.app,
						initial: r.meta.label ?? "",
						onSave: async (label) => {
							try {
								await this.plugin.engine.labelVersion(
									this.file,
									this.blockId,
									{ versionId: r.meta.versionId },
									label,
								);
								await this.reload();
								return true;
							} catch (error) {
								new Notice(
									`Mica: label failed — ${error instanceof Error ? error.message : String(error)}`,
								);
								return false;
							}
						},
					}).open();
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
					void navigator.clipboard.writeText(this.text(r.meta.versionId)).then(
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
					this.baseMode = r.meta.versionId;
					this.render();
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Remove from timeline")
				.setIcon("archive-x")
				.onClick(async () => {
					try {
						await this.plugin.engine.setVersionsVisible(this.file, this.blockId, [r.meta.versionId], false);
						new Notice("Mica: checkpoint removed from the timeline.");
						await this.reload();
					} catch (error) {
						new Notice(
							`Mica: checkpoint removal failed — ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}),
		);
		menu.showAtMouseEvent(e);
	}

	// --- diff surface ------------------------------------------------------

	private renderToolbar(main: HTMLElement, plan: ComparisonPlan): void {
		const bar = main.createDiv({ cls: "mica-versions-toolbar" });
		/** A labelled control cluster — the toolbar reads as sentences. */
		const group = (label: string): HTMLElement => {
			const g = bar.createDiv({ cls: "mica-vt-group" });
			g.createSpan({ cls: "mica-vt-label", text: label });
			return g.createDiv({ cls: "mica-vt-body" });
		};

		const seg = <T extends string>(
			host: HTMLElement,
			opts: [T, string, boolean?][],
			value: T,
			pick: (v: T) => void,
		): void => {
			const wrap = host.createDiv({ cls: "mica-seg" });
			for (const [v, label, disabled = false] of opts) {
				const b = wrap.createEl("button", {
					cls: `clickable-icon mica-pop-seg ${v === value ? "is-on" : ""}`,
					text: label,
					attr: {
						type: "button",
						disabled: disabled ? "" : null,
						title:
							disabled && v === "inspect"
								? "Element inspection uses one selected version and one comparison base."
								: null,
					},
				});
				b.addEventListener("click", () => {
					if (!disabled) pick(v);
				});
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

		// Always show Auto's resolved lineage target, not only the mode name.
		const { resolved, suffix } = this.baseDescription();
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
					.setTitle("Auto — follow the selected version’s lineage")
					.setChecked(this.baseMode === "auto")
					.onClick(() => this.setBase("auto")),
			);
			menu.addItem((i) =>
				i
					.setTitle("Head — the current version")
					.setChecked(this.baseMode === "head")
					.onClick(() => this.setBase("head")),
			);
			menu.addSeparator();
			if (this.selected !== WORKING) {
				const selected = this.baseIndex.byId.get(this.selected);
				if (selected) {
					menu.addItem((i) =>
						i
							.setTitle(
								`Selected — v${selected.n}${selected.meta.label ? ` — ${selected.meta.label}` : ""}`,
							)
							.setChecked(this.baseMode === selected.meta.versionId)
							.onClick(() => this.setBase(selected.meta.versionId)),
					);
				}
			}
			menu.addItem((i) =>
				i.setTitle("Find version by number, label, hash, or date…").onClick(() => void this.openBasePicker()),
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
			disabledReason?: string,
		): void => {
			const lab = host.createEl("label", {
				cls: `mica-diff-check ${on ? "is-on" : ""} ${disabledReason ? "is-disabled" : ""}`,
				attr: {
					"aria-label": disabledReason ? `${label} — ${disabledReason}` : tip,
					title: disabledReason ?? tip,
				},
			});
			const box = lab.createEl("input", { attr: { type: "checkbox" } });
			box.checked = on;
			box.disabled = Boolean(disabledReason);
			lab.createSpan({ text: label });
			box.addEventListener("change", () => flip(box.checked));
		};
		// A unified patch is line-based, so sub-line emphasis has nothing to
		// colour. Saying so beats rendering a control that quietly does nothing.
		const noRefine = this.layout === "patch" ? "Unified patches compare whole lines" : undefined;
		const hlHost = group("Highlight");
		check(
			hlHost,
			"Word",
			"Highlight changed words inside changed lines",
			this.refine === "word",
			(next) => {
				this.refine = next ? "word" : "none";
				this.remember({ diffRefine: this.refine });
				this.render();
			},
			noRefine,
		);
		check(
			hlHost,
			"Char",
			"Highlight changed characters inside changed lines",
			this.refine === "char",
			(next) => {
				this.refine = next ? "char" : "none";
				this.remember({ diffRefine: this.refine });
				this.render();
			},
			noRefine,
		);
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

		bar.createDiv({ cls: "mica-footer-spacer" });
		const cells = planCells(plan).length;
		const copyPatch = bar.createEl("button", {
			cls: "mica-base-pick",
			text: cells > 1 ? `Copy ${cells} comparisons` : "Copy patch",
			attr: {
				type: "button",
				// Naming the count is what makes the clipboard auditable against
				// the screen: both come from the same cell list.
				"aria-label": cells > 1 ? `Copy all ${cells} displayed comparisons` : "Copy the displayed patch",
			},
		});
		copyPatch.addEventListener("click", () => void this.copyPatch());
	}

	/**
	 * States the current comparison in words and offers a way out of each part
	 * of it. Previously "Comparing 3 · Done" and "Clear 3 selected" sat side by
	 * side doing different things while reading the same.
	 */
	private renderComparisonBar(main: HTMLElement, plan: ComparisonPlan): void {
		if (plan.kind !== "multi" && !plan.elements.length && !plan.droppedBase) return;
		const bar = main.createDiv({ cls: "mica-comparison-bar" });
		bar.createSpan({ cls: "mica-vt-label", text: "Comparing" });
		bar.createSpan({ cls: "mica-comparison-summary", text: describePlan(plan) });

		if (plan.elements.length) {
			const chip = bar.createEl("button", {
				cls: "mica-comparison-chip",
				text: `${plan.elements.length} element${plan.elements.length === 1 ? "" : "s"} ✕`,
				attr: { type: "button", "aria-label": "Stop comparing individual elements" },
			});
			chip.addEventListener("click", () => this.clearFocusedSelections());
		}
		if (plan.kind === "multi") {
			const chip = bar.createEl("button", {
				cls: "mica-comparison-chip",
				text: `${plan.targets.length} version${plan.targets.length === 1 ? "" : "s"} ✕`,
				attr: { type: "button", "aria-label": "Stop comparing several versions" },
			});
			chip.addEventListener("click", () => {
				this.picked.clear();
				this.compareAnchor = null;
				this.render();
			});
		}
		if (plan.droppedBase)
			bar.createSpan({
				cls: "mica-comparison-note",
				text: `${plan.droppedBase.label} is the base, so it is not also a column.`,
			});
		if (plan.overflow.length) {
			const note = bar.createSpan({ cls: "mica-comparison-note" });
			note.setText(
				`${plan.overflow.length} more selected (${plan.overflow
					.map((entry) => entry.label)
					.join(", ")}) — the grid shows ${MAX_COMPARISON_COLUMNS}. `,
			);
			const patch = note.createEl("button", {
				cls: "mica-comparison-chip",
				text: "Show all as patch",
				attr: { type: "button" },
			});
			patch.addEventListener("click", () => {
				this.layout = "patch";
				this.remember({ defaultDiffMode: "patch" });
				this.render();
			});
		}
	}

	private clearFocusedSelections(): void {
		this.focusedSelections = [];
		this.focusedLocator = null;
		this.focusedOriginVersion = null;
		this.focusedOriginKey = null;
		this.openFocusedRows.clear();
		this.manualScopes.clear();
		this.focusDispositions.clear();
		this.scopeStatuses.clear();
		this.lineageGeneration++;
		this.render();
	}

	private setBase(mode: VersionBaseMode): void {
		this.lineageGeneration++;
		this.baseMode = mode;
		this.manualPick = null;
		this.inspectVersionKey = null;
		this.revealRowPage(mode);
		this.render();
	}

	private async openBasePicker(): Promise<void> {
		// Labels and visibility can change while the history window remains
		// open. Refresh before freezing the picker's search index so a newly
		// labelled/returned checkpoint is searchable immediately.
		await this.reload(true);
		new VersionPickerModal({
			app: this.app,
			rows: this.rows,
			selectedKey: this.selected === WORKING ? undefined : this.selected,
			baseKey: this.baseKey() === EMPTY ? undefined : this.baseKey(),
			onChoose: async (row) => {
				if (!(await this.loadContent(row.meta.hash))) return false;
				this.setBase(row.meta.versionId);
				return true;
			},
		}).open();
	}

	private nameOf(hash: string): string {
		if (hash === EMPTY) return "before first version";
		const r = this.baseIndex.byId.get(hash);
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
			const oldest = this.scopeIndexes.keys().next().value;
			if (oldest === undefined) break;
			this.scopeIndexes.delete(oldest);
		}
		return index;
	}

	private scopeTransitionFor(base: string, selected: string): ScopeTransition {
		const key = `${base}\u0000${selected}`;
		const cached = this.scopeTransitions.get(key);
		if (cached) {
			this.scopeTransitions.delete(key);
			this.scopeTransitions.set(key, cached);
			return cached;
		}
		const transition = buildScopeTransition(this.scopeIndexFor(base), this.scopeIndexFor(selected));
		this.scopeTransitions.set(key, transition);
		while (this.scopeTransitions.size > CONTENT_CACHE_LIMIT) {
			const oldest = this.scopeTransitions.keys().next().value;
			if (oldest === undefined) break;
			this.scopeTransitions.delete(oldest);
		}
		return transition;
	}

	private comparisonRoute(base: string, selected: string): LineageStep[] | null {
		if (base === EMPTY || selected === EMPTY) return [];
		return versionLineageRouteFromParents(this.versionParents, base, selected);
	}

	private lineageResultKey(base: string, selected: string, selectedScope: VersionScope): string {
		return JSON.stringify([base, selected, selectedScope.key, this.locatorId()]);
	}

	private lineageCounterpart(base: string, selected: string, selectedScope: VersionScope): ScopeResolution | null {
		const route = this.comparisonRoute(base, selected);
		if (route === null)
			return {
				kind: "missing",
				disposition: "unmatched",
				details: ["The selected snapshots have incomplete, cyclic, disconnected, or over-limit lineage"],
			};
		if (!route.length) return null;
		const key = this.lineageResultKey(base, selected, selectedScope);
		const cached = this.lineageResults.get(key);
		if (cached) {
			this.lineageResults.delete(key);
			this.lineageResults.set(key, cached);
		}
		return (
			cached ?? {
				kind: "missing",
				disposition: "unmatched",
				details: ["Resolving lineage…"],
			}
		);
	}

	private ensureLineageCounterpart(base: string, selected: string, selectedScope: VersionScope): Promise<void> {
		const route = this.comparisonRoute(base, selected);
		if (route === null) {
			this.lineageResults.set(this.lineageResultKey(base, selected, selectedScope), {
				kind: "missing",
				disposition: "unmatched",
				details: ["The selected snapshots have incomplete, cyclic, disconnected, or over-limit lineage"],
			});
			return Promise.resolve();
		}
		if (!route.length) return Promise.resolve();
		const key = this.lineageResultKey(base, selected, selectedScope);
		if (this.lineageResults.has(key)) return Promise.resolve();
		const existing = this.lineageLoading.get(key);
		if (existing) return existing;
		const generation = this.lineageGeneration;
		const job = this.resolveLineage(route, selectedScope, generation)
			.then((resolution) => {
				if (generation === this.lineageGeneration) {
					this.lineageResults.set(key, resolution);
					while (this.lineageResults.size > CONTENT_CACHE_LIMIT) {
						const oldest = this.lineageResults.keys().next().value;
						if (oldest === undefined) break;
						this.lineageResults.delete(oldest);
					}
				}
			})
			.finally(() => this.lineageLoading.delete(key));
		this.lineageLoading.set(key, job);
		return job;
	}

	private async resolveLineage(
		route: readonly LineageStep[],
		selectedScope: VersionScope,
		generation: number,
	): Promise<ScopeResolution> {
		let scope = selectedScope;
		const details = new Set<string>();
		let status: "unchanged" | "changed" | "converted" = "unchanged";
		for (const step of [...route].reverse()) {
			if (generation !== this.lineageGeneration)
				return { kind: "missing", disposition: "unmatched", details: ["Lineage resolution was cancelled"] };
			const available = await Promise.all(
				[step.parent, step.child].filter((key) => key !== WORKING).map((key) => this.loadKey(key)),
			);
			if (available.some((loaded) => !loaded))
				return {
					kind: "missing",
					disposition: "unmatched",
					details: [
						`A lineage snapshot is unavailable at ${step.parent.slice(0, 10)} → ${step.child.slice(0, 10)}`,
					],
				};
			const transition = this.scopeTransitionFor(step.parent, step.child);
			const match =
				step.direction === "forward" ? transition.reverse.get(scope.key) : transition.forward.get(scope.key);
			if (!match) {
				if (route.length === 1 && step.direction === "forward") {
					const resolved = resolveSelectedTransition(transition, scope);
					if (resolved.kind !== "missing" || resolved.disposition !== "unmatched") return resolved;
				}
				if (route.length === 1) {
					const candidates =
						step.direction === "forward"
							? transition.ambiguousTo.get(scope.key)
							: transition.ambiguousFrom.get(scope.key);
					if (candidates?.length)
						return {
							kind: "ambiguous",
							candidates,
							truncated: candidates.length >= 64,
							details: ["plausible counterparts remain on the direct parent transition"],
						};
					const isolated =
						step.direction === "forward"
							? transition.added.has(scope.key)
							: transition.removed.has(scope.key);
					if (isolated)
						return {
							kind: "missing",
							disposition: "added",
							details: ["no plausible counterpart exists on the direct parent transition"],
						};
				}
				return {
					kind: "missing",
					disposition: "unmatched",
					details: [
						`Lineage needs matching at ${step.parent.slice(0, 10)} → ${step.child.slice(0, 10)}`,
						"automatic traversal stopped before making an unsafe guess",
					],
				};
			}
			scope = step.direction === "forward" ? match.from : match.to;
			for (const evidence of match.evidence) details.add(evidence);
			if (match.status === "converted") status = "converted";
			else if (match.status === "changed" && status === "unchanged") status = "changed";
		}
		return {
			kind: "exact",
			scope,
			evidence: "transition",
			details: [`lineage across ${route.length} transition${route.length === 1 ? "" : "s"}`, ...details],
			transitionStatus: status,
		};
	}

	private disposeInspector(): void {
		if (!this.inspectorChild) return;
		this.inspectorChild.unload();
		this.inspectorChild = null;
	}

	private disposeCandidatePreviews(): void {
		if (!this.candidatePreviewChild) return;
		this.candidatePreviewChild.unload();
		this.candidatePreviewChild = null;
	}

	private disposeRenderChildren(): void {
		this.disposeInspector();
		this.disposeCandidatePreviews();
	}

	private renderInspectSurface(surface: HTMLElement): void {
		const key = this.inspectVersionKey ?? this.selected;
		if (key !== WORKING && this.isMissingKey(key)) {
			surface.createDiv({ cls: "mica-diff-caption", text: "This version object is missing or unreadable." });
			return;
		}
		if (key !== WORKING && !this.hasLoadedKey(key)) {
			surface.createDiv({ cls: "mica-diff-caption", text: "Loading the selected version…" });
			void this.loadKey(key).then(() => {
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
		this.inspectSelection = reconcileScopeSelection(this.inspectSelection, index);
		const selectionBar = surface.createDiv({ cls: "mica-inspector-selection-bar" });
		// This control governs what a *plain* click does, nothing else. Labelling
		// it "One / Multiple" made it read as a count, so holding Ctrl — which
		// grows the selection without changing the mode — looked like it had
		// failed. The live count belongs to the footer, which reports it.
		selectionBar.createSpan({ cls: "mica-vt-label", text: "Plain click" });
		for (const mode of ["one", "multiple"] as const) {
			const button = selectionBar.createEl("button", {
				cls: `clickable-icon mica-pop-seg ${this.inspectSelection.mode === mode ? "is-on" : ""}`,
				text: mode === "one" ? "Replaces" : "Adds",
				attr: {
					type: "button",
					"aria-pressed": String(this.inspectSelection.mode === mode),
					"aria-label":
						mode === "one" ? "Plain click replaces the selection" : "Plain click adds to the selection",
				},
			});
			button.addEventListener("click", () => {
				this.inspectSelection = {
					mode,
					keys: mode === "one" ? [this.inspectSelection.keys[0] ?? "block:"] : this.inspectSelection.keys,
					anchor: this.inspectSelection.anchor ?? (mode === "one" ? "block:" : null),
				};
				this.renderDiffSurface();
			});
		}
		// Spell the modifiers out. Shift only spans siblings of one container, and
		// discovering that by tripping the refusal is a poor way to learn it.
		const reachable = rangeCandidates(this.inspectSelection, index);
		selectionBar.createSpan({
			cls: "mica-inspector-hint",
			text:
				(this.inspectSelection.mode === "one"
					? "Ctrl-click adds · Shift-click spans siblings"
					: "Tap adds or removes · Shift-click spans siblings") +
				" · Tab names switch tabs; Ctrl-click one to compare the tab itself",
		});
		surface.createDiv({
			cls: "mica-diff-caption",
			text: `Inspecting ${key === WORKING ? "working copy" : this.nameOf(key)} · ${
				reachable.size > 1
					? `Shift can span ${reachable.size} sibling elements from the last one you picked`
					: "choose one or more Mica elements"
			}`,
		});
		const viewport = surface.createDiv({ cls: "mica-inspector-viewport" });
		const render = viewport.createDiv({ cls: "mica-inspector-render" });
		const footer = surface.createDiv({ cls: "mica-inspector-footer" });
		const child = new Component();
		child.load();
		this.inspectorChild = child;

		const paintFooter = (): void => {
			footer.empty();
			const chips = footer.createDiv({
				cls: "mica-inspector-selection-chips",
				attr: { "aria-label": "Selected elements" },
			});
			for (const [position, selectedKey] of this.inspectSelection.keys.entries()) {
				const scope = index.byKey.get(selectedKey);
				if (!scope) continue;
				const button = chips.createEl("button", {
					cls: "mica-inspector-selection-chip",
					text: `${position + 1}. ${scopeDisplayName(scope)}`,
					attr: {
						type: "button",
						"aria-label": `Remove ${scopeDisplayName(scope)}`,
						title: `Row ${position + 1} of the comparison — click to remove`,
					},
				});
				button.addEventListener("click", () => {
					const keys = this.inspectSelection.keys.filter((candidate) => candidate !== selectedKey);
					this.inspectSelection = {
						...this.inspectSelection,
						keys: keys.length || this.inspectSelection.mode === "multiple" ? keys : ["block:"],
						anchor: keys.at(-1) ?? null,
					};
					this.renderDiffSurface();
				});
			}
			// The numbers are document order, not click order — they are the row
			// order of the comparison you are about to see, so they renumber when
			// an earlier element joins. Saying so stops that reading as random.
			footer.createSpan({
				cls: "mica-inspector-selection-count",
				text:
					this.inspectSelection.keys.length > 1
						? `${this.inspectSelection.keys.length} selected · numbered in document order`
						: `${this.inspectSelection.keys.length} selected`,
				attr: { "aria-live": "polite" },
			});
			if (this.inspectSelection.mode === "multiple" && this.inspectSelection.keys.length) {
				const clear = footer.createEl("button", { text: "Clear", attr: { type: "button" } });
				clear.addEventListener("click", () => {
					this.inspectSelection = { mode: "multiple", keys: [], anchor: null };
					this.renderDiffSurface();
				});
			}
			footer.createDiv({ cls: "mica-footer-spacer" });
			const compare = footer.createEl("button", {
				cls: "mod-cta",
				text:
					this.inspectSelection.keys.length === 1 ? "Compare selected element" : "Compare selected elements",
				attr: { type: "button" },
			});
			compare.disabled = this.inspectSelection.keys.length === 0;
			if (this.manualPick) compare.setText("Pair selected scope");
			compare.addEventListener("click", () => {
				if (this.manualPick) {
					const pick = this.manualPick;
					const selectedKey = this.inspectSelection.keys[0] ?? "block:";
					this.manualScopes.set(
						this.manualScopeKey(pick.base, pick.selected, pick.side, pick.key, pick.locatorId),
						selectedKey,
					);
					this.manualPick = null;
					this.inspectVersionKey = null;
				} else {
					this.lineageGeneration++;
					this.focusedSelections = this.inspectSelection.keys
						.map((selectedKey) => index.byKey.get(selectedKey))
						.filter((scope): scope is VersionScope => Boolean(scope))
						.map((scope) => ({
							locator: locatorFor(scope, index),
							originVersion: key,
							originKey: scope.key,
						}));
					const primary = this.focusedSelections[0];
					this.focusedLocator = primary?.locator ?? null;
					this.focusedOriginVersion = primary?.originVersion ?? null;
					this.focusedOriginKey = primary?.originKey ?? null;
					this.manualScopes.clear();
					this.focusDispositions.clear();
					this.scopeStatuses.clear();
					// A fresh element selection starts fresh: stale open rows would
					// otherwise decide which of the NEW elements is expanded.
					this.openFocusedRows.clear();
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
			inspection: {
				selectedKeys: this.inspectSelection.keys,
				onSelect: (scopeKey, modifiers) => {
					const result = selectScope(this.inspectSelection, index, scopeKey, modifiers);
					if (!result.ok) {
						new Notice(result.reason);
						return;
					}
					this.inspectSelection = result.state;
					this.renderDiffSurface();
				},
			},
		});
		paintFooter();
	}

	private locatorId(locator = this.focusedLocator): string {
		return locator ? JSON.stringify([locator.kind, locator.signature, locator.label, locator.ancestry]) : "";
	}

	private manualScopeKey(
		base: string,
		selected: string,
		side: "base" | "selected",
		key: string,
		locatorId = this.locatorId(),
	): string {
		return JSON.stringify([base, selected, side, key, locatorId]);
	}

	private resolveFocused(key: string, base: string, selected: string, side: "base" | "selected"): ScopeResolution {
		if (!this.focusedLocator) return { kind: "missing" };
		const manual = this.manualScopes.get(this.manualScopeKey(base, selected, side, key));
		if (manual) return resolveScope(this.scopeIndexFor(key), this.focusedLocator, manual);
		if (side === "selected") {
			if (key === this.focusedOriginVersion && this.focusedOriginKey) {
				const origin = this.scopeIndexFor(key).byKey.get(this.focusedOriginKey);
				if (origin) return { kind: "exact", scope: origin, evidence: "manual" };
			}
			return resolveScope(this.scopeIndexFor(key), this.focusedLocator);
		}

		const selectedManual = this.manualScopes.get(this.manualScopeKey(base, selected, "selected", selected));
		const selectedResolution = resolveScope(this.scopeIndexFor(selected), this.focusedLocator, selectedManual);
		if (selectedResolution.kind !== "exact") return resolveScope(this.scopeIndexFor(key), this.focusedLocator);
		const lineage = this.lineageCounterpart(base, selected, selectedResolution.scope);
		const route = this.comparisonRoute(base, selected);
		if (route === null || route.length) return lineage!;
		const transition = this.scopeTransitionFor(base, selected);
		return resolveSelectedTransition(transition, selectedResolution.scope);
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
		const activeLocatorId = this.locatorId();
		const mappingKey = this.manualScopeKey(base, selected, side, key);
		const label = side === "base" ? "comparison base" : "selected snapshot";
		surface.createDiv({
			cls: "mica-diff-caption",
			text:
				resolution.kind === "missing"
					? resolution.disposition === "added"
						? `This object is new in the selected snapshot; the ${label} has no plausible counterpart.`
						: `The focused object is missing from the ${label}. Choose how to compare it.`
					: `More than one object could be the focused object in the ${label}. Choose the counterpart explicitly.`,
		});
		if ("details" in resolution && resolution.details?.length)
			surface.createDiv({
				cls: "mica-scope-evidence",
				text: resolution.details.join(" · "),
			});
		const reference = surface.createDiv({ cls: "mica-scope-reference" });
		reference.createDiv({ cls: "mica-scope-candidate-title", text: "Selected element" });
		const referencePreview = reference.createDiv({ cls: "mica-scope-candidate-preview is-rendered" });
		const originScope =
			this.focusedOriginVersion && this.focusedOriginKey
				? this.scopeIndexFor(this.focusedOriginVersion).byKey.get(this.focusedOriginKey)
				: null;
		this.mountCandidatePreview(
			referencePreview,
			originScope && this.focusedOriginVersion
				? scopeSource(this.scopeIndexFor(this.focusedOriginVersion), originScope)
				: (this.focusedLocator?.fingerprintText ?? ""),
		);
		const picker = surface.createDiv({
			cls: "mica-scope-picker",
			attr: { role: "listbox", "aria-label": "Choose a counterpart" },
		});
		if (resolution.kind === "ambiguous") {
			for (const candidate of resolution.candidates) {
				const card = picker.createDiv({
					cls: "mica-scope-candidate",
					attr: { role: "option", tabindex: "0", "aria-selected": "false" },
				});
				card.createDiv({ cls: "mica-scope-candidate-title", text: scopeDisplayName(candidate) });
				const candidateSource = scopeSource(this.scopeIndexFor(key), candidate);
				const resemblance = contentResemblance(this.focusedLocator?.fingerprintText ?? "", candidateSource);
				const evidence = card.createDiv({ cls: "mica-scope-candidate-evidence" });
				evidence.createSpan({ text: candidate.kind === "code" ? "Code block" : candidate.kind });
				evidence.createSpan({ text: `${Math.round(resemblance.weighted * 100)}% content resemblance` });
				evidence.createSpan({ text: "Not chosen automatically: plausible counterparts remain" });
				const context = [candidate.previousKey, candidate.nextKey]
					.map((neighborKey) => (neighborKey ? this.scopeIndexFor(key).byKey.get(neighborKey) : null))
					.filter((neighbor): neighbor is VersionScope => Boolean(neighbor))
					.map((neighbor) => scopeDisplayName(neighbor).split(" › ").at(-1) || neighbor.kind);
				if (context.length) evidence.createSpan({ text: `Near ${context.join(" / ")}` });
				const preview = card.createDiv({
					cls: "mica-scope-candidate-preview is-rendered",
				});
				this.mountCandidatePreview(preview, candidateSource);
				const expand = card.createEl("button", {
					cls: "mica-scope-candidate-expand",
					text: "Expand preview",
					attr: { type: "button", "aria-expanded": "false" },
				});
				expand.addEventListener("click", (event) => {
					event.stopPropagation();
					const expanded = !preview.hasClass("is-expanded");
					preview.toggleClass("is-expanded", expanded);
					expand.setAttr("aria-expanded", String(expanded));
					expand.setText(expanded ? "Collapse preview" : "Expand preview");
				});
				const choose = (): void => {
					this.manualScopes.set(mappingKey, candidate.key);
					this.renderDiffSurface();
				};
				card.addEventListener("click", choose);
				card.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					choose();
				});
			}
			if (resolution.truncated)
				picker.createDiv({
					cls: "mica-diff-caption",
					text: "More matching scopes exist; inspect the snapshot to choose one that is not listed.",
				});
			picker.addEventListener("keydown", (event) => {
				if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) return;
				const cards = Array.from(picker.querySelectorAll<HTMLElement>(".mica-scope-candidate"));
				const current = cards.indexOf(document.activeElement as HTMLElement);
				const delta =
					event.key === "PageDown" ? 5 : event.key === "PageUp" ? -5 : event.key === "ArrowDown" ? 1 : -1;
				const next =
					event.key === "Home"
						? cards[0]
						: event.key === "End"
							? cards.at(-1)
							: cards[Math.max(0, Math.min(cards.length - 1, Math.max(0, current) + delta))];
				if (!next) return;
				event.preventDefault();
				next.focus();
			});
		}
		const actions = surface.createDiv({ cls: "mica-scope-picker-actions" });
		if (side === "base") {
			const chooseBase = actions.createEl("button", { text: "Choose another base…", attr: { type: "button" } });
			chooseBase.addEventListener("click", () => void this.openBasePicker());
		}
		const inspect = actions.createEl("button", { text: "Inspect snapshot to choose…", attr: { type: "button" } });
		inspect.addEventListener("click", () => {
			this.manualPick = { side, key, base, selected, locatorId: activeLocatorId };
			this.inspectVersionKey = key;
			this.inspectSelection = { mode: "one", keys: ["block:"], anchor: "block:" };
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
		const cancel = actions.createEl("button", {
			text: this.focusedSelections.length > 1 ? "Drop this element" : "Exit element comparison",
			attr: { type: "button" },
		});
		cancel.addEventListener("click", () => {
			this.focusedSelections = this.focusedSelections.filter(
				(selection) => this.locatorId(selection.locator) !== activeLocatorId,
			);
			this.openFocusedRows.delete(activeLocatorId);
			const next = this.focusedSelections[0];
			this.focusedLocator = next?.locator ?? null;
			this.focusedOriginVersion = next?.originVersion ?? null;
			this.focusedOriginKey = next?.originKey ?? null;
			this.scopeStatuses.clear();
			this.render();
		});
	}

	private mountCandidatePreview(host: HTMLElement, source: string): void {
		const mount = (): void => {
			if (host.dataset.micaMounted || !host.isConnected) return;
			host.dataset.micaMounted = "true";
			try {
				const child = this.candidatePreviewChild ?? new Component();
				if (!this.candidatePreviewChild) {
					child.load();
					this.candidatePreviewChild = child;
				}
				renderCst(parseBlock(source), host, {
					app: this.app,
					sourcePath: this.file.path,
					component: child,
					headerMode: "never",
					inspection: { selectedKeys: [], onSelect: () => undefined },
				});
			} catch {
				host.createEl("pre", { text: source || "Empty element" });
			}
		};
		if (typeof IntersectionObserver === "undefined") {
			mount();
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			mount();
		});
		observer.observe(host);
		const child = this.candidatePreviewChild ?? new Component();
		if (!this.candidatePreviewChild) {
			child.load();
			this.candidatePreviewChild = child;
		}
		child.register(() => observer.disconnect());
	}

	/** Resolve the focused element between `baseKey` and one target. Taking the
	 * target as an argument rather than reading `this.selected` is what lets the
	 * same element be compared across several versions at once. */
	private focusedPair(surface: HTMLElement, baseKey: string, targetKey: string): FocusedPair | null {
		if (!this.focusedLocator) return null;
		if (
			this.text(baseKey).length > MAX_SCOPE_INDEX_CODE_UNITS ||
			this.text(targetKey).length > MAX_SCOPE_INDEX_CODE_UNITS
		) {
			surface.createDiv({
				cls: "mica-diff-caption",
				text: `Focused comparison exceeds the ${Math.floor(MAX_SCOPE_INDEX_CODE_UNITS / 1024)} KiB interactive inspector limit. Exit element comparison to use the whole-block view.`,
			});
			return null;
		}
		const name = scopeDisplayName(this.focusedLocator);
		const baseResolution = this.resolveFocused(baseKey, baseKey, targetKey, "base");
		const selectedResolution = this.resolveFocused(targetKey, baseKey, targetKey, "selected");
		const disposition = this.focusDispositions.get(`${baseKey}→${targetKey}|${this.locatorId()}`);
		if (
			(disposition === "added" ||
				(baseResolution.kind === "missing" && baseResolution.disposition === "added")) &&
			baseResolution.kind === "missing" &&
			selectedResolution.kind === "exact"
		) {
			this.updateScopeStatus();
			return {
				base: "",
				selected: scopeSource(this.scopeIndexFor(targetKey), selectedResolution.scope),
				caption: `${name} · added`,
				status: "added",
			};
		}
		if (disposition === "removed" && baseResolution.kind === "exact" && selectedResolution.kind === "missing") {
			this.updateScopeStatus();
			return {
				base: scopeSource(this.scopeIndexFor(baseKey), baseResolution.scope),
				selected: "",
				caption: `${name} · removed`,
				status: "removed",
			};
		}
		if (selectedResolution.kind !== "exact") {
			this.renderResolutionPicker(
				surface,
				"selected",
				targetKey,
				selectedResolution,
				baseKey,
				targetKey,
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
				targetKey,
				baseResolution.kind === "missing" && selectedResolution.kind === "exact" ? "added" : null,
			);
			this.updateScopeStatus();
			return null;
		}
		this.updateScopeStatus();
		const evidence =
			baseResolution.evidence === "transition" && baseResolution.details?.length
				? ` · ${
						baseResolution.transitionStatus === "converted"
							? `converted ${baseResolution.scope.kind} → ${selectedResolution.scope.kind}`
							: (baseResolution.transitionStatus ?? "changed")
					} by ${baseResolution.details.join(", ")}`
				: "";
		const status = evidence.replace(/^ · /, "") || `matched by ${baseResolution.evidence}`;
		return {
			base: (baseResolution.composite ?? [baseResolution.scope])
				.map((scope) => scopeSource(this.scopeIndexFor(baseKey), scope))
				.join(""),
			selected: scopeSource(this.scopeIndexFor(targetKey), selectedResolution.scope),
			caption: `${scopeDisplayName(selectedResolution.scope)}${evidence}`,
			status,
		};
	}

	private updateScopeStatus(): void {
		// A single timeline badge cannot truthfully summarize several independently
		// resolved scopes. Multi-scope outcomes remain visible on their comparison rows.
		if (!this.focusedLocator || this.focusedSelections.length > 1 || this.selected === WORKING) return;
		const current = this.baseIndex.byId.get(this.selected);
		if (!current) return;
		const parentKey = current.meta.effectiveParentVersionId ?? EMPTY;
		if (parentKey !== EMPTY && !this.hasLoadedKey(parentKey) && !this.isMissingKey(parentKey)) {
			void this.loadKey(parentKey).then(() => this.updateScopeStatus());
			return;
		}
		if (parentKey !== EMPTY) {
			const selectedResolution = resolveScope(this.scopeIndexFor(this.selected), this.focusedLocator);
			if (selectedResolution.kind === "exact") {
				const key = this.lineageResultKey(parentKey, this.selected, selectedResolution.scope);
				if (!this.lineageResults.has(key)) {
					void this.ensureLineageCounterpart(parentKey, this.selected, selectedResolution.scope).then(() =>
						this.updateScopeStatus(),
					);
					return;
				}
			}
		}
		const currentResolution = this.resolveFocused(this.selected, parentKey, this.selected, "selected");
		const previousResolution =
			parentKey === EMPTY
				? ({ kind: "missing", disposition: "added" } as const)
				: this.resolveFocused(parentKey, parentKey, this.selected, "base");
		const disposition = this.focusDispositions.get(`${parentKey}→${this.selected}|${this.locatorId()}`);
		let status:
			"changed" | "unchanged" | "converted" | "combined" | "split" | "added" | "removed" | "needs matching";
		if (disposition === "added") status = "added";
		else if (disposition === "removed") status = "removed";
		else if (currentResolution.kind === "ambiguous" || previousResolution.kind === "ambiguous")
			status = "needs matching";
		else if (currentResolution.kind === "missing")
			status = previousResolution.kind === "exact" ? "removed" : "needs matching";
		else if (previousResolution.kind === "missing")
			status = previousResolution.disposition === "added" ? "added" : "needs matching";
		else if (
			previousResolution.transitionStatus === "converted" ||
			previousResolution.transitionStatus === "combined" ||
			previousResolution.transitionStatus === "split"
		)
			status = previousResolution.transitionStatus;
		else {
			status =
				scopeFingerprint(this.scopeIndexFor(this.selected), currentResolution.scope) ===
				scopeFingerprint(this.scopeIndexFor(parentKey), previousResolution.scope)
					? "unchanged"
					: "changed";
		}
		if (this.scopeStatuses.get(this.selected) !== status) {
			this.scopeStatuses.set(this.selected, status);
			queueMicrotask(() => this.renderList());
		}
	}

	private activateFocusedSelection(selection: FocusedSelection): void {
		this.focusedLocator = selection.locator;
		this.focusedOriginVersion = selection.originVersion;
		this.focusedOriginKey = selection.originKey;
	}

	/** One expandable row per focused element. Diffs stay lazy — only an open row
	 * computes one — but every row's name and status are resolved up front, so a
	 * row is never a blank pill you have to open to identify. */
	private renderFocusedRows(surface: HTMLElement, plan: ComparisonPlan): boolean {
		if (!plan.elements.length || !this.focusedSelections.length) return false;
		const primary = this.focusedSelections[0];
		const baseKey = plan.base.key;
		const generation = this.surfaceGeneration;
		const header = surface.createDiv({ cls: "mica-focused-header" });
		header.createSpan({ cls: "mica-diff-caption", text: describePlan(plan) });
		const exit = header.createEl("button", {
			cls: "mica-focused-exit",
			text: "Exit element comparison",
			attr: { type: "button" },
		});
		exit.addEventListener("click", () => this.clearFocusedSelections());

		const rows = surface.createDiv({ cls: "mica-focused-rows" });
		for (const [position, selection] of this.focusedSelections.entries()) {
			const rowId = this.locatorId(selection.locator);
			const details = rows.createEl("details", { cls: "mica-focused-row" });
			const summary = details.createEl("summary", { cls: "mica-focused-row-summary" });
			const line = summary.createSpan({ cls: "mica-focused-row-line" });
			line.createSpan({
				cls: "mica-focused-row-name",
				text: `${position + 1}. ${scopeDisplayName(selection.locator)}`,
			});
			const status = line.createSpan({ cls: "mica-focused-row-status" });
			const body = details.createDiv({ cls: "mica-focused-row-body" });

			this.activateFocusedSelection(selection);
			const pending = this.awaitLineage(plan, selection, generation, surface);
			// Resolving is cheap (index lookups); diffing is not. Every row is
			// named and statused now; only an open row pays for its diffs.
			const paint = (): void => {
				if (body.dataset.micaPainted) return;
				body.dataset.micaPainted = "true";
				this.activateFocusedSelection(selection);
				const captions: string[] = [];
				for (const target of plan.targets) {
					const cell = plan.targets.length > 1 ? body.createDiv({ cls: "mica-focused-cell" }) : body;
					if (plan.targets.length > 1)
						// Its own class: a cell's pair title and the resolution
						// messaging that may follow it are different things.
						cell.createDiv({
							cls: "mica-diff-caption mica-focused-cell-title",
							text: `${plan.base.label} → ${target.label}`,
						});
					const pair = this.focusedPair(cell, baseKey, target.key);
					if (!pair) continue;
					captions.push(pair.status);
					this.renderPairInto(cell.createDiv(), pair.base, pair.selected);
				}
				if (captions[0]) status.setText(captions[0]);
				if (primary) this.activateFocusedSelection(primary);
			};
			if (pending) status.setText(pending);
			else {
				const preview = this.focusedPair(
					createDiv(),
					baseKey,
					plan.targets[0]?.key ?? baseKey,
				);
				status.setText(preview ? preview.status : "needs matching");
			}

			// Opening a row paints THAT row. Rebuilding the surface here would
			// re-create every <details>, and assigning `open` queues another
			// toggle — the loop that made rows flash open and snap shut.
			details.addEventListener("toggle", () => {
				if (!details.open) {
					this.openFocusedRows.delete(rowId);
					return;
				}
				this.openFocusedRows.add(rowId);
				if (!pending) paint();
			});
			if (!this.openFocusedRows.size && position === 0) this.openFocusedRows.add(rowId);
			if (this.openFocusedRows.has(rowId)) {
				details.open = true;
				if (!pending) paint();
			}
		}
		if (primary) this.activateFocusedSelection(primary);
		return true;
	}

	/** Kick off lineage resolution for one focused element, returning the status
	 * text while it is outstanding. A resolve that lands after the surface moved
	 * on is discarded rather than repainting a view the user has left. */
	private awaitLineage(
		plan: ComparisonPlan,
		selection: FocusedSelection,
		generation: number,
		surface: HTMLElement,
	): string | null {
		for (const target of plan.targets) {
			const resolution = resolveScope(this.scopeIndexFor(target.key), selection.locator);
			if (resolution.kind !== "exact") continue;
			const route = this.comparisonRoute(plan.base.key, target.key);
			if (!route || !route.length) continue;
			if (this.lineageResults.has(this.lineageResultKey(plan.base.key, target.key, resolution.scope))) continue;
			void this.ensureLineageCounterpart(plan.base.key, target.key, resolution.scope).then(() => {
				if (this.surface === surface && this.surfaceGeneration === generation) this.renderDiffSurface();
			});
			return `following ${route.length} lineage transition${route.length === 1 ? "" : "s"}…`;
		}
		return null;
	}

	/** The one place a base/target text pair becomes a rendered diff, so every
	 * surface honours Layout and the refine setting identically. */
	private renderPairInto(host: HTMLElement, baseText: string, targetText: string): void {
		const issue = interactiveDiffIssue(baseText, targetText, this.layout === "patch" ? "line" : this.gran());
		if (issue) {
			host.createDiv({ cls: "mica-diff-caption", text: `Interactive diff unavailable: ${issue}.` });
			return;
		}
		const base = this.prep(baseText);
		const target = this.prep(targetText);
		if (this.layout === "patch") {
			renderPatch(host, makePatch(base, target, 3));
			return;
		}
		const result = diffText(base, target, this.gran(), 3);
		if (this.refine === "none")
			for (const hunk of result.hunks) for (const change of hunk.changes) change.inline = [];
		renderDiff(host, result, this.layout);
	}

	private renderDiffSurface(): void {
		const surface = this.surface;
		if (!surface) return;
		this.surfaceGeneration++;
		this.disposeRenderChildren();
		surface.empty();
		if (this.mode === "inspect") {
			this.renderInspectSurface(surface);
			return;
		}
		if (this.autoBaseUnavailable()) {
			surface.createDiv({
				cls: "mica-diff-caption",
				text: "This legacy version does not record its parent. Auto will not guess or compare it with an empty baseline.",
			});
			const recovery = surface.createDiv({ cls: "mica-scope-picker-actions" });
			const choose = recovery.createEl("button", {
				text: "Choose comparison version…",
				attr: { type: "button" },
			});
			choose.addEventListener("click", () => void this.openBasePicker());
			const head = recovery.createEl("button", { text: "Compare with head", attr: { type: "button" } });
			head.addEventListener("click", () => this.setBase("head"));
			surface.createDiv({
				cls: "mica-legacy-base-help",
				text: "Select one explicit comparison base. Mica will not infer lineage from timeline position alone.",
			});
			return;
		}
		const plan = this.plan();
		const needed = planKeys(plan).filter((key) => key !== WORKING && key !== EMPTY);
		const missing = needed.filter((key) => this.isMissingKey(key));
		if (missing.length) {
			surface.createDiv({
				cls: "mica-diff-caption",
				text: `Version object missing or unreadable: ${missing.map((hash) => hash.slice(0, 12)).join(", ")}`,
			});
			return;
		}
		const unloaded = needed.filter((key) => !this.hasLoadedKey(key));
		if (unloaded.length) {
			surface.createDiv({ cls: "mica-diff-caption", text: "Loading selected versions…" });
			const generation = this.surfaceGeneration;
			void Promise.all(unloaded.map((key) => this.loadKey(key))).then((loaded) => {
				if (this.surface !== surface || this.surfaceGeneration !== generation) return;
				// A key that resolves false has no readable object; repainting on
				// it would land right back here and spin.
				if (!loaded.every(Boolean)) {
					for (const key of unloaded) if (!this.hasLoadedKey(key)) this.picked.delete(key);
				}
				this.renderList();
				this.renderDiffSurface();
			});
			return;
		}
		if (this.renderFocusedRows(surface, plan)) return;

		const body = surface.createDiv();
		const baseText = this.text(plan.base.key);
		if (plan.kind === "multi") {
			this.renderMultiVersion(surface, body, plan, baseText);
			return;
		}
		const targetKey = plan.targets[0]?.key ?? plan.base.key;
		const caption = surface.createDiv({ cls: "mica-diff-caption" });
		surface.insertBefore(caption, body);
		let baseRaw = baseText;
		let targetRaw = this.text(targetKey);
		let focusedCaption = "";
		if (this.focusedLocator) {
			const pending = this.awaitLineage(plan, this.focusedSelections[0], this.surfaceGeneration, surface);
			if (pending) {
				caption.setText(pending);
				return;
			}
			const focused = this.focusedPair(surface, plan.base.key, targetKey);
			if (!focused) {
				caption.detach();
				body.detach();
				return;
			}
			baseRaw = focused.base;
			targetRaw = focused.selected;
			focusedCaption = `${focused.caption} · `;
		}
		const names = `${focusedCaption}${plan.base.label} → ${this.keyLabel(targetKey)}`;
		const issue = interactiveDiffIssue(baseRaw, targetRaw, this.layout === "patch" ? "line" : this.gran());
		if (issue) {
			caption.setText(`Interactive diff unavailable: ${issue}. Use the mica CLI for this comparison.`);
			return;
		}
		if (this.layout === "patch") {
			caption.setText(names);
			this.renderPairInto(body, baseRaw, targetRaw);
			return;
		}
		const result = diffText(this.prep(baseRaw), this.prep(targetRaw), this.gran(), 3);
		if (this.refine === "none") for (const h of result.hunks) for (const c of h.changes) c.inline = [];
		caption.setText(`${names} · ${Math.round(result.similarity * 100)}% similar`);
		renderDiff(body, result, this.layout);
	}

	/** Every picked version against the same base. The base is never one of the
	 * columns — `planComparison` already moved it to `droppedBase`, which the
	 * comparison bar reports. */
	private renderMultiVersion(surface: HTMLElement, body: HTMLElement, plan: ComparisonPlan, baseText: string): void {
		const caption = surface.createDiv({ cls: "mica-diff-caption" });
		surface.insertBefore(caption, body);
		caption.setText(`${plan.base.label} → ${plan.targets.length} version${plan.targets.length === 1 ? "" : "s"}`);
		const gran = this.layout === "patch" ? "line" : this.gran();
		for (const target of plan.targets) {
			const issue = interactiveDiffIssue(baseText, this.text(target.key), gran);
			if (issue) {
				caption.setText(`Interactive diff unavailable: ${issue}. Use the mica CLI for this comparison.`);
				return;
			}
		}
		const base = this.prep(baseText);
		if (this.layout === "patch") {
			renderNUpPatch(
				body,
				plan.base.label,
				plan.targets.map((target) => ({
					label: target.label,
					patch: makePatch(base, this.prep(this.text(target.key)), 3),
				})),
			);
			return;
		}
		renderNUp(
			body,
			{ label: plan.base.label, text: base },
			plan.targets.map((target) => {
				const result = diffText(base, this.prep(this.text(target.key)), gran, 3);
				if (this.refine === "none") for (const h of result.hunks) for (const c of h.changes) c.inline = [];
				return { label: target.label, result };
			}),
			this.layout,
		);
	}

	/**
	 * Copy walks exactly the cells the surface paints. Previously it re-derived
	 * the comparison and had no multi-version branch at all, so in that mode the
	 * clipboard silently held a different comparison than the screen.
	 */
	private async copyPatch(): Promise<void> {
		if (this.autoBaseUnavailable()) {
			new Notice("Choose a comparison base before copying a patch for this legacy version.");
			return;
		}
		const plan = this.plan();
		const keys = planKeys(plan).filter((key) => key !== WORKING && key !== EMPTY);
		if (!(await Promise.all(keys.map((key) => this.loadKey(key)))).every(Boolean)) {
			new Notice("Mica: a selected version object is missing or unreadable.");
			this.render();
			return;
		}
		const primary = this.focusedSelections[0];
		const sections: { heading: string; patch: string }[] = [];
		try {
			for (const cell of planCells(plan)) {
				const heading = `${cell.element ? `${cell.element.name} · ` : ""}${plan.base.label} → ${cell.target.label}`;
				let baseRaw = this.text(plan.base.key);
				let targetRaw = this.text(cell.target.key);
				if (cell.element) {
					const selection = this.focusedSelections[cell.elementIndex];
					if (!selection) continue;
					this.activateFocusedSelection(selection);
					const resolution = resolveScope(this.scopeIndexFor(cell.target.key), selection.locator);
					if (resolution.kind === "exact")
						await this.ensureLineageCounterpart(plan.base.key, cell.target.key, resolution.scope);
					const pair = this.focusedPair(createDiv(), plan.base.key, cell.target.key);
					if (!pair) {
						new Notice("Choose every selected element’s counterpart before copying comparisons.");
						return;
					}
					baseRaw = pair.base;
					targetRaw = pair.selected;
				}
				const issue = interactiveDiffIssue(baseRaw, targetRaw, "line");
				if (issue) {
					new Notice(`Mica: ${issue}. Use the mica CLI for this comparison.`);
					return;
				}
				sections.push({ heading, patch: makePatch(this.prep(baseRaw), this.prep(targetRaw), 3) });
			}
		} finally {
			if (primary) this.activateFocusedSelection(primary);
		}
		if (!sections.length || sections.every((section) => !section.patch.trim())) {
			new Notice("No differences to copy.");
			return;
		}
		// A lone whole-block patch stays a bare patch, so the common case remains
		// pasteable into `git apply`; anything multi-part needs its headings.
		const text =
			sections.length === 1 && !plan.elements.length
				? sections[0].patch
				: sections
						.map((section) => `## ${section.heading}\n\n\`\`\`diff\n${section.patch.trimEnd()}\n\`\`\``)
						.join("\n\n");
		try {
			await navigator.clipboard.writeText(text);
			new Notice(sections.length > 1 ? `${sections.length} comparisons copied.` : "Patch copied.");
		} catch {
			new Notice("Couldn't access the clipboard.");
		}
	}

	onClose(): void {
		this.closed = true;
		for (const menu of this.openMenus) menu.hide();
		this.openMenus.clear();
		this.disposeRenderChildren();
		this.removeSettingsListener?.();
		this.removeSettingsListener = null;
		this.surface = null;
		this.listEl = null;
		this.contents.clear();
		this.scopeIndexes.clear();
		this.scopeTransitions.clear();
		this.lineageGeneration++;
		this.lineageResults.clear();
		this.lineageLoading.clear();
		this.manualScopes.clear();
		this.focusDispositions.clear();
		this.scopeStatuses.clear();
		this.openFocusedRows.clear();
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
