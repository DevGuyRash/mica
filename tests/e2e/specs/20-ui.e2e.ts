import { browser, expect, $, $$ } from "@wdio/globals";

// Friendly, closer-free `tab:` syntax — the primary way users write blocks.
const NOTE = [
	"Leading paragraph so the cursor starts outside the block.",
	"",
	"```mica id=blk-ui-1",
	"tab: One",
	"first tab body",
	"",
	"tab: Two",
	"second tab body",
	"```",
	"",
	"Trailing paragraph.",
].join("\n");

async function openNote(path: string, mode: "preview" | "live"): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, p, m) => {
			let f = app.vault.getAbstractFileByPath(p);
			if (!f) f = await app.vault.create(p, "placeholder");
			if (!(f instanceof obsidian.TFile)) throw new Error(`not a file: ${p}`);
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(f, {
				state: m === "preview" ? { mode: "preview" } : { mode: "source", source: false },
			});
		},
		path,
		mode,
	);
}

describe("rendering canaries (plugin-owned hooks only)", function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }, content) => {
			const existing = app.vault.getAbstractFileByPath("UI.md");
			if (!existing) await app.vault.create("UI.md", content);
		}, NOTE);
	});

	it("reading view renders tabs and switching shows the selected tab's content", async function () {
		await openNote("UI.md", "preview");
		await expect($(".mica-tabs")).toExist();

		// The MarkdownView keeps the (hidden) editor DOM alongside the visible
		// reading view — and the hidden editor hosts its own Mica widget. Only
		// DISPLAYED elements are the outcome under test.
		const displayed = async (selector: string): Promise<WebdriverIO.Element[]> => {
			const shown: WebdriverIO.Element[] = [];
			for (const el of await $$(selector)) {
				if (await el.isDisplayed()) shown.push(el);
			}
			return shown;
		};

		const buttons = await displayed(".mica-tab-btn");
		expect(buttons.length).toBe(2);
		await buttons[1].click();

		const activePanels = await displayed(".mica-tab-panel.is-active");
		expect(activePanels.length).toBe(1);
		await expect(activePanels[0]).toHaveText(expect.stringContaining("second tab body"));

		// Version chip canary: the affordance for history is present per block.
		const chips = await displayed(".mica-chip");
		expect(chips.length).toBe(1);
	});

	it("live preview replaces the fence with the Mica widget when the cursor is outside", async function () {
		await openNote("UI.md", "live");
		// THE canary for CM6 decoration legality: if block replace decorations
		// can't be supplied this way, the widget never appears.
		await expect($(".mica-lp .mica-tabs")).toExist();
	});
});
