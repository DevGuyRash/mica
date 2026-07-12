import { Menu, Modal, Notice, setIcon, TFile } from "obsidian";
import type MicaPlugin from "../main";
import {
	contentSignature,
	diffText,
	makePatch,
	newId,
	scanBlocksView,
	type DiffGranularity,
	type VersionMeta,
} from "../wasm/bridge";
import { appendEvents, readObject } from "../storage/sidecar";
import { renderDiff, renderPatch } from "../diff/diffView";
import { EditorLightbox } from "./lightbox";

interface Row {
	meta: VersionMeta;
	/** 1-based add-order number (v1 = oldest) — matches the mica CLI. */
	n: number;
	head: boolean;
}

const WORKING = "__working__";

/**
 * The version history browser: a timeline (labels, relative times, origin,
 * head marker, the dirty working copy) beside a live diff surface. Every
 * version has one-click Restore / Branch-edit / Label / Copy actions —
 * versions finally have names and faces instead of "v14" in a dropdown.
 */
export class VersionsModal extends Modal {
	private rows: Row[] = [];
	private contents = new Map<string, string>();
	private working = "";
	private selected: string = WORKING; // hash or WORKING
	private baseMode: "previous" | "head" | string = "previous"; // or a hash
	private granularity: DiffGranularity;
	private layout: "inline" | "side-by-side" | "patch";
	private surface: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private initialized = false;

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly file: TFile,
		private readonly blockId: string,
	) {
		super(plugin.app);
		this.granularity = plugin.settings.defaultGranularity;
		this.layout = plugin.settings.defaultDiffMode;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("mica-versions-modal");
		this.titleEl.setText("Version history");
		await this.reload();
	}

	private async reload(): Promise<void> {
		const state = (await this.plugin.engine.state(this.file))[this.blockId];
		const versions = state?.versions ?? [];
		this.rows = versions
			.map((meta, i) => ({ meta, n: i + 1, head: state?.head === meta.hash }))
			.reverse(); // newest first
		this.contents.clear();
		for (const r of this.rows) {
			this.contents.set(r.meta.hash, (await readObject(this.plugin.app.vault, this.file, r.meta.hash)) ?? "");
		}
		// The live block content = the "working copy" pseudo-version.
		const doc = await this.plugin.app.vault.read(this.file);
		const b = scanBlocksView(doc).find((x) => x.id === this.blockId);
		this.working = b ? doc.slice(b.content_start, b.content_end) : "";
		// First open: a dirty block compares its working copy against head; a
		// clean one shows the LAST CHANGE (head vs previous) — never an empty diff.
		if (!this.initialized) {
			this.initialized = true;
			if (!this.isDirty() && this.rows.length) this.selected = this.rows[0].meta.hash;
		}
		this.render();
	}

	private text(key: string): string {
		return key === WORKING ? this.working : (this.contents.get(key) ?? "");
	}

	private isDirty(): boolean {
		const head = this.rows.find((r) => r.head);
		if (!head) return contentSignature(this.working) !== contentSignature("");
		return contentSignature(this.text(head.meta.hash)) !== contentSignature(this.working);
	}

	/** The base content the selected version is compared against. */
	private baseKey(): string {
		if (this.baseMode !== "previous" && this.baseMode !== "head") return this.baseMode;
		const head = this.rows.find((r) => r.head);
		if (this.baseMode === "head") return head?.meta.hash ?? WORKING;
		// "previous": the version stored just before the selected one.
		if (this.selected === WORKING) return head?.meta.hash ?? WORKING;
		const idx = this.rows.findIndex((r) => r.meta.hash === this.selected);
		const prev = this.rows[idx + 1]; // rows are newest-first
		return prev?.meta.hash ?? this.selected;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.rows.length && !this.working.trim()) {
			contentEl.createEl("p", { text: "No stored versions yet. Edit the block, or run “Snapshot versions now”." });
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

		for (const r of this.rows) {
			const row = list.createDiv({
				cls: `mica-vrow ${this.selected === r.meta.hash ? "is-selected" : ""} ${r.head ? "is-head" : ""}`,
			});
			const title = row.createDiv({ cls: "mica-vrow-title" });
			title.createSpan({ cls: "mica-vrow-n", text: `v${r.n}` });
			if (r.meta.label) title.createSpan({ cls: "mica-vrow-label", text: r.meta.label });
			if (r.head) {
				const headIco = title.createSpan({ cls: "mica-vrow-head", attr: { "aria-label": "Current head" } });
				setIcon(headIco, "check");
			}
			const sub = row.createDiv({ cls: "mica-vrow-sub" });
			sub.createSpan({ text: relTime(r.meta.ts) });
			const preview = firstLine(this.text(r.meta.hash));
			if (preview) sub.createSpan({ cls: "mica-vrow-preview", text: ` · ${preview}` });

			row.addEventListener("click", () => {
				this.selected = r.meta.hash;
				this.renderList();
				this.renderDiffSurface();
			});
			row.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				this.versionMenu(e, r);
			});
			const more = row.createEl("button", {
				cls: "mica-vrow-more",
				attr: { type: "button", "aria-label": "Version actions" },
			});
			setIcon(more, "ellipsis");
			more.addEventListener("click", (e) => {
				e.stopPropagation();
				this.versionMenu(e, r);
			});
		}
	}

	private versionMenu(e: MouseEvent, r: Row): void {
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle("Restore this version")
				.setIcon("archive-restore")
				.onClick(async () => {
					await this.plugin.engine.revert(this.file, this.blockId, r.meta.hash);
					new Notice(`Restored v${r.n} (previous state was snapshotted first).`);
					await this.reload();
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle("Edit as new version (branch)")
				.setIcon("git-branch")
				.onClick(() => {
					new EditorLightbox({
						app: this.app,
						title: `Branch from v${r.n}${r.meta.label ? ` — ${r.meta.label}` : ""}`,
						initial: this.text(r.meta.hash),
						sourcePath: this.file.path,
						onSave: async (value) => {
							await this.plugin.engine.editVersion(this.file, this.blockId, r.meta.hash, value);
							new Notice(`New version created (branched from v${r.n}).`);
							await this.reload();
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
					await appendEvents(this.plugin.app.vault, this.file, [
						{
							type: "label",
							eid: newId(),
							ts: Date.now(),
							block: this.blockId,
							hash: r.meta.hash,
							label: label.trim() || null,
						},
					]);
					await this.reload();
				}),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle("Copy content")
				.setIcon("copy")
				.onClick(() => {
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

		const seg = <T extends string>(opts: [T, string][], value: T, pick: (v: T) => void): void => {
			const wrap = bar.createDiv({ cls: "mica-seg" });
			for (const [v, label] of opts) {
				const b = wrap.createEl("button", {
					cls: `mica-pop-seg ${v === value ? "is-on" : ""}`,
					text: label,
					attr: { type: "button" },
				});
				b.addEventListener("click", () => pick(v));
			}
		};

		const baseLabel =
			this.baseMode === "previous" ? "previous" : this.baseMode === "head" ? "head" : this.nameOf(this.baseMode);
		const baseBtn = bar.createEl("button", {
			cls: "mica-base-pick",
			text: `Base: ${baseLabel}`,
			attr: { type: "button", "aria-label": "Choose what to compare against" },
		});
		baseBtn.addEventListener("click", (e) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Previous version").onClick(() => this.setBase("previous")));
			menu.addItem((i) => i.setTitle("Head").onClick(() => this.setBase("head")));
			menu.addSeparator();
			for (const r of this.rows) {
				menu.addItem((i) =>
					i.setTitle(`v${r.n}${r.meta.label ? ` — ${r.meta.label}` : ""}`).onClick(() => this.setBase(r.meta.hash)),
				);
			}
			menu.showAtMouseEvent(e);
		});

		seg(
			[
				["line", "Line"],
				["word", "Word"],
				["char", "Char"],
			],
			this.granularity,
			(v) => {
				this.granularity = v;
				this.render();
			},
		);
		seg(
			[
				["inline", "Inline"],
				["side-by-side", "Split"],
				["patch", "Patch"],
			],
			this.layout,
			(v) => {
				this.layout = v;
				this.render();
			},
		);

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
		this.render();
	}

	private nameOf(hash: string): string {
		const r = this.rows.find((x) => x.meta.hash === hash);
		return r ? `v${r.n}` : hash.slice(0, 10);
	}

	private renderDiffSurface(): void {
		const surface = this.surface;
		if (!surface) return;
		surface.empty();
		const base = this.text(this.baseKey());
		const to = this.text(this.selected);
		const caption = surface.createDiv({ cls: "mica-diff-caption" });
		caption.setText(
			`${this.nameOf(this.baseKey())} → ${this.selected === WORKING ? "working copy" : this.nameOf(this.selected)}`,
		);
		const body = surface.createDiv();
		if (this.layout === "patch") {
			renderPatch(body, makePatch(base, to, 3));
			return;
		}
		renderDiff(body, diffText(base, to, this.granularity, 3), this.layout);
	}

	private async copyPatch(): Promise<void> {
		const patch = makePatch(this.text(this.baseKey()), this.text(this.selected), 3);
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
	for (const line of content.split("\n")) {
		const t = line.trim();
		if (!t || t.startsWith(":::") || t.startsWith("tab:") || t.startsWith("```")) continue;
		return t.length > 48 ? `${t.slice(0, 48)}…` : t;
	}
	return "";
}
