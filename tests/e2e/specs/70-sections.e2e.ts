import { browser, expect } from "@wdio/globals";
import { clickLatestMenuItem as clickMenuItem, seedAndOpenNote } from "../helpers";

async function seedAndOpen(path: string, content: string): Promise<void> {
	await seedAndOpenNote(path, content, { overwriteExisting: true });
}

async function documentSource(): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }) => {
		return app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
	});
}

function clickLatestMenuItem(title: string): Promise<void> {
	return clickMenuItem(title, true);
}

async function expectOneLogicalEditor(expected: string): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.executeObsidian(({ app, obsidian }) => {
				const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl;
				return (
					root?.querySelectorAll(".mica-lp .mica-logical-section").length === 1 &&
					root.querySelectorAll(".mica-lp .mica-region").length === 1
				);
			}),
		{ timeout: 8000, timeoutMsg: "the normalized body did not render as one logical region" },
	);
	await browser.executeObsidian(({ app, obsidian }) => {
		const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl;
		(root?.querySelector(".mica-lp .mica-logical-section .mica-md") as HTMLElement | null)?.click();
	});
	await browser.waitUntil(
		() =>
			browser.executeObsidian(({ app, obsidian }) => {
				const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl;
				return root?.querySelectorAll(".mica-lp .mica-logical-section .mica-mdeditor").length === 1;
			}),
		{ timeout: 8000, timeoutMsg: "the normalized body did not open one logical editor" },
	);
	const state = await browser.executeObsidian(({ app, obsidian }) => {
		const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl;
		const host = root?.querySelector(".mica-lp .mica-logical-section .mica-mdeditor") as
			(HTMLElement & { micaEditor?: { getValue(): string } }) | null;
		return {
			editors: root?.querySelectorAll(".mica-lp .mica-mdeditor").length ?? -1,
			value: host?.micaEditor?.getValue() ?? null,
		};
	});
	expect(state.editors).toBe(1);
	expect(state.value).toBe(expected);
	await browser.executeObsidian(({ app, obsidian }) => {
		const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl;
		(root?.querySelector(".mica-lp .mica-qe-cancel") as HTMLButtonElement | null)?.click();
	});
	await browser.waitUntil(
		() =>
			browser.executeObsidian(({ app, obsidian }) => {
				const root = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl;
				return root?.querySelectorAll(".mica-lp .mica-mdeditor").length === 0;
			}),
		{ timeout: 8000, timeoutMsg: "the unchanged normalized editor did not close" },
	);
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

	it("restores normalized history as one logical editor", async function () {
		const note = "NormalizedHistorySection.md";
		const block = "normalized-history-section";
		const historicalBody =
			'Historical paragraph.\n\n> [!note] Historical detail\n> Keep this attached.\n\n```js\nconsole.log("historical");\n```\n';
		const currentBody =
			'Current paragraph.\n\n> [!tip] Current detail\n> Keep this attached too.\n\n```ts\nconsole.log("current");\n```\n';
		const historical = `:::section\n${historicalBody}:::\n`;
		const current = `:::section\n${currentBody}:::\n`;
		await seedAndOpen(note, `Intro.\n\n\`\`\`\`mica id=${block}\n${historical}\`\`\`\`\n`);
		await browser.executeObsidian((_, path) => window.mica.versionsSnapshot(path), note);
		const [historicalVersion] = await browser.executeObsidian(
			(_, path, id) => window.mica.versionsList(path, id),
			note,
			block,
		);
		if (!historicalVersion) throw new Error("the historical normalized version was not snapshotted");

		await browser.executeObsidian(
			async (_, path, id, source) => window.mica.blockUpdate(path, id, source),
			note,
			block,
			current,
		);
		await browser.waitUntil(
			async () =>
				(await browser.executeObsidian((_, path, id) => window.mica.blockRead(path, id), note, block)) ===
				current,
			{ timeout: 8000, timeoutMsg: "the current normalized body did not become live" },
		);
		await expectOneLogicalEditor(currentBody);

		await browser.executeObsidian(
			(_, path, id, hash) => window.mica.versionsRevert(path, id, hash),
			note,
			block,
			historicalVersion.hash,
		);
		await browser.waitUntil(
			async () =>
				(await browser.executeObsidian((_, path, id) => window.mica.blockRead(path, id), note, block)) ===
				historical,
			{ timeout: 8000, timeoutMsg: "the historical normalized body did not restore byte-exactly" },
		);
		await expectOneLogicalEditor(historicalBody);
	});

	it("edits a named code block and grows both inner and Mica fences safely", async function () {
		await seedAndOpen("StructuredCode.md", "Intro.\n\n````mica id=code-structured\n```md\n# before\n```\n````\n");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector('.mica-lp .mica-region [data-mica-actions~="fields"]')),
				),
			{ timeout: 8000, timeoutMsg: "the structured code action never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('.mica-lp .mica-region [data-mica-actions~="fields"]') as HTMLElement).click();
		});
		await clickLatestMenuItem("Edit language and code…");
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
					Boolean(document.querySelector('.mica-lp .mica-nested-code [data-mica-actions~="edit"]')),
				),
			{ timeout: 8000, timeoutMsg: "nested code did not receive unambiguous tools" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector('.mica-lp .mica-nested-code [data-mica-actions~="edit"]') as HTMLElement).click();
		});
		await clickLatestMenuItem("Edit this code block");
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
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector(".mica-lp .mica-region .mica-entity-menu")),
				),
			{ timeout: 8000, timeoutMsg: "section mode control never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region .mica-entity-menu") as HTMLElement).click();
		});
		await clickLatestMenuItem("Convert to Callout");
		await browser.waitUntil(async () => (await documentSource()).includes("> [!note]\n> Alpha **bold**"), {
			timeout: 8000,
			timeoutMsg: "Markdown did not convert to a callout",
		});

		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region .mica-entity-menu") as HTMLElement).click();
		});
		await clickLatestMenuItem("Convert to Code block");
		await browser.waitUntil(async () => (await documentSource()).includes("```\nAlpha **bold**\n```"), {
			timeout: 8000,
			timeoutMsg: "callout did not convert to a code block",
		});

		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-region .mica-entity-menu") as HTMLElement).click();
		});
		await clickLatestMenuItem("Edit source");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-region.is-editing"))),
			{ timeout: 8000, timeoutMsg: "source mode did not open the inline editor" },
		);
	});

	it("merges a whole run of sections in one action, and uncombines it exactly", async function () {
		const original = "Alpha para\n\nBeta para\n\nGamma para\n";
		await seedAndOpen("CombineRun.md", `Intro.\n\n\`\`\`mica id=combine-run\n${original}\`\`\`\n`);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-region").length >= 3),
			{ timeout: 8000, timeoutMsg: "the three regions never rendered" },
		);
		// The run action is offered from the first region, naming how far it reaches.
		await browser.executeObsidian(() => {
			const first = document.querySelector<HTMLElement>(".mica-lp .mica-region");
			first?.querySelector<HTMLButtonElement>(".mica-entity-menu")?.click();
		});
		await clickLatestMenuItem("Combine the next 3 sections");
		await browser.waitUntil(
			async () => (await documentSource()).includes(":::section\nAlpha para\n\nBeta para\n\nGamma para\n:::\n"),
			{ timeout: 8000, timeoutMsg: "the run did not merge into one section in document order" },
		);
		// One reduction, so one undo-able step, and exactly reversible.
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-logical-section"))),
			{ timeout: 8000, timeoutMsg: "the merged run did not render as one region" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-logical-section .mica-entity-menu") as HTMLElement).click();
		});
		await clickLatestMenuItem("Uncombine section");
		await browser.waitUntil(async () => (await documentSource()).includes(original), {
			timeout: 8000,
			timeoutMsg: "uncombining the run did not restore the original bytes",
		});
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
		const combineControls = await browser.executeObsidian(() => {
			const previous = document.querySelector<HTMLButtonElement>('[data-mica-action="combine-previous"]');
			const next = document.querySelector<HTMLButtonElement>('[data-mica-action="combine-next"]');
			return {
				previousLabel: previous?.getAttribute("aria-label") ?? "",
				nextLabel: next?.getAttribute("aria-label") ?? "",
				previousIcon: previous?.querySelector("svg")?.innerHTML ?? "",
				nextIcon: next?.querySelector("svg")?.innerHTML ?? "",
			};
		});
		expect(combineControls.previousLabel).toBe("Combine with section above");
		expect(combineControls.nextLabel).toBe("Combine with section below");
		expect(combineControls.previousIcon.length).toBeGreaterThan(0);
		expect(combineControls.nextIcon.length).toBeGreaterThan(0);
		expect(combineControls.previousIcon).not.toBe(combineControls.nextIcon);

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
		// Alpha is written before Beta, so combining them keeps Alpha first no
		// matter which one was dragged onto which. This previously asserted the
		// reverse, pinning a silent reordering of the user's prose.
		await browser.waitUntil(
			async () => (await documentSource()).includes(":::section\nAlpha paragraph\n\nBeta paragraph\n:::\n"),
			{ timeout: 8000, timeoutMsg: "the compatible sections did not combine in document order" },
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-logical-section"))),
			{ timeout: 8000, timeoutMsg: "the logical section did not render as one region" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-logical-section .mica-entity-menu") as HTMLElement).click();
		});
		await clickLatestMenuItem("Uncombine section");
		await browser.waitUntil(async () => !(await documentSource()).includes(":::section"), {
			timeout: 8000,
			timeoutMsg: "the logical wrapper did not uncombine",
		});
	});
});
