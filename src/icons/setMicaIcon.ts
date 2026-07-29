import { setIcon } from "obsidian";
import { findIconPack, isIconPackEnabled, splitPackIconId, type EnabledIconPackIds } from "./iconPacks";
import { loadPackIcon } from "./iconPackRuntime";

/**
 * Draw an icon that may come from Obsidian's built-in set or an opt-in pack.
 *
 * Pack icons are namespaced `packId:iconName`, which keeps them distinguishable
 * from Lucide ids in stored block titles and means an id remains meaningful even
 * if the pack is later disabled — the name is still readable, it simply does not
 * resolve. Built-in ids stay exactly as they were, so nothing already authored
 * changes meaning.
 */

/**
 * Render `id` into `host`.
 *
 * Built-in icons are drawn synchronously, as before. A pack icon resolves
 * asynchronously; the element is checked for connection before insertion so a
 * result arriving after the surface was torn down is discarded rather than
 * mounted into a detached tree.
 */
export function setMicaIcon(host: HTMLElement, id: string, enabledPackIds: EnabledIconPackIds): void {
	const parts = splitPackIconId(id);
	if (!parts) {
		setIcon(host, id);
		return;
	}
	if (!isIconPackEnabled(parts.packId, enabledPackIds)) return;
	const pack = findIconPack(parts.packId);
	if (!pack) return;
	void loadPackIcon(pack, parts.icon).then((svg) => {
		if (!svg || !host.isConnected) return;
		host.empty();
		host.appendChild(svg);
	});
}
