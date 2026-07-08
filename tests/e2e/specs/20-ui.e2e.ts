import { browser, expect, $ } from "@wdio/globals";

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
		// …and it becomes the ACTIVE tab (auditor MAJOR-2: no silent hidden add).
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelector(".mica-lp .mica-tab-btn.is-active")?.textContent === "New tab",
				),
			{ timeout: 5000, timeoutMsg: "the new tab did not become active" },
		);
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
		const shown = await browser.executeObsidian(() => {
			const region = document.querySelector(
				".mica-lp .mica-tab-panel.is-active .mica-region.is-editable",
			) as HTMLElement | null;
			region?.click();
			const ta = document.querySelector(
				".mica-lp .mica-tab-panel.is-active .mica-region.is-editing textarea",
			) as HTMLTextAreaElement | null;
			return ta ? ta.value : null;
		});
		expect(shown).not.toBeNull();
		expect(shown).toContain("first tab body");
		expect(shown).not.toContain(":::"); // structural directives are never surfaced

		await browser.executeObsidian(() => {
			const ta = document.querySelector(
				".mica-lp .mica-tab-panel.is-active .mica-region.is-editing textarea",
			) as HTMLTextAreaElement | null;
			if (!ta) return;
			ta.value = "edited inline body";
			const save = document.querySelector(
				".mica-lp .mica-tab-panel.is-active .mica-region.is-editing .mica-region-actions button.mod-cta",
			) as HTMLElement | null;
			save?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
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

	it("the auto-save pill toggles Auto ↔ Manual", async function () {
		await setAutoSave(true); // known state, independent of prior runs' data.json
		await seedAndOpen("Toggle.md", "Intro line.\n\n```mica id=tg-1\ntab: One\nbody\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-auto"))),
			{ timeout: 8000, timeoutMsg: "the auto-save pill never appeared" },
		);
		const before = await browser.executeObsidian(() => {
			const p = document.querySelector(".mica-lp .mica-auto") as HTMLElement | null;
			return { on: p?.classList.contains("is-on") ?? false, text: p?.textContent ?? "" };
		});
		expect(before.on).toBe(true);
		expect(before.text).toContain("Auto");
		await browser.executeObsidian(() =>
			(document.querySelector(".mica-lp .mica-auto") as HTMLElement | null)?.click(),
		);
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelector(".mica-lp .mica-auto")?.classList.contains("is-off") === true,
				),
			{ timeout: 5000, timeoutMsg: "the pill did not switch to Manual" },
		);
		const after = await browser.executeObsidian(
			() => document.querySelector(".mica-lp .mica-auto")?.textContent ?? "",
		);
		expect(after).toContain("Manual");
		// Restore auto-save reliably (awaited), so later tests don't inherit Manual.
		await setAutoSave(true);
	});

	it("a block with a group shows no stray root write region (no duplicate section)", async function () {
		await seedAndOpen("Sections.md", "Intro line.\n\n```mica id=se-1\ntab: One\nfirst\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp .mica-tabs").length > 0),
			{ timeout: 8000, timeoutMsg: "the widget never rendered" },
		);
		// A tab with content shows no ghost anywhere, no region at the block root,
		// and NO root-level insert "+" (the confusing second one) — inserts live only
		// inside containers once a group exists.
		const stray = await browser.executeObsidian(() => {
			const rootLevel = (sel: string): number =>
				Array.from(document.querySelectorAll(`.mica-lp ${sel}`)).filter(
					(r) => !r.closest(".mica-tab-body") && !r.closest(".mica-cell"),
				).length;
			return { regions: rootLevel(".mica-region"), inserts: rootLevel(".mica-insert") };
		});
		expect(stray.regions).toBe(0);
		expect(stray.inserts).toBe(0);
	});

	it("deleting the last tab removes the whole group", async function () {
		await seedAndOpen("DelTab.md", "Intro line.\n\n```mica id=dt-1\ntab: Only\nbody\n```\n", "live");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() => document.querySelectorAll(".mica-lp .mica-tab-chip .mica-chip-x").length > 0,
				),
			{ timeout: 8000, timeoutMsg: "the tab delete × never appeared" },
		);
		await browser.executeObsidian(() =>
			(document.querySelector(".mica-lp .mica-tab-chip .mica-chip-x") as HTMLElement | null)?.click(),
		);
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

	it("the interval input opens in place, not at the far end", async function () {
		await setAutoSave(true); // the interval chip only shows when auto-save is on
		await seedAndOpen("Interval.md", "Intro line.\n\n```mica id=in-2\ntab: A\nx\n```\n", "live");
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-auto-secs"))),
			{ timeout: 8000, timeoutMsg: "the interval chip never appeared" },
		);
		await browser.executeObsidian(() =>
			(document.querySelector(".mica-lp .mica-auto-secs") as HTMLElement | null)?.click(),
		);
		const ok = await browser.executeObsidian(() => {
			const footer = document.querySelector(".mica-lp .mica-footer");
			if (!footer) return false;
			const kids = Array.from(footer.children);
			const inputIdx = kids.findIndex((k) => k.classList.contains("mica-auto-input"));
			const spacerIdx = kids.findIndex((k) => k.classList.contains("mica-footer-spacer"));
			return inputIdx >= 0 && spacerIdx >= 0 && inputIdx < spacerIdx; // before the spacer, not at the end
		});
		expect(ok).toBe(true);
	});

	it("the grid column number is click-editable", async function () {
		await seedAndOpen(
			"Cols.md",
			"Intro line.\n\n```mica id=co-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::\n```\n",
			"live",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lp .mica-stepper-val"))),
			{ timeout: 8000, timeoutMsg: "the column stepper never appeared" },
		);
		await browser.executeObsidian(() =>
			(document.querySelector(".mica-lp .mica-stepper-val") as HTMLElement | null)?.click(),
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
		// Drive HTML5 drag via synthetic events (the impl keys off a module payload
		// set on dragstart and read on drop, so this exercises the real path).
		await browser.executeObsidian(() => {
			const chips = Array.from(document.querySelectorAll(".mica-lp .mica-tab-chip")) as HTMLElement[];
			const [src, dst] = chips;
			const fire = (el: HTMLElement, type: string, x?: number): void => {
				const r = el.getBoundingClientRect();
				el.dispatchEvent(
					new DragEvent(type, {
						bubbles: true,
						cancelable: true,
						clientX: x ?? r.left + r.width / 2,
						clientY: r.top + r.height / 2,
					}),
				);
			};
			const rd = dst.getBoundingClientRect();
			fire(src, "dragstart");
			fire(dst, "dragover", rd.left + rd.width * 0.75); // past midpoint → drop AFTER
			fire(dst, "drop", rd.left + rd.width * 0.75);
			fire(src, "dragend");
		});
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
			const region = document.querySelector(".mica-lp .mica-cell .mica-region") as HTMLElement | null;
			region?.click();
			const ta = document.querySelector(
				".mica-lp .mica-cell .mica-region.is-editing textarea",
			) as HTMLTextAreaElement | null;
			if (!ta) return;
			ta.value = "abc";
			const save = document.querySelector(
				".mica-lp .mica-cell .mica-region.is-editing .mica-region-actions button.mod-cta",
			) as HTMLElement | null;
			save?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
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
				const btn = document.querySelector(".mica-lp .mica-tab-btn.is-active") as HTMLElement | null;
				return {
					accent: getComputedStyle(document.body).getPropertyValue("--mica-accent").trim(),
					chrome: nav ? getComputedStyle(nav).backgroundColor : "",
					radius: btn ? getComputedStyle(btn).borderTopLeftRadius : "",
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
