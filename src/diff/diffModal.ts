import { Modal, Notice, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { diffText, makePatch, type DiffGranularity } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import { renderDiff, renderNUp, renderPatch, type DiffMode } from "./diffView";

interface Choice {
	hash: string;
	label: string;
}

const NONE = -1;

/**
 * Compare stored versions of a block (Meld-style): pick a base and up to two
 * others, choose granularity and mode (inline / side-by-side / N-up / patch),
 * swap the base, copy a patch, or branch-edit a previous version in place.
 */
export class DiffModal extends Modal {
	private granularity: DiffGranularity;
	private mode: DiffMode | "patch";
	private baseIdx = 1;
	private otherIdx = 0;
	private otherIdx2: number = NONE;
	private choices: Choice[] = [];
	private readonly contents = new Map<string, string>();

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly file: TFile,
		private readonly blockId: string,
	) {
		super(plugin.app);
		this.granularity = plugin.settings.defaultGranularity;
		this.mode = plugin.settings.defaultDiffMode;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("mica-diff-modal");
		this.titleEl.setText("Mica — compare versions");
		const state = await this.plugin.engine.state(this.file);
		const bs = state[this.blockId];
		if (!bs || bs.versions.length === 0) {
			this.contentEl.setText("No stored versions for this block yet. Edit it, or run “Snapshot versions now”.");
			return;
		}
		const total = bs.versions.length;
		this.choices = [...bs.versions].reverse().map((v, i) => ({ hash: v.hash, label: v.label ?? `v${total - i}` }));
		for (const c of this.choices) {
			this.contents.set(c.hash, (await readObject(this.plugin.app.vault, this.file, c.hash)) ?? "");
		}
		this.baseIdx = Math.min(1, this.choices.length - 1);
		this.otherIdx = 0;
		this.otherIdx2 = NONE;
		if (this.choices.length < 2) {
			this.contentEl.empty();
			this.contentEl.createEl("p", {
				cls: "mica-diff-empty",
				text: `Only one version stored (${this.choices[0]?.label ?? "v1"}). Edit the block — or use “Save version” — to create another, then compare.`,
			});
			return;
		}
		this.render();
	}

	private select(bar: HTMLElement, label: string): HTMLSelectElement {
		const field = bar.createDiv({ cls: "mica-diff-field" });
		field.createEl("label", { text: label });
		return field.createEl("select", { cls: "dropdown" });
	}

	private versionSelect(
		bar: HTMLElement,
		label: string,
		value: number,
		allowNone: boolean,
		onPick: (v: number) => void,
		exclude: number[] = [],
	): void {
		const sel = this.select(bar, label);
		if (allowNone) sel.createEl("option", { text: "—", value: String(NONE) });
		this.choices.forEach((c, i) => {
			if (!exclude.includes(i)) sel.createEl("option", { text: c.label, value: String(i) });
		});
		sel.value = String(value);
		sel.addEventListener("change", () => onPick(Number(sel.value)));
	}

	private optionSelect<T extends string>(
		bar: HTMLElement,
		label: string,
		opts: [T, string][],
		value: T,
		onPick: (v: T) => void,
	): void {
		const sel = this.select(bar, label);
		for (const [v, t] of opts) sel.createEl("option", { text: t, value: v });
		sel.value = value;
		sel.addEventListener("change", () => onPick(sel.value as T));
	}

	private button(bar: HTMLElement, label: string, tooltip: string, onClick: () => void): void {
		const b = bar.createEl("button", {
			cls: "mica-add-btn",
			text: label,
			attr: { type: "button", title: tooltip },
		});
		b.addEventListener("click", onClick);
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		// The 3rd column can't duplicate Base/Compare (empty or repeated column).
		if (this.otherIdx2 === this.baseIdx || this.otherIdx2 === this.otherIdx) this.otherIdx2 = NONE;
		const bar = contentEl.createDiv({ cls: "mica-diff-toolbar" });

		this.versionSelect(bar, "Base", this.baseIdx, false, (v) => {
			this.baseIdx = v;
			this.render();
		});
		this.versionSelect(bar, "Compare", this.otherIdx, false, (v) => {
			this.otherIdx = v;
			this.render();
		});
		this.versionSelect(
			bar,
			"+ 3rd",
			this.otherIdx2,
			true,
			(v) => {
				this.otherIdx2 = v;
				this.render();
			},
			[this.baseIdx, this.otherIdx],
		);
		this.optionSelect<DiffGranularity>(
			bar,
			"Granularity",
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
		this.optionSelect<DiffMode | "patch">(
			bar,
			"Mode",
			[
				["inline", "Inline"],
				["side-by-side", "Side by side"],
				["patch", "Patch"],
			],
			this.mode,
			(v) => {
				this.mode = v;
				this.render();
			},
		);

		bar.createDiv({ cls: "mica-diff-spacer" });
		this.button(bar, "⇄ Swap", "Swap base ↔ compare", () => {
			[this.baseIdx, this.otherIdx] = [this.otherIdx, this.baseIdx];
			this.render();
		});
		this.button(bar, "Copy patch", "Copy a unified diff to the clipboard", () => void this.copyPatch());
		this.button(
			bar,
			"Edit as new version",
			"Branch: edit the Compare version; saving creates a new version",
			() => {
				const pick = this.choices[this.otherIdx];
				if (!pick) return;
				new EditVersionModal(
					this.plugin,
					this.file,
					this.blockId,
					pick,
					this.text(this.otherIdx),
					() => void this.onOpen(),
				).open();
			},
		);

		const surface = contentEl.createDiv();
		if (this.mode === "patch") {
			let patch = makePatch(this.text(this.baseIdx), this.text(this.otherIdx), 3);
			if (this.otherIdx2 !== NONE)
				patch += `\n${makePatch(this.text(this.baseIdx), this.text(this.otherIdx2), 3)}`;
			renderPatch(surface, patch);
			return;
		}
		if (this.otherIdx2 !== NONE) {
			const col = (idx: number) => ({
				label: this.choices[idx]?.label ?? "?",
				result: diffText(this.text(this.baseIdx), this.text(idx), this.granularity, 3),
			});
			renderNUp(surface, { label: this.choices[this.baseIdx]?.label ?? "?", text: this.text(this.baseIdx) }, [
				col(this.otherIdx),
				col(this.otherIdx2),
			]);
			return;
		}
		renderDiff(
			surface,
			diffText(this.text(this.baseIdx), this.text(this.otherIdx), this.granularity, 3),
			this.mode,
		);
	}

	private text(idx: number): string {
		return this.contents.get(this.choices[idx]?.hash ?? "") ?? "";
	}

	/** Copy a unified patch, reporting the real clipboard outcome (auditor MINOR-1). */
	private async copyPatch(): Promise<void> {
		const patch = makePatch(this.text(this.baseIdx), this.text(this.otherIdx), 3);
		if (!patch.trim()) {
			new Notice("No differences to copy.");
			return;
		}
		try {
			await navigator.clipboard.writeText(patch);
			new Notice("Patch copied.");
		} catch {
			new Notice("Couldn’t access the clipboard.");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Branch-edit a stored version: saving writes a NEW version whose `parent` is
 * the version being edited, and makes it the head. History is never rewritten.
 */
class EditVersionModal extends Modal {
	constructor(
		private readonly plugin: MicaPlugin,
		private readonly file: TFile,
		private readonly blockId: string,
		private readonly parentVersion: Choice,
		private readonly initial: string,
		private readonly onSaved: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass("mica-diff-modal");
		this.titleEl.setText(`Edit ${this.parentVersion.label} → new version (branch)`);
		const ta = this.contentEl.createEl("textarea", { cls: "mica-edit-area mica-edit-area-modal" });
		ta.value = this.initial;
		const bar = this.contentEl.createDiv({ cls: "mica-tab-actions" });
		bar.createEl("button", {
			cls: "mod-cta",
			text: "Save as new version",
			attr: { type: "button" },
		}).addEventListener("click", () => void this.save(ta.value));
		bar.createEl("button", { text: "Cancel", attr: { type: "button" } }).addEventListener("click", () =>
			this.close(),
		);
	}

	private async save(content: string): Promise<void> {
		await this.plugin.engine.editVersion(this.file, this.blockId, this.parentVersion.hash, content);
		new Notice(`New version created (branched from ${this.parentVersion.label}).`);
		this.close();
		this.onSaved();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
