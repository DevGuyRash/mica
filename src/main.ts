import { Plugin } from "obsidian";
import { coreVersion, initCore } from "./wasm/bridge";
import { micaLivePreview } from "./cm/micaLivePreview";
import { registerReadingRenderer } from "./render/readingRenderer";

/**
 * Mica plugin entry point.
 *
 * M0 only proves the plugin loads. Subsequent milestones wire the WASM core
 * (M1), the three-mode renderer + corruption-proof editor (M2), versioning
 * storage (M3), diffing (M4), and the scriptable API (M7) from here.
 */
export default class MicaPlugin extends Plugin {
	async onload(): Promise<void> {
		await initCore();
		registerReadingRenderer(this);
		this.registerEditorExtension(micaLivePreview(this));
		console.info(`Mica: loaded (plugin v${this.manifest.version}, core v${coreVersion()})`);
	}

	onunload(): void {
		console.info("Mica: unloaded");
	}
}
