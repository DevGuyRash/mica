import { browser } from "@wdio/globals";

export type NoteViewMode = "preview" | "live";

interface SeedAndOpenOptions {
	mode?: NoteViewMode;
	overwriteExisting?: boolean;
}

/**
 * Seed a note deterministically when requested, then open it in the selected
 * Markdown mode.
 *
 * Returning before the previous note's blocks have left the DOM is what makes a
 * bare `.mica-lp` selector intermittently match the wrong fixture: the helper
 * hands back a document containing two notes' blocks and the next query picks
 * whichever comes first in document order. Every spec relies on that selector
 * shape, so the guarantee belongs here rather than in a hundred call sites.
 */
export async function seedAndOpenNote(
	path: string,
	content: string,
	{ mode = "live", overwriteExisting = false }: SeedAndOpenOptions = {},
): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, filePath, source, replace, viewMode) => {
			let file = app.vault.getAbstractFileByPath(filePath);
			if (!file) file = await app.vault.create(filePath, source);
			if (!(file instanceof obsidian.TFile)) throw new Error(`not a file: ${filePath}`);
			if (replace) await app.vault.modify(file, source);
			await app.workspace.getLeaf(false).openFile(file, {
				state: viewMode === "preview" ? { mode: "preview" } : { mode: "source", source: false },
			});
		},
		path,
		content,
		overwriteExisting,
		mode,
	);
	await browser.waitUntil(
		() =>
			browser.executeObsidian(({ app, obsidian }, filePath) => {
				const active = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				if (active?.file?.path !== filePath) return false;
				// Any Mica block still mounted outside the view we just opened
				// belongs to a note on its way out.
				const root = active.containerEl;
				return Array.from(document.querySelectorAll(".mica-lp")).every((block) => root.contains(block));
			}, path),
		{ timeout: 10_000, timeoutMsg: `blocks from another note were still mounted after opening ${path}` },
	);
}

/** Activate a menu item from the newest open menu, optionally using its visible direct-action equivalent. */
export async function clickLatestMenuItem(title: string, allowDirect = false): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.executeObsidian(
				(_, expected, mayUseDirect) => {
					const visible = (element: HTMLElement): boolean => {
						const style = getComputedStyle(element);
						return (
							element.isConnected &&
							style.display !== "none" &&
							style.visibility !== "hidden" &&
							style.opacity !== "0" &&
							style.pointerEvents !== "none" &&
							element.getClientRects().length > 0
						);
					};
					const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu"))
						.filter(visible)
						.at(-1);
					const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
						(element) =>
							visible(element) &&
							!element.hasClass("is-disabled") &&
							element.querySelector<HTMLElement>(".menu-item-title")?.textContent?.trim() === expected,
					);
					if (item) {
						item.click();
						return true;
					}
					if (!mayUseDirect) return false;
					const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find(
						(candidate) =>
							candidate.ariaLabel === expected &&
							!candidate.hasClass("mica-responsive-more") &&
							getComputedStyle(candidate).display !== "none",
					);
					if (!button) return false;
					button.click();
					return true;
				},
				title,
				allowDirect,
			),
		{ timeout: 8000, timeoutMsg: `menu item or direct action could not be activated: ${title}` },
	);
}
