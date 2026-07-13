import { browser } from "@wdio/globals";

/** Round-5 features that MUTATE the document: column resize + wrap toggle. */

async function seedAndOpen(path: string, content: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, p, c) => {
			let f = app.vault.getAbstractFileByPath(p);
			if (!f) f = await app.vault.create(p, c);
			if (!(f instanceof obsidian.TFile)) throw new Error(`not a file: ${p}`);
			await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source", source: false } });
		},
		path,
		content,
	);
}

describe("grid column resize + wrap toggle", function () {
	it("dragging the column divider persists colw fractions into the grid header", async function () {
		await seedAndOpen(
			"GridResize.md",
			"Intro.\n\n```mica id=gr-1\n:::grid {cols=2}\n:::cell\nalpha\n:::\n:::cell\nbeta\n:::\n:::\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-col-resizer").length >= 1),
			{ timeout: 8000, timeoutMsg: "the column resizer never rendered" },
		);
		await browser.executeObsidian(async () => {
			const strip = document.querySelector(".mica-lp .mica-col-resizer") as HTMLElement;
			const r = strip.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			const cy = r.top + r.height / 2;
			strip.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + 4, cy)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(r.left + 60, cy)));
			await new Promise((res) => setTimeout(res, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(r.left + 60, cy)));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return /:::grid \{cols=2 colw=[\d.]+,[\d.]+\}/.test(v);
				}),
			{ timeout: 8000, timeoutMsg: "colw never landed in the grid header" },
		);
	});

	it("the header wrap toggle writes wrap=off into the fence attrs", async function () {
		await seedAndOpen("WrapToggle.md", "Intro.\n\n```mica id=wr-1\ntab: Main\nsome body text\n```\n");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-head-btn[aria-pressed]").length >= 1,
				),
			{ timeout: 8000, timeoutMsg: "the wrap toggle never rendered" },
		);
		// Wrap defaults ON — the widget must say so before the click.
		const before = await browser.executeObsidian(
			() => (document.querySelector(".mica-lp.mica, .mica-lp .mica") as HTMLElement | null)?.dataset.micaWrap,
		);
		if (before !== "on") throw new Error(`expected default wrap=on, got ${before}`);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-head-btn[aria-pressed]") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("```mica id=wr-1 wrap=off") || /```mica [^\n]*wrap=off/.test(v);
				}),
			{ timeout: 8000, timeoutMsg: "wrap=off never landed in the fence attrs" },
		);
	});
});
