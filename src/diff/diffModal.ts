import { Modal, Setting, TFile } from "obsidian";
import type MicaPlugin from "../main";
import { diffText, makePatch, type DiffGranularity } from "../wasm/bridge";
import { readObject } from "../storage/sidecar";
import { renderDiff, type DiffMode } from "./diffView";

interface Choice {
	hash: string;
	label: string;
}

/** Compare stored versions of a block (Meld-style): pick base + other, choose
 * granularity/mode, swap the base, or copy a unified patch. */
export class DiffModal extends Modal {
	private granularity: DiffGranularity = "line";
	private mode: DiffMode = "inline";
	private baseIdx = 1;
	private otherIdx = 0;
	private choices: Choice[] = [];
	private readonly contents = new Map<string, string>();

	constructor(
		private readonly plugin: MicaPlugin,
		private readonly file: TFile,
		private readonly blockId: string,
	) {
		super(plugin.app);
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
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const controls = contentEl.createDiv({ cls: "mica-diff-controls" });

		new Setting(controls).setName("Base").addDropdown((d) => {
			this.choices.forEach((c, i) => d.addOption(String(i), c.label));
			d.setValue(String(this.baseIdx)).onChange((v) => {
				this.baseIdx = Number(v);
				this.render();
			});
		});
		new Setting(controls).setName("Compare").addDropdown((d) => {
			this.choices.forEach((c, i) => d.addOption(String(i), c.label));
			d.setValue(String(this.otherIdx)).onChange((v) => {
				this.otherIdx = Number(v);
				this.render();
			});
		});
		new Setting(controls).setName("Granularity").addDropdown((d) => {
			d.addOption("line", "Line").addOption("word", "Word").addOption("char", "Char");
			d.setValue(this.granularity).onChange((v) => {
				this.granularity = v as DiffGranularity;
				this.render();
			});
		});
		new Setting(controls).setName("Mode").addDropdown((d) => {
			d.addOption("inline", "Inline").addOption("side-by-side", "Side by side");
			d.setValue(this.mode).onChange((v) => {
				this.mode = v as DiffMode;
				this.render();
			});
		});
		new Setting(controls)
			.addExtraButton((b) =>
				b
					.setIcon("arrow-left-right")
					.setTooltip("Swap base")
					.onClick(() => {
						[this.baseIdx, this.otherIdx] = [this.otherIdx, this.baseIdx];
						this.render();
					}),
			)
			.addButton((b) =>
				b.setButtonText("Copy patch").onClick(() => {
					void navigator.clipboard.writeText(makePatch(this.base(), this.other(), 3));
				}),
			);

		const surface = contentEl.createDiv();
		renderDiff(surface, diffText(this.base(), this.other(), this.granularity, 3), this.mode);
	}

	private base(): string {
		return this.contents.get(this.choices[this.baseIdx]?.hash ?? "") ?? "";
	}

	private other(): string {
		return this.contents.get(this.choices[this.otherIdx]?.hash ?? "") ?? "";
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
