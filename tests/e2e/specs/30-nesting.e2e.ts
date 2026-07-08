import { browser, expect } from "@wdio/globals";

// tabs → tab B → grid → cell → tabs → (B1, B2): a tab-grid within a tab group.
const NESTED = [
	"Lead paragraph.",
	"",
	"```mica id=blk-nest-1",
	":::tabs",
	":::tab A",
	"outer A",
	":::",
	":::tab B",
	":::grid {cols=2}",
	":::cell",
	"inner grid cell one",
	":::",
	":::cell",
	":::tabs",
	":::tab B1",
	"deep b1",
	":::",
	":::tab B2",
	"deep b2",
	":::",
	":::", // close inner tabs
	":::", // close cell 2
	":::", // close grid
	":::", // close tab B
	":::", // close outer tabs
	"```",
	"",
	"Trailing.",
].join("\n");

/** Whether any displayed `.mica-md` in the reading view contains `text`. */
function visible(text: string): Promise<boolean> {
	return browser.executeObsidian((_o, t) => {
		const root = document.querySelector(".markdown-reading-view") ?? document.body;
		return Array.from(root.querySelectorAll(".mica-md")).some(
			(el) => el instanceof HTMLElement && el.offsetParent !== null && (el.textContent ?? "").includes(t),
		);
	}, text);
}

/** Click a currently-displayed tab button whose label is exactly `label`. */
function clickTab(label: string): Promise<void> {
	return browser.executeObsidian((_o, t) => {
		const root = document.querySelector(".markdown-reading-view") ?? document.body;
		const btn = Array.from(root.querySelectorAll(".mica-tab-btn")).find(
			(b) => b instanceof HTMLElement && b.offsetParent !== null && b.textContent === t,
		);
		(btn as HTMLElement | undefined)?.click();
	}, label);
}

describe("deep nesting (tabs → grid → tabs)", function () {
	before(async function () {
		await browser.executeObsidian(async ({ app, obsidian }, content) => {
			let f = app.vault.getAbstractFileByPath("Nested.md");
			if (!f) f = await app.vault.create("Nested.md", content);
			if (!(f instanceof obsidian.TFile)) throw new Error("no Nested.md");
			await app.workspace.getLeaf(false).openFile(f, { state: { mode: "preview" } });
		}, NESTED);
		// Wait for the outcome (nested groups rendered), not a fixed sleep.
		await browser.waitUntil(
			async () =>
				browser.executeObsidian(() => {
					const root = document.querySelector(".markdown-reading-view") ?? document.body;
					return root.querySelectorAll(".mica-tabs").length >= 2;
				}),
			{ timeout: 10_000, timeoutMsg: "nested tab groups never rendered" },
		);
	});

	it("renders nested tab groups and a nested grid", async function () {
		const counts = await browser.executeObsidian(() => {
			const root = document.querySelector(".markdown-reading-view") ?? document.body;
			return {
				tabGroups: root.querySelectorAll(".mica-tabs").length,
				grids: root.querySelectorAll(".mica-grid").length,
			};
		});
		expect(counts.tabGroups).toBeGreaterThanOrEqual(2); // outer + inner
		expect(counts.grids).toBeGreaterThanOrEqual(1);
	});

	it("switches outer and inner tab groups independently", async function () {
		// Default: outer tab A is shown; everything under tab B is hidden.
		expect(await visible("outer A")).toBe(true);
		expect(await visible("deep b1")).toBe(false);

		await clickTab("B"); // reveal the nested grid + inner tab group
		expect(await visible("inner grid cell one")).toBe(true);
		expect(await visible("deep b1")).toBe(true); // inner B1 active by default
		expect(await visible("deep b2")).toBe(false);

		await clickTab("B2"); // switch WITHIN the inner group only
		expect(await visible("deep b2")).toBe(true);
		expect(await visible("deep b1")).toBe(false);
		expect(await visible("outer A")).toBe(false); // still on the outer tab B
	});
});
