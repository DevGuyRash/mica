import type { MicaApi } from "../../src/api/mica";

// The plugin exposes its full API on window.mica; specs assert against that
// contract inside executeObsidian callbacks (which run in the renderer).
declare global {
	interface Window {
		mica: MicaApi;
	}
}

export {};
