import { Notice } from "obsidian";
import { clipboardText, type CopyOptions, type CopyTarget } from "./copyPayload";

/** One clipboard side-effect for menus, rendered docks, and raw-source docks.
 * Projection remains pure in copyPayload; this function owns the consistent
 * empty/error/success UX. */
export function writeClipboardProjection(target: CopyTarget, options: CopyOptions, successNotice: string): void {
	const text = clipboardText(target, options);
	if (!text) {
		new Notice("Nothing to copy.");
		return;
	}
	void navigator.clipboard.writeText(text).then(
		() => new Notice(successNotice),
		() => new Notice("Couldn't access the clipboard."),
	);
}
