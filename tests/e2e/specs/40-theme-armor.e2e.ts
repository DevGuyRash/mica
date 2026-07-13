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
			() =>
				browser.executeObsidian(() =>
					Boolean(
						(
							document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement | null
						)?.shadowRoot?.querySelector(".cm-line"),
					),
				),
			{ timeout: 8000, timeoutMsg: "quick editor never opened" },
		);
		// Atomic + shadow-aware: the editor's internals live in a shadow root,
		// and the widget may rebuild between round-trips.
		let m = { cssTheme: "", lineOffset: -999, scrollLeft: -1 };
		await browser.waitUntil(
			async () => {
				m = await browser.executeObsidian(() => {
					const ed = document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement | null;
					const root = ed?.shadowRoot;
					const line = root?.querySelector(".cm-line") as HTMLElement | null;
					const sc = root?.querySelector(".cm-scroller") as HTMLElement | null;
					if (!ed || !line || !sc) return { cssTheme: "", lineOffset: -999, scrollLeft: -1 };
					return {
						cssTheme:
							(window as unknown as { app: { customCss?: { theme?: string } } }).app.customCss?.theme ??
							"",
						lineOffset: Math.round(line.getBoundingClientRect().left - ed.getBoundingClientRect().left),
						scrollLeft: sc.scrollLeft,
					};
				});
				return m.lineOffset !== -999;
			},
			{ timeout: 8000, timeoutMsg: "editor internals never became measurable" },
		);
		expect(m.cssTheme).toBe("Cyber Glow"); // the hostile theme is genuinely active
		expect(m.lineOffset).toBeGreaterThanOrEqual(0); // no negative-margin bleed
		expect(m.scrollLeft).toBe(0);

		// The quick-edit toolbar's MAIN glyphs must hold their size too — the
		// theme once collapsed them to dots while carets survived.
		const glyph = await browser.executeObsidian(() => {
			const icon = document.querySelector(".mica-lp .mica-toolbar .mica-tool .svg-icon");
			if (!icon) return { w: -1, h: -1 };
			const r = icon.getBoundingClientRect();
			return { w: Math.round(r.width), h: Math.round(r.height) };
		});
		expect(glyph.w).toBeGreaterThanOrEqual(12);
		expect(glyph.h).toBeGreaterThanOrEqual(12);
	});

	it("keeps line starts inside GRID-CELL editors too", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const f =
				app.vault.getAbstractFileByPath("ArmorCell.md") ??
				(await app.vault.create(
					"ArmorCell.md",
					"Intro.\n\n```mica id=armor-2\n:::grid {cols=2}\n:::cell\nWWWW alpha\n:::\n:::cell\nbeta\n:::\n:::\n```\n",
				));
			if (!(f instanceof obsidian.TFile)) throw new Error("not a file");
			await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source", source: false } });
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-cell .mica-region.is-editable").length > 0,
				),
			{ timeout: 8000, timeoutMsg: "cells never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-cell .mica-region.is-editable") as HTMLElement | null)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(
						(
							document.querySelector(".mica-lp .mica-cell .mica-mdeditor") as HTMLElement | null
						)?.shadowRoot?.querySelector(".cm-line"),
					),
				),
			{ timeout: 8000, timeoutMsg: "cell editor never opened" },
		);
		const m = await browser.executeObsidian(() => {
			const cell = document.querySelector(".mica-lp .mica-cell:has(.mica-mdeditor)") as HTMLElement;
			const ed = cell.querySelector(".mica-mdeditor") as HTMLElement;
			const root = ed.shadowRoot;
			if (!root)
				return {
					lineVsEditor: -999,
					editorVsRegion: -999,
					regionVsCell: -999,
					scrollLeft: -1,
					lineText: "NO SHADOW",
				};
			const line = root.querySelector(".cm-line") as HTMLElement;
			const sc = root.querySelector(".cm-scroller") as HTMLElement;
			const region = cell.querySelector(".mica-region.is-editing") as HTMLElement;
			return {
				lineVsEditor: Math.round(line.getBoundingClientRect().left - ed.getBoundingClientRect().left),
				editorVsRegion: Math.round(ed.getBoundingClientRect().left - region.getBoundingClientRect().left),
				regionVsCell: Math.round(region.getBoundingClientRect().left - cell.getBoundingClientRect().left),
				scrollLeft: sc.scrollLeft,
				lineText: line.textContent?.slice(0, 12) ?? "",
			};
		});
		console.log("CELL ARMOR:", JSON.stringify(m));
		expect(m.lineVsEditor).toBeGreaterThanOrEqual(0);
		expect(m.editorVsRegion).toBeGreaterThanOrEqual(0);
		expect(m.regionVsCell).toBeGreaterThanOrEqual(0);
		expect(m.scrollLeft).toBe(0);
	});
});
