import { browser, expect } from "@wdio/globals";

/**
 * Regression: the fixture vault ships the user-reported hostile theme
 * ("Cyber Glow" + line numbers), whose hanging-indent rules shift every
 * .cm-line under .markdown-source-view by -56px. The embedded quick editor
 * must hold its own geometry regardless of theme.
 */
describe("embedded editor under a hostile theme", function () {
	it("keeps line starts inside the editor (no left clipping)", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const f =
				app.vault.getAbstractFileByPath("Armor.md") ??
				(await app.vault.create("Armor.md", "Intro.\n\n```mica id=armor-1\ntab: One\nWWWW body text\n```\n"));
			if (!(f instanceof obsidian.TFile)) throw new Error("not a file");
			await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source", source: false } });
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length > 0,
				),
			{ timeout: 8000, timeoutMsg: "widget never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region.is-editable") as HTMLElement | null)?.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-mdeditor .cm-line"))),
			{ timeout: 8000, timeoutMsg: "quick editor never opened" },
		);
		const m = await browser.executeObsidian(() => {
			const ed = document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement;
			const line = document.querySelector(".mica-lp .mica-mdeditor .cm-line") as HTMLElement;
			const sc = document.querySelector(".mica-lp .mica-mdeditor .cm-scroller") as HTMLElement;
			return {
				cssTheme: (window as unknown as { app: { customCss?: { theme?: string } } }).app.customCss?.theme ?? "",
				lineOffset: Math.round(line.getBoundingClientRect().left - ed.getBoundingClientRect().left),
				scrollLeft: sc.scrollLeft,
			};
		});
		expect(m.cssTheme).toBe("Cyber Glow"); // the hostile theme is genuinely active
		expect(m.lineOffset).toBeGreaterThanOrEqual(0); // no negative-margin bleed
		expect(m.scrollLeft).toBe(0);
	});
});
