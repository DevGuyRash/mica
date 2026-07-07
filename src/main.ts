import { Plugin } from "obsidian";

/**
 * Mica plugin entry point.
 *
 * M0 only proves the plugin loads. Subsequent milestones wire the WASM core
 * (M1), the three-mode renderer + corruption-proof editor (M2), versioning
 * storage (M3), diffing (M4), and the scriptable API (M7) from here.
 */
export default class MicaPlugin extends Plugin {
	async onload(): Promise<void> {
		console.info(`Mica: loaded (v${this.manifest.version})`);
	}

	onunload(): void {
		console.info("Mica: unloaded");
	}
}
