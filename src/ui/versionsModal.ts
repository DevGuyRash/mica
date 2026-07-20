import { Menu, Modal, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { contentSignature, diffText, makePatch, scanBlocksView, type VersionMeta } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import { interactiveDiffIssue } from "../diff/budget";
import { renderDiff, renderNUp, renderPatch } from "../diff/diffView";
import { EditorLightbox } from "./lightbox";
import { matchingVersions, VERSION_ROW_PAGE_SIZE, versionPageBounds } from "./versionWindow";

interface Row {
	meta: VersionMeta;
	/** 1-based add-order number (v1 = oldest) — matches the mica CLI. */
	n: number;
	head: boolean;
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
		this.listEl = root.createDiv({ cls: "mica-versions-list" });
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
			});
			row.createDiv({ cls: "mica-vrow-title", text: "Working copy" });
			row.createDiv({ cls: "mica-vrow-sub", text: this.isDirty() ? "unsaved changes" : "matches head" });
			row.addEventListener("click", () => {
				this.selected = WORKING;
				this.renderList();
				this.renderDiffSurface();
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
			sub.createSpan({ text: relTime(r.meta.ts) });
			const preview = this.contents.has(r.meta.hash) ? firstLine(this.text(r.meta.hash)) : "";
			if (this.missing.has(r.meta.hash)) sub.createSpan({ cls: "mica-vrow-preview", text: " · object missing" });
			if (preview) sub.createSpan({ cls: "mica-vrow-preview", text: ` · ${preview}` });

			row.addEventListener("click", async () => {
				this.selected = r.meta.hash;
				await this.loadContent(r.meta.hash);
				this.renderList();
				this.renderDiffSurface();
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
		const menu = new Menu();
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
			const menu = new Menu();
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

	private renderDiffSurface(): void {
		const surface = this.surface;
		if (!surface) return;
		surface.empty();
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
		const baseRaw = this.text(bk);
		const selectedRaw = this.text(this.selected);
		const caption = surface.createDiv({ cls: "mica-diff-caption" });
		const names = `${bk === WORKING ? "working copy" : this.nameOf(bk)} → ${
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
		const baseRaw = this.text(this.baseKey());
		const selectedRaw = this.text(this.selected);
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
		this.surface = null;
		this.listEl = null;
		this.contents.clear();
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
	if (secs < 7 * 86400) return `${Math.floor(secs / 86400)}d ago`;
	return new Date(ts).toLocaleDateString();
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
