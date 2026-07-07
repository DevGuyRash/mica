import { Notice, Plugin, TFile } from "obsidian";
import { coreVersion, initCore, scanBlocksView } from "./wasm/bridge";
import { micaLivePreview } from "./cm/micaLivePreview";
import { registerReadingRenderer } from "./render/readingRenderer";
import { VersionEngine } from "./version/engine";
import { ensureBlockIds, ensureNoteId } from "./identity/identity";
import { repair } from "./identity/reconcile";
import { sidecarDir } from "./storage/sidecar";
import { DiffModal } from "./diff/diffModal";
import { MicaApi } from "./api/mica";

/**
 * Mica plugin entry point. Wires the WASM core, the three-mode renderer, and the
 * versioning engine. The scriptable API (M7) is added on top of these.
 */
export default class MicaPlugin extends Plugin {
	engine!: VersionEngine;
	api!: MicaApi;

	async onload(): Promise<void> {
		await initCore();
		this.engine = new VersionEngine(this);
		this.api = new MicaApi(this);
		this.api.registerBridge();
		(window as unknown as { mica?: MicaApi }).mica = this.api;

		registerReadingRenderer(this);
		this.registerEditorExtension(micaLivePreview(this));

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.engine.handleModify(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile && file.extension === "md") void this.followRename(file, oldPath);
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
		this.addCommand({
			id: "repair",
			name: "Repair history (reconcile)",
			callback: () => void this.runRepair(),
		});
		this.addCommand({
			id: "run-instruction",
			name: "Run instruction (JSON from clipboard)",
			callback: () => void this.runInstructionFromClipboard(),
		});

		console.info(`Mica: loaded (plugin v${this.manifest.version}, core v${coreVersion()})`);
	}

	onunload(): void {
		delete (window as unknown as { mica?: MicaApi }).mica;
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

	private async followRename(file: TFile, oldPath: string): Promise<void> {
		const oldSidecar = `${oldPath.slice(0, oldPath.length - file.extension.length - 1)}.mica`;
		const af = this.app.vault.getAbstractFileByPath(oldSidecar);
		if (af) await this.app.vault.rename(af, sidecarDir(file)).catch(() => undefined);
	}

	private async runRepair(): Promise<void> {
		const { actions, rehomed } = await repair(this);
		new Notice(`Mica repair: ${rehomed.length} rehomed, ${actions.length} issue(s). See console.`);
		if (actions.length || rehomed.length) console.info("Mica repair:", { rehomed, actions });
	}

	private async runInstructionFromClipboard(): Promise<void> {
		try {
			const result = await this.api.runInstruction(JSON.parse(await navigator.clipboard.readText()));
			new Notice("Mica: instruction ran (result in console).");
			console.info("Mica instruction result:", result);
		} catch (e) {
			new Notice(`Mica instruction failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
