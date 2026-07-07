import { Notice, Plugin, TFile } from "obsidian";
import { coreVersion, initCore, scanBlocksView } from "./wasm/bridge";
import { micaLivePreview } from "./cm/micaLivePreview";
import { registerReadingRenderer } from "./render/readingRenderer";
import { VersionEngine } from "./version/engine";
import { ensureBlockIds, ensureNoteId } from "./identity/identity";
import { DiffModal } from "./diff/diffModal";

/**
 * Mica plugin entry point. Wires the WASM core, the three-mode renderer, and the
 * versioning engine. The scriptable API (M7) is added on top of these.
 */
export default class MicaPlugin extends Plugin {
	engine!: VersionEngine;

	async onload(): Promise<void> {
		await initCore();
		this.engine = new VersionEngine(this);

		registerReadingRenderer(this);
		this.registerEditorExtension(micaLivePreview(this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.engine.handleModify(file);
			}),
		);

		this.addCommand({
			id: "prepare-note",
			name: "Prepare note for Mica (add ids)",
			callback: () => void this.prepareActiveNote(),
		});
		this.addCommand({
			id: "snapshot-now",
			name: "Snapshot versions now",
			callback: () => void this.snapshotActiveNote(),
		});
		this.addCommand({
			id: "diff-versions",
			name: "Compare block versions",
			callback: () => void this.diffActiveBlock(),
		});

		console.info(`Mica: loaded (plugin v${this.manifest.version}, core v${coreVersion()})`);
	}

	onunload(): void {
		console.info("Mica: unloaded");
	}

	private async prepareActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		await ensureNoteId(this, file);
		await ensureBlockIds(this, file);
	}

	private async snapshotActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (file) await this.engine.snapshot(file);
	}

	private async diffActiveBlock(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) return;
		const block = scanBlocksView(await this.app.vault.read(file)).find((b) => b.id);
		if (!block?.id) {
			new Notice("No Mica block with an id in this note. Run “Prepare note for Mica” first.");
			return;
		}
		new DiffModal(this, file, block.id).open();
	}
}
