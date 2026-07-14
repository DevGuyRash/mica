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

async function docContains(_pred: string): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) => {
		return app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
	});
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

describe("round 6: folds, click-outside, region delete", function () {
	it("folding a section collapses it to a bar and unfolds on click", async function () {
		await seedAndOpen("Fold.md", "Intro.\n\n```mica id=fd-1\ntab: Main\n> [!note] Foldme\n\nprose after\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Foldme"),
			) as HTMLElement;
			(region.querySelector('[aria-label="Fold this section"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-fold-bar").length === 1),
			{ timeout: 8000, timeoutMsg: "the fold bar never appeared" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-fold-bar") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						document.querySelectorAll(".mica-lp .mica-fold-bar").length === 0 &&
						Array.from(document.querySelectorAll(".mica-lp .mica-region")).some((r) =>
							r.textContent?.includes("Foldme"),
						),
				),
			{ timeout: 8000, timeoutMsg: "the section never unfolded" },
		);
	});

	it("click-outside in save mode commits the open editor", async function () {
		await browser.executeObsidian(({ app }) => {
			type P = { settings: { editorClickOutside: string }; applyStyleVars(): void };
			const plugin = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins["mica"];
			plugin.settings.editorClickOutside = "save";
			plugin.applyStyleVars();
		});
		await seedAndOpen("ClickOut.md", "Intro.\n\n```mica id=co-1\ntab: Main\noriginal text\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length >= 1),
			{ timeout: 8000, timeoutMsg: "region never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region.is-editable") as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(
						(document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement | null)?.shadowRoot?.querySelector(
							".cm-content",
						),
					),
				),
			{ timeout: 8000, timeoutMsg: "editor never opened" },
		);
		await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lp .mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(v: string): void };
			};
			host.micaEditor?.setValue("edited by click-out");
			// Click far outside the editor (body counts: it contains no editor).
			document.body.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 9 }),
			);
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return v.includes("edited by click-out");
				}),
			{ timeout: 8000, timeoutMsg: "the click-outside save never landed" },
		);
		await browser.executeObsidian(({ app }) => {
			type P = { settings: { editorClickOutside: string }; applyStyleVars(): void };
			const plugin = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins["mica"];
			plugin.settings.editorClickOutside = "nothing";
			plugin.applyStyleVars();
		});
	});

	it("the region ✕ deletes the section (with undo pre-image applied)", async function () {
		await seedAndOpen("RegionDel.md", "Intro.\n\n```mica id=rd-1\ntab: Main\nkeep me\n\n> [!tip] Delete me\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Delete me"),
			) as HTMLElement;
			(region.querySelector('[aria-label="Delete this section"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					return !v.includes("Delete me") && v.includes("keep me");
				}),
			{ timeout: 8000, timeoutMsg: "the section was not deleted" },
		);
	});
});

describe("structured callout editor", function () {
	it("edits type/title/fold and re-quotes the body — nested callouts nest automatically", async function () {
		await seedAndOpen(
			"CalloutEdit.md",
			"Intro.\n\n```mica id=ce-1\ntab: Main\n> [!note] Old title\n> Original body line.\n\ntrailing prose\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "regions never rendered" },
		);
		await browser.executeObsidian(() => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Old title"),
			) as HTMLElement;
			(region.querySelector('[aria-label="Edit callout (type, title, body)"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lightbox-fields").length === 1),
			{ timeout: 8000, timeoutMsg: "the callout editor never opened" },
		);
		await browser.executeObsidian(() => {
			const modal = document.querySelector(".mica-lightbox") as HTMLElement;
			// Type via the shared color-tinted picker.
			(modal.querySelector(".mica-coedit-type") as HTMLElement).click();
			const pick = Array.from(modal.querySelectorAll(".mica-coedit-typepop .mica-callout-type")).find(
				(b) => b.querySelector(".mica-callout-name")?.textContent === "warning",
			) as HTMLElement;
			pick.click();
			const title = modal.querySelector(".mica-coedit-title") as HTMLInputElement;
			title.value = "New title";
			title.dispatchEvent(new Event("input", { bubbles: true }));
			(Array.from(modal.querySelectorAll(".mica-pop-seg")).find((b) => b.textContent === "Closed") as HTMLElement).click();
			const host = modal.querySelector(".mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(v: string): void };
			};
			// A callout typed INSIDE the body — must come out nested (> >).
			host.micaEditor?.setValue("Edited body.\n\n> [!tip] Inner\n> nested body");
			(Array.from(modal.querySelectorAll("button")).find((b) => b.textContent === "Save") as HTMLElement).click();
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return (
					v.includes("> [!warning]- New title") &&
					v.includes("> Edited body.") &&
					v.includes("> > [!tip] Inner") &&
					v.includes("> > nested body") &&
					v.includes("trailing prose")
				);
			},
			{ timeout: 8000, timeoutMsg: "the callout round-trip did not land" },
		);
	});
});
