import { Modal, Notice, Setting, TFile } from "obsidian";
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
			this.contentEl.setText("No stored versions for this block yet. Snapshot it first.");
			return;
		}
		// Newest first.
		const total = bs.versions.length;
		this.choices = [...bs.versions].reverse().map((v, i) => ({ hash: v.hash, label: v.label ?? `v${total - i}` }));
		for (const c of this.choices) {
			this.contents.set(c.hash, (await readObject(this.plugin.app.vault, this.file, c.hash)) ?? "");
		}
		this.baseIdx = Math.min(1, this.choices.length - 1);
		this.otherIdx = 0;
		this.otherIdx2 = NONE;
		this.render();
	}

	private versionDropdown(
		host: HTMLElement,
		name: string,
		value: number,
		allowNone: boolean,
		onPick: (v: number) => void,
	): void {
		new Setting(host).setName(name).addDropdown((d) => {
			if (allowNone) d.addOption(String(NONE), "—");
			this.choices.forEach((c, i) => d.addOption(String(i), c.label));
			d.setValue(String(value)).onChange((v) => onPick(Number(v)));
		});
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const controls = contentEl.createDiv({ cls: "mica-diff-controls" });

		this.versionDropdown(controls, "Base", this.baseIdx, false, (v) => {
			this.baseIdx = v;
			this.render();
		});
		this.versionDropdown(controls, "Compare", this.otherIdx, false, (v) => {
			this.otherIdx = v;
			this.render();
		});
		this.versionDropdown(controls, "Compare B", this.otherIdx2, true, (v) => {
			this.otherIdx2 = v;
			this.render();
		});
		new Setting(controls).setName("Granularity").addDropdown((d) => {
			d.addOption("line", "Line").addOption("word", "Word").addOption("char", "Char");
			d.setValue(this.granularity).onChange((v) => {
				this.granularity = v as DiffGranularity;
				this.render();
			});
		});
		new Setting(controls).setName("Mode").addDropdown((d) => {
			d.addOption("inline", "Inline").addOption("side-by-side", "Side by side").addOption("patch", "Patch");
			d.setValue(this.mode).onChange((v) => {
				this.mode = v as DiffMode | "patch";
				this.render();
			});
		});
		new Setting(controls)
			.addExtraButton((b) =>
				b
					.setIcon("arrow-left-right")
					.setTooltip("Swap base ↔ compare")
					.onClick(() => {
						[this.baseIdx, this.otherIdx] = [this.otherIdx, this.baseIdx];
						this.render();
					}),
			)
			.addButton((b) =>
				b.setButtonText("Copy patch").onClick(() => {
					void navigator.clipboard.writeText(makePatch(this.text(this.baseIdx), this.text(this.otherIdx), 3));
					new Notice("Patch copied.");
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Edit compare as new version")
					.setTooltip(
						"Branch: opens the Compare version for editing; saving creates a NEW version with this one as its parent",
					)
					.onClick(() => {
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
					}),
			);

		const surface = contentEl.createDiv();
		if (this.mode === "patch") {
			let patch = makePatch(this.text(this.baseIdx), this.text(this.otherIdx), 3);
			if (this.otherIdx2 !== NONE) {
				patch += `\n${makePatch(this.text(this.baseIdx), this.text(this.otherIdx2), 3)}`;
			}
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
