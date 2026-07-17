import type MicaPlugin from "../main";
import type { BlockUi } from "../ui/blockShell";

const MAX_UI_STATES = 128;
const MAX_FOLD_STATES = 256;

/** Return the shared, bounded UI state for one block and refresh its recency. */
export function getBlockUi(plugin: MicaPlugin, key: string): BlockUi {
	const store = plugin.micaUi;
	const current = store.get(key);
	if (current) {
		store.delete(key);
		store.set(key, current);
		sweepUiStore(store, key);
		return current;
	}

	const ui: BlockUi = {
		active: new Map(),
		reveal: null,
		draft: null,
		collapsed: false,
		folded: new Set(plugin.settings.foldState[key] ?? []),
	};
	ui.persistFolds = () => {
		const foldState = plugin.settings.foldState;
		delete foldState[key];
		if (ui.folded.size) foldState[key] = [...ui.folded];

		const keys = Object.keys(foldState);
		for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_FOLD_STATES))) {
			delete foldState[stale];
		}
		void plugin.saveSettings();
	};

	store.set(key, ui);
	sweepUiStore(store, key);
	return ui;
}

/** Evict stale disposable state without ever discarding an unsaved draft. */
function sweepUiStore(store: Map<string, BlockUi>, currentKey: string): void {
	for (const [key, ui] of store) {
		if (store.size <= MAX_UI_STATES) return;
		if (key !== currentKey && !ui.draft) store.delete(key);
	}
}
