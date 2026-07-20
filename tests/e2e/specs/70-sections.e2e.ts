import { browser, expect } from "@wdio/globals";

async function seedAndOpen(path: string, content: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, filePath, source) => {
			let file = app.vault.getAbstractFileByPath(filePath);
			if (!file) file = await app.vault.create(filePath, source);
			if (!(file instanceof obsidian.TFile)) throw new Error(`not a file: ${filePath}`);
			else await app.vault.modify(file, source);
			await app.workspace.getLeaf(false).openFile(file, { state: { mode: "source", source: false } });
		},
		path,
		content,
	);
}

async function documentSource(): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) => {
		return app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
	});
}

async function clickLatestMenuItem(title: string): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.executeObsidian(
				(_, expected) =>
					Array.from(document.querySelectorAll<HTMLElement>("body > .menu .menu-item-title")).some(
						(element) => element.textContent?.trim() === expected,
					),
				title,
			),
		{ timeout: 8000, timeoutMsg: `menu item never appeared: ${title}` },
	);
	await browser.executeObsidian((_, expected) => {
		const menus = Array.from(document.querySelectorAll<HTMLElement>("body > .menu"));
		const item = Array.from(menus.at(-1)?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
			(element) => element.querySelector(".menu-item-title")?.textContent?.trim() === expected,
		);
		item?.click();
	}, title);
}

describe("structured sections", function () {
	it("keeps multiple paragraphs typed in one text editor as one section", async function () {
		await seedAndOpen("MultiParagraphSection.md", "Intro.\n\n```mica id=multi-paragraph\nAlpha\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-region .mica-md"))),
			{ timeout: 8000, timeoutMsg: "the text section never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region .mica-md") as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-region.is-editing"))),
			{ timeout: 8000, timeoutMsg: "the text editor never opened" },
		);
		await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lp .mica-region.is-editing .mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(value: string): void };
			};
			host.micaEditor?.setValue("Alpha\n\nBeta\n\n\nGamma");
			(document.querySelector(".mica-lp .mica-qe-save") as HTMLButtonElement).click();
		});
		await browser.waitUntil(
			async () =>
				(await documentSource()).includes(":::section\nAlpha\n\nBeta\n\n\nGamma\n:::\n") &&
				(await browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length)) === 1,
			{ timeout: 8000, timeoutMsg: "the paragraphs split into separate visual sections" },
		);
		expect(
			await browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-logical-section"))),
		).toBe(true);
	});

	it("edits a named code block and grows both inner and Mica fences safely", async function () {
		await seedAndOpen("StructuredCode.md", "Intro.\n\n````mica id=code-structured\n```md\n# before\n```\n````\n");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector('.mica-lp [aria-label="Edit code block (language, body)"]')),
				),
			{ timeout: 8000, timeoutMsg: "the structured code action never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('.mica-lp [aria-label="Edit code block (language, body)"]') as HTMLElement).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lightbox .mica-codeedit-info"))),
			{ timeout: 8000, timeoutMsg: "the structured code editor never opened" },
		);
		const editorState = await browser.executeObsidian(() => {
			const modal = document.querySelector(".mica-lightbox") as HTMLElement;
			const info = modal.querySelector(".mica-codeedit-info") as HTMLInputElement;
			const host = modal.querySelector(".mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(value: string): void };
			};
			const kind = host.shadowRoot?.querySelector<HTMLElement>(".cm-editor")?.dataset.micaEditorKind ?? "";
			info.value = "typescript";
			info.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
			host.micaEditor?.setValue("const value = 2;\n````\n");
			(modal.querySelector("button.mod-cta") as HTMLButtonElement).click();
			return { language: info.defaultValue || "md", kind };
		});
		expect(editorState.kind).toBe("code");
		await browser.waitUntil(
			async () => {
				const source = await documentSource();
				return (
					source.includes("``````mica id=code-structured") &&
					source.includes("`````typescript\nconst value = 2;\n````\n`````\n``````")
				);
			},
			{ timeout: 8000, timeoutMsg: "the structured code edit or fence growth did not commit" },
		);
	});

	it("projects nested callout code into the same structured editor", async function () {
		await seedAndOpen(
			"NestedStructuredCode.md",
			"Intro.\n\n````mica id=nested-code\n> [!note] Parent\n> before\n> ```js\n> const nested = 1;\n> ```\n> after\n````\n",
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(
						document.querySelector(
							'.mica-lp .mica-nested-code [aria-label="Edit this code block (language, body)"]',
						),
					),
				),
			{ timeout: 8000, timeoutMsg: "nested code did not receive unambiguous tools" },
		);
		await browser.executeObsidian(() => {
			(
				document.querySelector(
					'.mica-lp .mica-nested-code [aria-label="Edit this code block (language, body)"]',
				) as HTMLElement
			).click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lightbox .mica-codeedit-info"))),
			{ timeout: 8000, timeoutMsg: "nested code editor never opened" },
		);
		await browser.executeObsidian(() => {
			const modal = document.querySelector(".mica-lightbox") as HTMLElement;
			const host = modal.querySelector(".mica-mdeditor") as HTMLElement & {
				micaEditor?: { setValue(value: string): void };
			};
			host.micaEditor?.setValue("const nested = 2;");
			(modal.querySelector("button.mod-cta") as HTMLButtonElement).click();
		});
		await browser.waitUntil(async () => (await documentSource()).includes("> const nested = 2;\n> ```"), {
			timeout: 8000,
			timeoutMsg: "the nested code edit did not splice back into the callout",
		});
	});

	it("converts among rendered Markdown, callout, code, and source editing", async function () {
		await seedAndOpen("SectionModes.md", "Intro.\n\n```mica id=section-modes\nAlpha **bold**\n```\n");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-section-mode"))),
			{ timeout: 8000, timeoutMsg: "section mode control never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-section-mode") as HTMLElement).click();
		});
		await clickLatestMenuItem("Convert to Callout");
		await browser.waitUntil(async () => (await documentSource()).includes("> [!note]\n> Alpha **bold**"), {
			timeout: 8000,
			timeoutMsg: "Markdown did not convert to a callout",
		});

		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-section-mode") as HTMLElement).click();
		});
		await clickLatestMenuItem("Convert to Code block");
		await browser.waitUntil(async () => (await documentSource()).includes("```\nAlpha **bold**\n```"), {
			timeout: 8000,
			timeoutMsg: "callout did not convert to a code block",
		});

		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-section-mode") as HTMLElement).click();
		});
		await clickLatestMenuItem("Edit source");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-region.is-editing"))),
			{ timeout: 8000, timeoutMsg: "source mode did not open the inline editor" },
		);
	});

	it("combines after dwell with a themeable full-target indicator and can uncombine", async function () {
		await seedAndOpen(
			"CombineSections.md",
			"Intro.\n\n```mica id=combine-sections\nAlpha paragraph\n\nBeta paragraph\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 2),
			{ timeout: 8000, timeoutMsg: "the compatible regions never rendered" },
		);
		const feedback = await browser.executeObsidian(async () => {
			const regions = Array.from(document.querySelectorAll<HTMLElement>(".mica-lp .mica-region"));
			const source = regions.find((region) => region.textContent?.includes("Alpha"));
			const target = regions.find((region) => region.textContent?.includes("Beta"));
			const grip = source?.querySelector(".mica-region-grip") as HTMLElement | null;
			if (!source || !target || !grip) return { ready: false, sameBox: false, plus: "", themed: false };
			const sourceRect = source.getBoundingClientRect();
			const targetRect = target.getBoundingClientRect();
			const x = targetRect.left + targetRect.width / 2;
			const y = targetRect.top + targetRect.height / 2;
			const event = (px: number, py: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: px,
				clientY: py,
				button: 0,
				pointerId: 17,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", event(sourceRect.right - 8, sourceRect.top + 8)));
			window.dispatchEvent(new PointerEvent("pointermove", event(sourceRect.right + 20, sourceRect.bottom + 20)));
			await new Promise((resolve) => window.setTimeout(resolve, 30));
			window.dispatchEvent(new PointerEvent("pointermove", event(x, y)));
			await new Promise((resolve) => window.setTimeout(resolve, 760));
			const indicator = document.querySelector(".mica-drop-indicator") as HTMLElement | null;
			const indicatorRect = indicator?.getBoundingClientRect();
			const freshTarget = target.getBoundingClientRect();
			const result = {
				ready: Boolean(indicator?.classList.contains("is-combine-ready")),
				sameBox: Boolean(
					indicatorRect &&
					Math.abs(indicatorRect.width - freshTarget.width) < 3 &&
					Math.abs(indicatorRect.height - freshTarget.height) < 3,
				),
				plus: indicator ? getComputedStyle(indicator, "::after").content : "",
				themed: Boolean(getComputedStyle(document.body).getPropertyValue("--mica-combine-color").trim()),
			};
			window.dispatchEvent(new PointerEvent("pointerup", event(x, y)));
			return result;
		});
		expect(feedback.ready).toBe(true);
		expect(feedback.sameBox).toBe(true);
		expect(feedback.plus).toContain("+");
		expect(feedback.themed).toBe(true);
		await browser.waitUntil(
			async () => (await documentSource()).includes(":::section\nBeta paragraph\n\nAlpha paragraph\n:::\n"),
			{ timeout: 8000, timeoutMsg: "the compatible sections did not combine" },
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-logical-section"))),
			{ timeout: 8000, timeoutMsg: "the logical section did not render as one region" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-logical-section .mica-section-mode") as HTMLElement).click();
		});
		await clickLatestMenuItem("Uncombine section");
		await browser.waitUntil(async () => !(await documentSource()).includes(":::section"), {
			timeout: 8000,
			timeoutMsg: "the logical wrapper did not uncombine",
		});
	});
});
