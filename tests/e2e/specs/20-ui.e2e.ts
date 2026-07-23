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

// A note whose block sits BELOW a leading line, so the cursor (at offset 0)
// starts outside the block and the widget renders. Each interactive test gets
// its own note so mutations don't bleed across tests.
async function seedAndOpen(path: string, block: string, mode: "preview" | "live"): Promise<void> {
	await browser.executeObsidian(
		async ({ app, obsidian }, p, content, m) => {
			let f = app.vault.getAbstractFileByPath(p);
			if (!f) f = await app.vault.create(p, content);
			if (!(f instanceof obsidian.TFile)) throw new Error(`not a file: ${p}`);
			await app.workspace.getLeaf(false).openFile(f, {
				state: m === "preview" ? { mode: "preview" } : { mode: "source", source: false },
			});
		},
		path,
		block,
		mode,
	);
}

/**
 * Force the global auto-save setting to a known state (persisted + awaited).
 * `autoSnapshotEnabled` lives in data.json, which survives across runs, so
 * footer tests must set it explicitly rather than inherit a prior toggle.
 */
async function setAutoSave(enabled: boolean): Promise<void> {
	await browser.executeObsidian(async ({ app }, on) => {
		const plugins = (
			app as unknown as {
				plugins: {
					getPlugin(
						id: string,
					): { settings: { autoSnapshotEnabled: boolean }; saveSettings(): Promise<void> } | null;
				};
			}
		).plugins;
		const p = plugins.getPlugin("mica");
		if (p) {
			p.settings.autoSnapshotEnabled = on;
			await p.saveSettings();
		}
	}, enabled);
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
		const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
		const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
			(element) => element.querySelector(".menu-item-title")?.textContent?.trim() === expected,
		);
		item?.click();
	}, title);
}

describe("rendering canaries (plugin-owned hooks only)", function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }, content) => {
			const existing = app.vault.getAbstractFileByPath("UI.md");
			if (!existing) await app.vault.create("UI.md", content);
		}, NOTE);
	});

	it("reading-mode processor renders switchable tabs", async function () {
		// Reading mode renders a block by calling the registered `mica` code-block
		// processor via MarkdownRenderer — invoke it directly. (The live reading
		// view is virtualized and renders nothing under headless Xvfb; this
		// exercises the exact same processor + renderCst, reliably.)
		const res = await browser.executeObsidian(async ({ app, obsidian }) => {
			const el = document.createElement("div");
			el.style.width = "600px";
			document.body.appendChild(el);
			const comp = new obsidian.Component();
			comp.load();
			await obsidian.MarkdownRenderer.render(
				app,
				"```mica id=rr-1\ntab: One\nfirst body\n\ntab: Two\nsecond body\n```\n",
				el,
				"RR.md",
				comp,
			);
			await new Promise((r) => setTimeout(r, 300)); // let region markdown settle
			const btns = Array.from(el.querySelectorAll<HTMLElement>(".mica-tab-btn"));
			const idx = (): number =>
				Array.from(el.querySelectorAll(".mica-tab-panel")).findIndex((p) => p.classList.contains("is-active"));
			const activeIdx0 = idx();
			btns[1]?.click();
			const out = {
				tabGroups: el.querySelectorAll(".mica-tabs").length,
				labels: btns.map((b) => b.textContent),
				activeIdx0,
				activeIdx1: idx(),
				activeText: el.querySelector(".mica-tab-panel.is-active")?.textContent ?? "",
			};
			comp.unload();
			el.remove();
			return out;
		});
		expect(res.tabGroups).toBe(1);
		expect(res.labels).toEqual(["One", "Two"]);
		expect(res.activeIdx0).toBe(0); // first tab active by default
		expect(res.activeIdx1).toBe(1); // clicking Two activates the second panel…
		expect(res.activeText).toContain("second body"); // …and shows its content
	});

	it("live preview replaces the fence with the Mica widget when the cursor is outside", async function () {
		await openNote("UI.md", "live");
		// THE canary for CM6 decoration legality: if block replace decorations
		// can't be supplied this way, the widget never appears.
		await expect($(".mica-lp .mica-tabs")).toExist();
	});

	it("uses rename-safe note-title labels for multiple unnamed blocks", async function () {
		const source = [
			"cursor anchor",
			"",
			"```mica id=unnamed-one",
			"tab: One",
			"first",
			"```",
			"",
			'```mica id=named-middle name="Explicit"',
			"tab: Named",
			"middle",
			"```",
			"",
			"```mica id=unnamed-two",
			"tab: Two",
			"second",
			"```",
		].join("\n");
		await seedAndOpen("Unnamed blocks.md", source, "live");
		await browser.waitUntil(async () => (await $$(".mica-lp .mica-head-name")).length === 3, {
			timeout: 5_000,
			timeoutMsg: "the unnamed-label fixtures did not render",
		});
		const labels = async (): Promise<string[]> =>
			browser.execute(() =>
				Array.from(document.querySelectorAll<HTMLElement>(".mica-lp .mica-head-name")).map(
					(element) => element.textContent ?? "",
				),
			);
		expect(await labels()).toEqual(["Unnamed blocks", "Explicit", "Unnamed blocks · 2"]);

		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath("Unnamed blocks.md");
			if (!(file instanceof obsidian.TFile)) throw new Error("missing unnamed-label note");
			await app.fileManager.renameFile(file, "Renamed blocks.md");
		});
		await browser.waitUntil(async () => (await labels())[0] === "Renamed blocks", {
			timeout: 5_000,
			timeoutMsg: "the inherited block label did not follow the note rename",
		});
		expect(await labels()).toEqual(["Renamed blocks", "Explicit", "Renamed blocks · 2"]);
	});

	it("the + affordance adds a tab and activates it", async function () {
		await seedAndOpen(
			"AddTab.md",
			"Intro line.\n\n```mica id=at-1\ntab: One\nfirst\n\ntab: Two\nsecond\n```\n",
			"live",
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-tab-nav .mica-tab-add").length > 0,
				),
			{ timeout: 8000, timeoutMsg: "the + button never appeared next to the tabs" },
		);
		await browser.executeObsidian(() => {
			// The "+" is inline in the scrollable nav, right after the last tab.
			(document.querySelector(".mica-lp .mica-tab-nav .mica-tab-add") as HTMLElement | null)?.click();
		});
		// The new tab lands in the live editor (friendly `tab:` style, matched)…
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) =>
					(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "").includes(
						"tab: New tab",
					),
				),
			{ timeout: 8000, timeoutMsg: "the new tab was not added to the document" },
		);
		// …it becomes the ACTIVE tab (no silent hidden add), and lands BLANK with
		// the "+ Add…" invitation instead of a surprise editor.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelector(".mica-lp .mica-tab-btn.is-active")?.textContent === "New tab",
				),
			{ timeout: 5000, timeoutMsg: "the new tab did not become active" },
		);
		const blank = await browser.executeObsidian(() => ({
			editorOpen: Boolean(document.querySelector(".mica-lp .mica-region.is-editing")),
			ghost: Boolean(document.querySelector(".mica-lp .mica-tab-panel.is-active .mica-ghost")),
		}));
		expect(blank.editorOpen).toBe(false);
		expect(blank.ghost).toBe(true);
	});

	it("inline editor shows clean prose (no ::: ) and commits an edit", async function () {
		await seedAndOpen("Inline.md", "Intro line.\n\n```mica id=in-1\ntab: One\nfirst tab body\n```\n", "live");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-region.is-editable").length > 0,
				),
			{ timeout: 8000, timeoutMsg: "no editable content region appeared" },
		);
		await browser.executeObsidian(() => {
			(
				document.querySelector(
					".mica-lp .mica-tab-panel.is-active .mica-region.is-editable",
				) as HTMLElement | null
			)?.click();
		});
		// The quick editor is CodeMirror now; it mounts on a microtask.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(
						document.querySelector(
							".mica-lp .mica-tab-panel.is-active .mica-region.is-editing .mica-mdeditor",
						),
					),
				),
			{ timeout: 8000, timeoutMsg: "the quick editor never opened" },
		);
		const shown = await browser.executeObsidian(() => {
			const ed = document.querySelector(".mica-lp .mica-region.is-editing .mica-mdeditor") as unknown as {
				micaEditor?: { getValue(): string };
			} | null;
			return ed?.micaEditor?.getValue() ?? null;
		});
		expect(shown).not.toBeNull();
		expect(shown).toContain("first tab body");
		expect(shown).not.toContain(":::"); // structural directives are never surfaced

		await browser.executeObsidian(() => {
			const ed = document.querySelector(".mica-lp .mica-region.is-editing .mica-mdeditor") as unknown as {
				micaEditor?: { setValue(v: string): void };
			} | null;
			ed?.micaEditor?.setValue("edited inline body");
			(
				document.querySelector(
					".mica-lp .mica-region.is-editing .mica-qe-bar button.mod-cta",
				) as HTMLElement | null
			)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) =>
					(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "").includes(
						"edited inline body",
					),
				),
			{ timeout: 8000, timeoutMsg: "the inline edit did not commit to the document" },
		);
	});

	it("the footer is quiet on auto-save and offers Save version on manual", async function () {
		await setAutoSave(true);
		await seedAndOpen("Toggle.md", "Intro line.\n\n```mica id=tg-1\ntab: One\nbody\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-footer"))),
			{ timeout: 8000, timeoutMsg: "the footer never appeared" },
		);
		// Auto mode: no always-on pill, no Save button — just the chip.
		expect(await browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-save-now")))).toBe(
			false,
		);

		await setAutoSave(false);
		await seedAndOpen("Toggle2.md", "Intro line.\n\n```mica id=tg-2\ntab: One\nbody\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-save-now"))),
			{ timeout: 8000, timeoutMsg: "manual mode did not surface the Save version button" },
		);
		await setAutoSave(true);
	});

	it("a block with a group shows no stray root write region (no duplicate section)", async function () {
		await seedAndOpen("Sections.md", "Intro line.\n\n```mica id=se-1\ntab: One\nfirst\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-tabs").length > 0),
			{ timeout: 8000, timeoutMsg: "the widget never rendered" },
		);
		// A tab with content shows no ghost anywhere and no WRITE REGION at the
		// block root (the old duplicate-section bug). Hover-revealed insert
		// zones between/around sections are a feature, not a stray.
		const stray = await browser.executeObsidian(() => {
			const rootLevel = (sel: string): number =>
				Array.from(document.querySelectorAll(`.mica-lp ${sel}`)).filter(
					(r) => !r.closest(".mica-tab-body") && !r.closest(".mica-cell"),
				).length;
			return { regions: rootLevel(".mica-region") };
		});
		expect(stray.regions).toBe(0);
	});

	it("an empty tab shows the write invitation with its icon", async function () {
		// Leading line so the Live Preview cursor lands OUTSIDE the block (otherwise
		// the block shows source and the widget — hence the ghost — never renders).
		await seedAndOpen("Empty.md", "Intro line.\n\n```mica id=eg-1\ntab: Blank\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-ghost").length > 0),
			{ timeout: 8000, timeoutMsg: "the empty-state ghost never rendered" },
		);
		const ghost = await browser.executeObsidian(() => {
			const g = document.querySelector(".mica-lp .mica-ghost");
			return {
				label: g?.querySelector(".mica-ghost-label")?.textContent ?? "",
				hasIcon: Boolean(g?.querySelector(".mica-ghost-icon svg")),
			};
		});
		expect(ghost.label).toBe("Add…"); // the invitation copy is a product contract
		expect(ghost.hasIcon).toBe(true); // …and it reads as an affordance, not stray text
	});

	it("a new grid starts empty and adds its first cell only on request", async function () {
		await seedAndOpen("NewGridEmpty.md", "Intro line.\n\n```mica id=ng-1\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-ghost"))),
			{ timeout: 8000, timeoutMsg: "the empty block invitation never rendered" },
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-ghost") as HTMLElement | null)?.click();
		});
		await browser.waitUntil(() => browser.executeObsidian(() => Boolean(document.querySelector("body > .menu"))), {
			timeout: 8000,
			timeoutMsg: "the insert menu never opened",
		});
		await browser.executeObsidian(() => {
			const menus = Array.from(document.querySelectorAll<HTMLElement>("body > .menu"));
			const item = Array.from(menus.at(-1)?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
				(el) => el.querySelector(".menu-item-title")?.textContent?.trim() === "Grid",
			);
			item?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) =>
					(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "").includes(
						":::grid {cols=2}\n:::\n",
					),
				),
			{ timeout: 8000, timeoutMsg: "the empty grid was not added to the document" },
		);
		const empty = await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			return {
				cells: view?.containerEl.querySelectorAll(".mica-lp .mica-cell").length ?? -1,
				addCell: view?.containerEl.querySelectorAll(".mica-lp .mica-cell-ghost").length ?? -1,
				editors: view?.containerEl.querySelectorAll(".mica-lp .mica-mdeditor").length ?? -1,
				source: view?.editor.getValue() ?? "",
			};
		});
		expect(empty.cells).toBe(0);
		expect(empty.addCell).toBe(1);
		expect(empty.editors).toBe(0);
		expect(empty.source).not.toContain(":::cell");

		await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			(view?.containerEl.querySelector(".mica-lp .mica-cell-ghost") as HTMLElement | null)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).some((menu) =>
						Array.from(menu.querySelectorAll(".menu-item-title")).some(
							(title) => title.textContent?.trim() === "Grid (nested)",
						),
					),
				),
			{ timeout: 8000, timeoutMsg: "the cell type menu never opened" },
		);
		await browser.executeObsidian(() => {
			// Mobile keeps the dismissed palette mounted through its exit animation;
			// identify the cell palette by its unique nested-grid entry so an older
			// root palette's Text item cannot receive this click.
			const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).find((candidate) =>
				Array.from(candidate.querySelectorAll(".menu-item-title")).some(
					(title) => title.textContent?.trim() === "Grid (nested)",
				),
			);
			const item = Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? []).find(
				(el) => el.querySelector(".menu-item-title")?.textContent?.trim() === "Text",
			);
			item?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
					return (
						(view?.editor.getValue() ?? "").includes(":::cell\n:::\n") &&
						Boolean(view?.containerEl.querySelector(".mica-lp .mica-cell .mica-mdeditor"))
					);
				}),
			{ timeout: 8000, timeoutMsg: "the requested first text cell did not open" },
		);
	});

	it("copies every section type with live, independent copy settings", async function () {
		const source = [
			"Intro line.",
			"",
			"````mica id=copy-1",
			":::tabs",
			":::tab One",
			"alpha",
			"",
			"> [!note] Parent",
			"> body",
			"> ```md",
			"> nested code",
			"> ```",
			"> > [!tip] Child",
			"> > nested",
			"",
			":::grid {cols=1}",
			":::cell",
			"cell text",
			":::",
			":::",
			":::",
			":::tab Two",
			"```js",
			"const value = 1;",
			"```",
			":::",
			":::",
			"````",
			"",
		].join("\n");
		await seedAndOpen("CopySections.md", source, "live");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
					return Boolean(
						view?.containerEl.querySelector('[data-mica-action-strip~="copy-grid"]') &&
						view.containerEl.querySelector('[data-mica-action-strip~="copy-nested-callout"]') &&
						view.containerEl.querySelector('[data-mica-action-strip~="copy-code"]'),
					);
				}),
			{ timeout: 8000, timeoutMsg: "section copy controls never rendered" },
		);

		const result = await browser.executeObsidian(async ({ app, obsidian }) => {
			type CopyPlugin = {
				settings: {
					copyIncludeMicaSyntax: boolean;
					copyIncludeOuterContainer: boolean;
					copyIncludeLineNumbers: boolean;
					copyLineNumberScope: "content" | "output";
				};
			};
			const plugin = (
				app as unknown as { plugins: { getPlugin(id: string): CopyPlugin | null } }
			).plugins.getPlugin("mica");
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (!plugin || !view) throw new Error("Mica or the active Markdown view is unavailable");
			const root = view.containerEl;
			const kinds = Array.from(root.querySelectorAll<HTMLElement>("[data-mica-action-strip]")).flatMap((strip) =>
				(strip.dataset.micaActionStrip ?? "")
					.split(" ")
					.filter((action) => action.startsWith("copy-"))
					.map((action) => action.slice(5)),
			);
			const strip = root.querySelector<HTMLElement>('[data-mica-action-strip~="copy-grid"]');
			if (!strip) throw new Error("grid copy control is unavailable");
			const copyGrid = async (): Promise<void> => {
				const direct = strip?.querySelector<HTMLButtonElement>('[data-mica-action="copy-grid"]');
				if (direct && getComputedStyle(direct).display !== "none") direct.click();
				else {
					strip.querySelector<HTMLButtonElement>('[data-mica-responsive-role="overflow"]')?.click();
					const menu = Array.from(document.querySelectorAll<HTMLElement>("body > .menu")).at(-1);
					Array.from(menu?.querySelectorAll<HTMLElement>(".menu-item") ?? [])
						.find(
							(item) =>
								item.querySelector(".menu-item-title")?.textContent?.trim() === "Copy grid contents",
						)
						?.click();
				}
				await Promise.resolve();
			};

			const clipboard = navigator.clipboard;
			const originalWrite = clipboard.writeText;
			let copied = "";
			Object.defineProperty(clipboard, "writeText", {
				configurable: true,
				value: async (text: string) => {
					copied = text;
				},
			});
			const previous = {
				syntax: plugin.settings.copyIncludeMicaSyntax,
				outer: plugin.settings.copyIncludeOuterContainer,
				lineNumbers: plugin.settings.copyIncludeLineNumbers,
				lineScope: plugin.settings.copyLineNumberScope,
			};
			const outputs: string[] = [];
			const numbered: string[] = [];
			const before = view.editor.getValue();
			const activeBefore = root.querySelector(".mica-tab-btn.is-active")?.textContent ?? "";
			try {
				for (const [syntax, outer] of [
					[false, false],
					[true, false],
					[false, true],
					[true, true],
				] as const) {
					plugin.settings.copyIncludeMicaSyntax = syntax;
					plugin.settings.copyIncludeOuterContainer = outer;
					plugin.settings.copyIncludeLineNumbers = false;
					copied = "";
					await copyGrid();
					outputs.push(copied);
				}
				plugin.settings.copyIncludeMicaSyntax = true;
				plugin.settings.copyIncludeOuterContainer = true;
				plugin.settings.copyIncludeLineNumbers = true;
				for (const scope of ["content", "output"] as const) {
					plugin.settings.copyLineNumberScope = scope;
					copied = "";
					await copyGrid();
					numbered.push(copied);
				}
			} finally {
				plugin.settings.copyIncludeMicaSyntax = previous.syntax;
				plugin.settings.copyIncludeOuterContainer = previous.outer;
				plugin.settings.copyIncludeLineNumbers = previous.lineNumbers;
				plugin.settings.copyLineNumberScope = previous.lineScope;
				Object.defineProperty(clipboard, "writeText", { configurable: true, value: originalWrite });
			}
			const keyboardCopy = root.querySelector<HTMLElement>('[data-mica-action="copy-text"]');
			keyboardCopy?.focus();
			// The toolbar intentionally fades in; wait past that visual transition
			// before asserting the keyboard-revealed state.
			await new Promise((resolve) => window.setTimeout(resolve, 160));
			const keyboardTools = keyboardCopy?.closest<HTMLElement>(".mica-region-tools");
			return {
				kinds,
				outputs,
				numbered,
				sourceUnchanged: view.editor.getValue() === before,
				activeUnchanged: (root.querySelector(".mica-tab-btn.is-active")?.textContent ?? "") === activeBefore,
				editors: root.querySelectorAll(".mica-mdeditor").length,
				keyboardVisible:
					Boolean(keyboardCopy && document.activeElement === keyboardCopy) &&
					Boolean(keyboardTools && getComputedStyle(keyboardTools).opacity === "1"),
			};
		});

		for (const kind of [
			"block",
			"tabs",
			"tab",
			"grid",
			"cell",
			"text",
			"callout",
			"code",
			"nested-callout",
			"nested-code",
		])
			expect(result.kinds).toContain(kind);
		const gridSyntax = ":::grid {cols=1}\n:::cell\ncell text\n:::\n:::\n";
		expect(result.outputs).toEqual([
			"cell text\n",
			gridSyntax,
			"```mica\ncell text\n```",
			`\`\`\`mica\n${gridSyntax}\`\`\``,
		]);
		expect(result.numbered[0]).toContain(":::grid {cols=1}\n:::cell\n1 │ cell text\n:::\n:::");
		expect(result.numbered[0]).not.toMatch(/^\s*1 │ ````mica/m);
		expect(result.numbered[1]).toMatch(/^1\s+│ ```+mica\n2\s+│ :::grid/m);
		expect(result.sourceUnchanged).toBe(true);
		expect(result.activeUnchanged).toBe(true);
		expect(result.editors).toBe(0);
		expect(result.keyboardVisible).toBe(true);
	});

	it("shows all clipboard projection settings and copy controls in Reading view", async function () {
		const reading = await browser.executeObsidian(async ({ app, obsidian }) => {
			const el = document.createElement("div");
			document.body.appendChild(el);
			const comp = new obsidian.Component();
			comp.load();
			await obsidian.MarkdownRenderer.render(
				app,
				"```mica id=copy-read\n:::grid {cols=1}\n:::cell\nread me\n:::\n:::\n```\n",
				el,
				"CopyReading.md",
				comp,
			);
			const result = {
				mode: el.querySelector(".mica")?.getAttribute("data-mica-mode") ?? "",
				kinds: Array.from(el.querySelectorAll<HTMLElement>("[data-mica-actions]")).flatMap((button) =>
					(button.dataset.micaActions ?? "")
						.split(" ")
						.filter((action) => action.startsWith("copy-"))
						.map((action) => action.slice(5)),
				),
			};
			comp.unload();
			el.remove();
			return result;
		});
		expect(reading.mode).toBe("read");
		for (const kind of ["block", "grid", "cell", "text"]) expect(reading.kinds).toContain(kind);

		const previousLineNumbers = await browser.executeObsidian(({ app }) => {
			const plugin = (
				app as unknown as {
					plugins: { getPlugin(id: string): { settings: { copyIncludeLineNumbers: boolean } } | null };
				}
			).plugins.getPlugin("mica");
			const setting = (app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
			setting.open();
			setting.openTabById("mica");
			return plugin?.settings.copyIncludeLineNumbers ?? false;
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() => {
					const names = Array.from(document.querySelectorAll<HTMLElement>(".setting-item-name")).map(
						(el) => el.textContent?.trim() ?? "",
					);
					return (
						names.includes("Include Mica layout syntax") &&
						names.includes("Wrap copies in an outer Mica block") &&
						names.includes("Include line numbers")
					);
				}),
			{ timeout: 8000, timeoutMsg: "the clipboard settings did not render" },
		);
		if (!previousLineNumbers)
			await browser.executeObsidian(() => {
				const row = Array.from(document.querySelectorAll<HTMLElement>(".setting-item")).find(
					(item) => item.querySelector(".setting-item-name")?.textContent?.trim() === "Include line numbers",
				);
				(row?.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.click();
			});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(document.querySelectorAll<HTMLElement>(".setting-item-name")).some(
						(element) => element.textContent?.trim() === "Lines to number",
					),
				),
			{ timeout: 8000, timeoutMsg: "the line-number scope setting did not reveal live" },
		);
		if (!previousLineNumbers)
			await browser.executeObsidian(() => {
				const row = Array.from(document.querySelectorAll<HTMLElement>(".setting-item")).find(
					(item) => item.querySelector(".setting-item-name")?.textContent?.trim() === "Include line numbers",
				);
				(row?.querySelector("input[type=checkbox]") as HTMLInputElement | null)?.click();
			});
		await browser.executeObsidian(({ app }) => {
			(app as unknown as { setting: { close(): void } }).setting.close();
		});
	});

	it("deleting the last tab removes the whole group", async function () {
		await seedAndOpen("DelTab.md", "Intro line.\n\n```mica id=dt-1\ntab: Only\nbody\n```\n", "live");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll('.mica-lp .mica-tab-chip [data-mica-actions~="delete"]').length > 0,
				),
			{ timeout: 8000, timeoutMsg: "the tab delete × never appeared" },
		);
		await browser.executeObsidian(() =>
			(
				document.querySelector('.mica-lp .mica-tab-chip [data-mica-actions~="delete"]') as HTMLElement | null
			)?.click(),
		);
		await clickLatestMenuItem("Delete");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					({ app, obsidian }) =>
						!(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "").includes(
							"tab: Only",
						),
				),
			{ timeout: 8000, timeoutMsg: "the emptied group was not removed" },
		);
		expect(await browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-tabs").length)).toBe(0);
	});

	it("the version chip's context menu carries the auto-save controls", async function () {
		await setAutoSave(true);
		await seedAndOpen("Interval.md", "Intro line.\n\n```mica id=in-2\ntab: A\nx\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-chip"))),
			{ timeout: 8000, timeoutMsg: "the version chip never appeared" },
		);
		const menuText = await browser.executeObsidian(async () => {
			const chip = document.querySelector(".mica-lp .mica-chip") as HTMLElement | null;
			chip?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
			await new Promise((r) => setTimeout(r, 150));
			const menu = document.querySelector(".menu");
			const text = menu?.textContent ?? "";
			(menu as HTMLElement | null)?.remove();
			return text;
		});
		expect(menuText).toContain("manual"); // switch to manual saving
		expect(menuText).toContain("Save version now");
	});

	it("the grid column number is click-editable", async function () {
		await seedAndOpen(
			"Cols.md",
			"Intro line.\n\n```mica id=co-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n```\n",
			"live",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-cols-chip"))),
			{ timeout: 8000, timeoutMsg: "the column chip never appeared" },
		);
		await browser.executeObsidian(() =>
			(document.querySelector(".mica-lp .mica-cols-chip") as HTMLElement | null)?.click(),
		);
		expect(
			await browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-stepper-input"))),
		).toBe(true);
	});

	it("dragging a tab reorders it", async function () {
		await seedAndOpen("Drag.md", "Intro line.\n\n```mica id=dg-1\ntab: One\naaa\n\ntab: Two\nbbb\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-tab-chip").length >= 2),
			{ timeout: 8000, timeoutMsg: "the tab chips never rendered" },
		);
		// Drive the pointer-based DnD: down on the chip, move past the threshold to
		// the append slot after the last chip, release.
		const dragDiagnostic = await browser.executeObsidian(async () => {
			const chips = Array.from(document.querySelectorAll(".mica-lp .mica-tab-chip")) as HTMLElement[];
			const [src, dst] = chips;
			const rs = src.getBoundingClientRect();
			const rd = dst.getBoundingClientRect();
			const nav = src.parentElement?.getBoundingClientRect();
			if (!nav) throw new Error("tab strip is unavailable");
			const appendX = Math.min(rd.right + 4, nav.right - 2);
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			src.dispatchEvent(new PointerEvent("pointerdown", opts(rs.left + 4, rs.top + rs.height / 2)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(appendX - 6, rd.top + rd.height / 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(appendX, rd.top + rd.height / 2)));
			await new Promise((r) => setTimeout(r, 30));
			const indicator = document.querySelector<HTMLElement>(".mica-drop-indicator");
			const diagnostic = {
				source: { left: rs.left, right: rs.right, top: rs.top, bottom: rs.bottom },
				destination: { left: rd.left, right: rd.right, top: rd.top, bottom: rd.bottom },
				nav: { left: nav.left, right: nav.right, top: nav.top, bottom: nav.bottom },
				active: document.body.classList.contains("mica-dnd-active"),
				indicator: indicator
					? { display: getComputedStyle(indicator).display, transform: indicator.style.transform }
					: null,
			};
			window.dispatchEvent(new PointerEvent("pointerup", opts(appendX, rd.top + rd.height / 2)));
			return diagnostic;
		});
		expect(dragDiagnostic.active).toBe(true);
		expect(dragDiagnostic.indicator?.display).toBe("block");
		try {
			await browser.waitUntil(
				() =>
					browser.executeObsidian(({ app, obsidian }) => {
						const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
						const two = v.indexOf("tab: Two");
						const one = v.indexOf("tab: One");
						return two >= 0 && one >= 0 && two < one; // Two now precedes One
					}),
				{ timeout: 8000, timeoutMsg: "the tab order did not change after drag" },
			);
		} catch (error) {
			console.log("TAB DRAG FAIL DIAG:", JSON.stringify(dragDiagnostic));
			throw error;
		}
	});

	it("dragging a grid cell up drops it above the target (vertical axis)", async function () {
		// 2-col grid → [alpha beta / gamma delta]. Drag delta (bottom-right) up and
		// aim at the TOP of alpha: the drop must use the vertical axis and land delta
		// BEFORE alpha (proving up/down works, not just left/right).
		await seedAndOpen(
			"CellDrag.md",
			"Intro line.\n\n```mica id=cd-1\n:::grid {cols=2}\n:::cell\nalpha\n:::\n:::cell\nbeta\n:::\n:::cell\ngamma\n:::\n:::cell\ndelta\n:::\n:::\n```\n",
			"live",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-cell").length >= 4),
			{ timeout: 8000, timeoutMsg: "the grid cells never rendered" },
		);
		await browser.executeObsidian(async () => {
			const cells = Array.from(document.querySelectorAll(".mica-lp .mica-cell")) as HTMLElement[];
			const handle = cells[3].querySelector('[aria-label="Drag to move this cell"]') as HTMLElement | null;
			const dst = cells[0]; // alpha
			if (!handle) return;
			const rd = dst.getBoundingClientRect();
			const rs = cells[3].getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			handle.dispatchEvent(new PointerEvent("pointerdown", opts(rs.right - 8, rs.top + 8)));
			// Column semantics: aim at alpha's TOP edge → the "before alpha,
			// same column" gap (its centre would mean "after alpha").
			window.dispatchEvent(new PointerEvent("pointermove", opts(rd.left + 12, rd.top + 10)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rd.left + 12, rd.top + 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rd.left + 12, rd.top + 2)));
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) => {
					const v = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
					const d = v.indexOf("delta");
					const a = v.indexOf("alpha");
					return d >= 0 && a >= 0 && d < a; // delta moved above alpha
				}),
			{ timeout: 8000, timeoutMsg: "the cell did not move above the target on a vertical drag" },
		);
	});

	it("editing a grid cell with newline-free text keeps the grid intact", async function () {
		await seedAndOpen(
			"CellEdit.md",
			"Intro line.\n\n```mica id=ce-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n```\n",
			"live",
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-cell .mica-region").length >= 2,
				),
			{ timeout: 8000, timeoutMsg: "the grid cells never rendered" },
		);
		// Type text WITHOUT a trailing newline into the first cell — the exact
		// trigger that used to glue "abc:::" and collapse the column.
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lp .mica-cell .mica-region") as HTMLElement | null)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector(".mica-lp .mica-cell .mica-region.is-editing .mica-mdeditor")),
				),
			{ timeout: 8000, timeoutMsg: "the cell quick editor never opened" },
		);
		await browser.executeObsidian(() => {
			const ed = document.querySelector(
				".mica-lp .mica-cell .mica-region.is-editing .mica-mdeditor",
			) as unknown as {
				micaEditor?: { setValue(v: string): void };
			} | null;
			ed?.micaEditor?.setValue("abc"); // no trailing newline on purpose
			(
				document.querySelector(
					".mica-lp .mica-cell .mica-region.is-editing .mica-qe-bar button.mod-cta",
				) as HTMLElement | null
			)?.click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app, obsidian }) =>
					(app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "").includes("abc"),
				),
			{ timeout: 8000, timeoutMsg: "the cell edit did not commit" },
		);
		const doc = await browser.executeObsidian(
			({ app, obsidian }) => app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "",
		);
		expect(doc).toContain("abc");
		expect(doc).not.toContain("abc:::"); // no glue onto the cell close
		expect((doc.match(/:::cell/g) ?? []).length).toBe(2); // both columns survive
	});

	it("theme + tab style retint and restyle the block", async function () {
		await seedAndOpen("Theme.md", "Intro line.\n\n```mica id=th-1\ntab: A\nx\n\ntab: B\ny\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-tab-btn.is-active"))),
			{ timeout: 8000, timeoutMsg: "the widget never rendered" },
		);
		const setTheme = (theme: string, tabStyle: string): Promise<void> =>
			browser.executeObsidian(
				({ app }, t, ts) => {
					const p = (
						app as unknown as {
							plugins: {
								getPlugin(
									id: string,
								): { settings: Record<string, unknown>; applyStyleVars(): void } | null;
							};
						}
					).plugins.getPlugin("mica");
					if (!p) return;
					p.settings.theme = t;
					p.settings.tabStyle = ts;
					p.settings.accentColor = "";
					p.applyStyleVars();
				},
				theme,
				tabStyle,
			);
		const probe = (): Promise<{ accent: string; chrome: string; radius: string }> =>
			browser.executeObsidian(() => {
				const nav = document.querySelector(".mica-lp .mica-tab-nav-outer") as HTMLElement | null;
				return {
					accent: getComputedStyle(document.body).getPropertyValue("--mica-accent").trim(),
					chrome: nav ? getComputedStyle(nav).backgroundColor : "",
					// Button radii belong to whatever theme is active; the honest
					// signal for the tab-style knob is the body attribute it drives.
					radius: document.body.getAttribute("data-mica-tabstyle") ?? "",
				};
			});
		await setTheme("default", "connected");
		const base = await probe();
		await setTheme("ocean", "pill");
		const ocean = await probe();
		expect(ocean.accent).not.toBe(base.accent); // the theme changed the driving accent
		expect(ocean.chrome).toMatch(/^(rgb|color)\(/); // accent-tinted chrome resolves to a real color
		expect(ocean.chrome).not.toBe(base.chrome); // …and it differs from the default chrome
		expect(ocean.radius).not.toBe(base.radius); // pill vs connected active-tab shape
		await setTheme("default", "connected"); // reset so later specs aren't themed
	});
});
