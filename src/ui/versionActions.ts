import { Notice, TFile } from "obsidian";
import type MicaPlugin from "../main";
import type { WorkingCopyProvider } from "./versionsModal";

export interface VersionMutationBridge {
	readonly workingCopy?: WorkingCopyProvider;
	readonly recordDocuments?: (before: string, after: string, blockIds: readonly string[]) => void;
	readonly acknowledgeExactState?: (
		document: string,
		blockIds: readonly string[],
		state: "done" | "undone",
	) => boolean;
}

export async function saveBlockVersion(
	plugin: MicaPlugin,
	file: TFile,
	blockId: string,
	bridge: VersionMutationBridge = {},
): Promise<void> {
	try {
		if (!(await flushWorkingCopy(bridge.workingCopy))) return;
		const result = await plugin.engine.snapshotBlock(file, blockId, true);
		new Notice(
			result.blockIds.includes(blockId)
				? "Mica: version saved."
				: "Mica: no version saved — there were no changes.",
		);
	} catch (error) {
		new Notice(`Mica: save version failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function revertBlockToHead(
	plugin: MicaPlugin,
	file: TFile,
	blockId: string,
	bridge: VersionMutationBridge = {},
): Promise<void> {
	try {
		const before = bridge.workingCopy?.readDocument() ?? (await plugin.app.vault.read(file));
		if (before === null || !(await flushWorkingCopy(bridge.workingCopy, before))) return;
		const result = await plugin.engine.revertToHead(file, blockId);
		switch (result.status) {
			case "unchanged":
				new Notice("Mica: this block already matches the head version.");
				return;
			case "no-head":
				new Notice("Mica: this block does not have a head version yet.");
				return;
			case "unavailable":
				new Notice(`Mica: cannot revert to HEAD — ${result.reason}`);
				return;
			case "reverted": {
				const after = await plugin.app.vault.read(file);
				bridge.recordDocuments?.(before, after, [blockId]);
				showRevertNotice(plugin, file, blockId, result.recoveryHash, result.headHash, bridge);
				return;
			}
		}
	} catch (error) {
		new Notice(`Mica: revert to HEAD failed — ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function flushWorkingCopy(provider?: WorkingCopyProvider, expected?: string): Promise<boolean> {
	if (!provider) return true;
	const document = expected ?? provider.readDocument();
	if (document !== null && (await provider.flush(document))) return true;
	new Notice("Mica: the editor changed while saving. Review the latest text and try again.");
	return false;
}

function showRevertNotice(
	plugin: MicaPlugin,
	file: TFile,
	blockId: string,
	recoveryHash: string,
	headHash: string,
	bridge: VersionMutationBridge,
): void {
	const message = createFragment();
	message.append("Mica: reverted to HEAD. ");
	const undo = createEl("button");
	undo.type = "button";
	undo.className = "mica-undo-btn";
	undo.textContent = "Undo";
	const notice = new Notice(message, 8000);
	undo.addEventListener("click", () => {
		void (async () => {
			try {
				const editorDocument = bridge.workingCopy?.readDocument();
				if (editorDocument !== undefined && editorDocument !== null) {
					const vaultDocument = await plugin.app.vault.read(file);
					if (editorDocument !== vaultDocument) {
						new Notice("Mica: cannot undo the revert because the editor changed again.");
						return;
					}
				}
				await plugin.engine.restoreWorkingCopy(file, blockId, recoveryHash, headHash);
				if (bridge.acknowledgeExactState) {
					const restored = await plugin.app.vault.read(file);
					bridge.acknowledgeExactState(restored, [blockId], "undone");
				}
				notice.hide();
			} catch (error) {
				new Notice(`Mica: undo revert failed — ${error instanceof Error ? error.message : String(error)}`);
			}
		})();
	});
	message.appendChild(undo);
	notice.setMessage(message);
}
