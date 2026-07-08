import { browser, expect } from "@wdio/globals";

// Friendly outer tabs (`tab:`); explicit `:::` only for the nested grid+tabs
// inside tab B — proving the two syntaxes compose (flat is effortless, nesting
// is possible).
const NESTED = [
	"```mica id=blk-nest-1",
	"tab: A",
	"outer A",
	"",
	"tab: B",
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
	"```",
	"",
].join("\n");

const PROBE = "mica-nest-probe";

/** Whether any displayed `.mica-md` in the probe contains `text`. */
function visible(text: string): Promise<boolean> {
	return browser.executeObsidian(
		(_o, t, probe) => {
			const root = document.getElementById(probe);
			if (!root) return false;
			return Array.from(root.querySelectorAll(".mica-md")).some(
				(el) => el instanceof HTMLElement && el.offsetParent !== null && (el.textContent ?? "").includes(t),
			);
		},
		text,
		PROBE,
	);
}

/** Click a currently-displayed tab button whose label is exactly `label`. */
function clickTab(label: string): Promise<void> {
	return browser.executeObsidian(
		(_o, t, probe) => {
			const root = document.getElementById(probe);
			if (!root) return;
			const btn = Array.from(root.querySelectorAll(".mica-tab-btn")).find(
				(b) => b instanceof HTMLElement && b.offsetParent !== null && b.textContent === t,
			);
			(btn as HTMLElement | undefined)?.click();
		},
		label,
		PROBE,
	);
}

describe("deep nesting (tabs → grid → tabs)", function () {
	before(async function () {
		// Render through Obsidian's real markdown pipeline (the exact path the
		// reading view's code-block processor uses) into a detached element. This
		// is reliable under headless Xvfb, where the virtualized reading view never
		// fires the scroll/intersection events that trigger section rendering.
		await browser.executeObsidian(
			async ({ app, obsidian }, md, probe) => {
				const el = document.createElement("div");
				el.id = probe;
				el.style.width = "800px";
				document.body.appendChild(el);
				const comp = new obsidian.Component();
				comp.load();
				(window as unknown as { __micaNestComp?: { unload?: () => void } }).__micaNestComp = comp;
				await obsidian.MarkdownRenderer.render(app, md, el, "Nested.md", comp);
				await new Promise((r) => setTimeout(r, 400)); // let nested region markdown settle
			},
			NESTED,
			PROBE,
		);
	});

	after(async function () {
		await browser.executeObsidian((_o, probe) => {
			(window as unknown as { __micaNestComp?: { unload?: () => void } }).__micaNestComp?.unload?.();
			document.getElementById(probe)?.remove();
		}, PROBE);
	});

	it("renders nested tab groups and a nested grid", async function () {
		const counts = await browser.executeObsidian((_o, probe) => {
			const root = document.getElementById(probe);
			return {
				tabGroups: root ? root.querySelectorAll(".mica-tabs").length : -1,
				grids: root ? root.querySelectorAll(".mica-grid").length : -1,
			};
		}, PROBE);
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
