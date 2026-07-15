import { browser, expect } from "@wdio/globals";

/**
 * Drag & drop stress suite. Every scenario drives the REAL pointer pipeline
 * (pointerdown on a grip → threshold move → targeted moves → pointerup) and
 * asserts the resulting DOCUMENT text — the only truth that matters, since
 * every drop is one `moveNode`/`moveRegion` op through the shared reducer.
 *
 * Regression anchors (user round 4):
 *  - callouts are draggable units (parser gives them their own leaf);
 *  - the indicator NEVER sits in a no-op gap (the gaps hugging the dragged
 *    item are excluded), so "drag below the next item" shows BELOW it;
 *  - Esc cancels without touching the note.
 */

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

async function waitForSelector(sel: string, min = 1): Promise<void> {
	await browser.waitUntil(
		() => browser.executeObsidian((_, s, m) => document.querySelectorAll(s).length >= m, sel, min),
		{ timeout: 8000, timeoutMsg: `never rendered: ${sel}` },
	);
}

async function docContains(pred: string): Promise<string> {
	return browser.executeObsidian(({ app, obsidian }, _p) => {
		return app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.editor.getValue() ?? "";
	}, pred);
}

describe("drag & drop stress", function () {
	it("a callout drags BELOW its following sibling — indicator shown below it, not above", async function () {
		await seedAndOpen(
			"DndCallouts.md",
			"Intro.\n\n```mica id=dnd-1\ntab: Main\nprose intro\n\n> [!note] Alpha\n\n> [!tip] Beta\n\n> [!warning] Gamma\n```\n",
		);
		await waitForSelector(".mica-lp .mica-region", 4); // prose + 3 callouts
		const probe = await browser.executeObsidian(async () => {
			const regions = Array.from(document.querySelectorAll(".mica-lp .mica-region")) as HTMLElement[];
			const beta = regions.find((r) => r.textContent?.includes("Beta"));
			const gamma = regions.find((r) => r.textContent?.includes("Gamma"));
			const grip = beta?.querySelector(".mica-region-grip") as HTMLElement | null;
			if (!beta || !gamma || !grip) return { ok: false, indTop: -1, gammaBottom: -1 };
			const rb = beta.getBoundingClientRect();
			const rg = gamma.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rb.right - 10, rb.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rb.right - 20, rb.top + 30)));
			await new Promise((r) => setTimeout(r, 30));
			// Re-dispatch the targeting move with FRESH rects until the indicator
			// shows — layout can shift under full-suite load, so a fire-once
			// coordinate goes stale.
			let ind: HTMLElement | null = null;
			let gb = rg.bottom;
			let dropX = rg.left + 40;
			for (let tries = 0; tries < 30; tries++) {
				const fresh = gamma.getBoundingClientRect();
				gb = fresh.bottom;
				dropX = fresh.left + 40;
				window.dispatchEvent(new PointerEvent("pointermove", opts(dropX, gb + 4)));
				ind = document.querySelector(".mica-drop-indicator");
				if (ind && ind.style.display !== "none") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			const indTop = ind ? ind.getBoundingClientRect().top : -1;
			window.dispatchEvent(new PointerEvent("pointerup", opts(dropX, gb + 4)));
			return { ok: true, indTop, gammaBottom: gb };
		});
		expect(probe.ok).toBe(true);
		// The round-4 bug: pointing below Gamma showed the line ABOVE Gamma.
		expect(probe.indTop).toBeGreaterThanOrEqual(probe.gammaBottom - 4);
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return v.indexOf("[!warning] Gamma") >= 0 && v.indexOf("[!warning] Gamma") < v.indexOf("[!tip] Beta");
			},
			{ timeout: 8000, timeoutMsg: "Beta did not land below Gamma" },
		);
	});

	it("a callout drags UP above an earlier sibling", async function () {
		await seedAndOpen(
			"DndCalloutsUp.md",
			"Intro.\n\n```mica id=dnd-2\ntab: Main\n> [!note] Alpha\n\n> [!tip] Beta\n```\n",
		);
		await waitForSelector(".mica-lp .mica-region", 2);
		await browser.executeObsidian(async () => {
			const regions = Array.from(document.querySelectorAll(".mica-lp .mica-region")) as HTMLElement[];
			const alpha = regions.find((r) => r.textContent?.includes("Alpha"));
			const beta = regions.find((r) => r.textContent?.includes("Beta"));
			const grip = beta?.querySelector(".mica-region-grip") as HTMLElement | null;
			if (!alpha || !beta || !grip) return;
			const ra = alpha.getBoundingClientRect();
			const rb = beta.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rb.right - 10, rb.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rb.right - 30, rb.top - 10)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(ra.left + 40, ra.top + 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(ra.left + 40, ra.top + 2)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return v.indexOf("[!tip] Beta") >= 0 && v.indexOf("[!tip] Beta") < v.indexOf("[!note] Alpha");
			},
			{ timeout: 8000, timeoutMsg: "Beta did not move above Alpha" },
		);
	});

	it("spring-loading: a callout crosses into another tab's body", async function () {
		await seedAndOpen(
			"DndSpring.md",
			"Intro.\n\n```mica id=dnd-3\ntab: One\n> [!note] Mover\ntab: Two\nsecond tab prose\n```\n",
		);
		await waitForSelector(".mica-lp .mica-tab-chip", 2);
		const diag = await browser.executeObsidian(async ({ app, obsidian }) => {
			// Scope to the ACTIVE view: background leaves keep their widgets in
			// the DOM, so document-wide queries can grab a stale note's chips.
			const scope = app.workspace.getActiveViewOfType(obsidian.MarkdownView)?.containerEl ?? document.body;
			const region = Array.from(scope.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Mover"),
			) as HTMLElement | undefined;
			const grip = region?.querySelector(".mica-region-grip") as HTMLElement | null;
			const chips = Array.from(scope.querySelectorAll(".mica-lp .mica-tab-chip")) as HTMLElement[];
			const two = chips.find((c) => c.textContent?.includes("Two"));
			if (!region || !grip || !two) return;
			const rr = region.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.right - 30, rr.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			// Hover tab Two's chip until the spring fires — the hover is
			// re-dispatched with a FRESH rect each step so layout shifts under
			// load can't leave the pointer besides the chip.
			let springed = false;
			for (let tries = 0; tries < 30; tries++) {
				const fresh = two.getBoundingClientRect();
				window.dispatchEvent(
					new PointerEvent("pointermove", opts(fresh.left + fresh.width / 2, fresh.top + fresh.height / 2)),
				);
				await new Promise((r) => setTimeout(r, 120));
				springed = two.querySelector(".mica-tab-btn")?.classList.contains("is-active") ?? false;
				if (springed) break;
			}
			// …then drop inside the now-visible panel body.
			const body = document.querySelector(".mica-lp .mica-tab-panel.is-active .mica-tab-body") as HTMLElement;
			const rbody = body.getBoundingClientRect();
			window.dispatchEvent(new PointerEvent("pointermove", opts(rbody.left + 60, rbody.bottom - 8)));
			await new Promise((r) => setTimeout(r, 30));
			const ind = document.querySelector(".mica-drop-indicator") as HTMLElement | null;
			const indShown = Boolean(ind && ind.style.display !== "none");
			window.dispatchEvent(new PointerEvent("pointerup", opts(rbody.left + 60, rbody.bottom - 8)));
			return { springed, indShown };
		});
		// The chip must have spring-loaded (panel switched mid-drag) and the
		// drop must have been a promised, visible slot.
		expect(diag?.springed).toBe(true);
		expect(diag?.indShown).toBe(true);
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				const two = v.indexOf("tab: Two");
				const mover = v.indexOf("[!note] Mover");
				return two >= 0 && mover > two;
			},
			{ timeout: 8000, timeoutMsg: "Mover never crossed into tab Two" },
		);
	});

	it("a callout drops into a grid cell (cross-type nesting)", async function () {
		await seedAndOpen(
			"DndIntoCell.md",
			"Intro.\n\n```mica id=dnd-4\n> [!tip] Floating\n\n:::grid {cols=2}\n:::cell\nalpha\n:::\n:::cell\nbeta\n:::\n:::\n```\n",
		);
		await waitForSelector(".mica-lp .mica-cell", 2);
		await browser.executeObsidian(async () => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Floating"),
			) as HTMLElement | undefined;
			const grip = region?.querySelector(".mica-region-grip") as HTMLElement | null;
			const cells = Array.from(document.querySelectorAll(".mica-lp .mica-cell")) as HTMLElement[];
			const beta = cells[1];
			if (!region || !grip || !beta) return;
			const rr = region.getBoundingClientRect();
			const rb = beta.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.right - 30, rr.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rb.left + rb.width / 2, rb.bottom - 10)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rb.left + rb.width / 2, rb.bottom - 10)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				// The callout must now live INSIDE the beta cell's directive.
				const betaIdx = v.indexOf("beta");
				const tip = v.indexOf("[!tip] Floating");
				const close = v.indexOf(":::", betaIdx);
				return betaIdx >= 0 && tip > betaIdx && close > tip;
			},
			{ timeout: 8000, timeoutMsg: "the callout never landed inside the beta cell" },
		);
	});

	it("a whole tabs GROUP reorders among root sections", async function () {
		await seedAndOpen(
			"DndGroup.md",
			"Intro.\n\n```mica id=dnd-5\nlead paragraph\n\n:::tabs\ntab: Inner\ninner body\n:::\n\n:::grid {cols=1}\n:::cell\ntail cell\n:::\n:::\n```\n",
		);
		await waitForSelector(".mica-lp .mica-tabs", 1);
		await browser.executeObsidian(async () => {
			const wrap = document.querySelector(".mica-lp .mica-tabs") as HTMLElement;
			const grip = wrap.querySelector(".mica-group-grip") as HTMLElement | null;
			const grid = document.querySelector(".mica-lp .mica-grid-wrap") as HTMLElement;
			if (!wrap || !grip || !grid) return;
			const rw = wrap.getBoundingClientRect();
			const rg = grid.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rw.left + 10, rw.top + 10)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rw.left + 30, rw.top + 40)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rg.left + 40, rg.bottom + 6)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rg.left + 40, rg.bottom + 6)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				const grid = v.indexOf(":::grid");
				const tabs = v.indexOf("tab: Inner");
				return grid >= 0 && tabs > grid; // tabs group moved below the grid
			},
			{ timeout: 8000, timeoutMsg: "the tabs group did not move below the grid" },
		);
	});

	it("Escape cancels a drag without touching the document", async function () {
		const fixture =
			"Intro.\n\n```mica id=dnd-6\ntab: Main\n> [!note] Stay\n\n> [!tip] Put\n```\n";
		await seedAndOpen("DndEsc.md", fixture);
		await waitForSelector(".mica-lp .mica-region", 2);
		const before = await docContains("");
		await browser.executeObsidian(async () => {
			const regions = Array.from(document.querySelectorAll(".mica-lp .mica-region")) as HTMLElement[];
			const stay = regions.find((r) => r.textContent?.includes("Stay"));
			const put = regions.find((r) => r.textContent?.includes("Put"));
			const grip = stay?.querySelector(".mica-region-grip") as HTMLElement | null;
			if (!stay || !put || !grip) return;
			const rs = stay.getBoundingClientRect();
			const rp = put.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rs.right - 10, rs.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rs.right - 30, rs.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rp.left + 40, rp.bottom + 4)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rp.left + 40, rp.bottom + 4)));
		});
		await new Promise((r) => setTimeout(r, 300));
		const after = await docContains("");
		expect(after).toBe(before);
	});
});

describe("round 7: column integrity + friendly-form safety", function () {
	it("same-column reorder bubbles within the column — the other column is untouched", async function () {
		await seedAndOpen(
			"ColBubble.md",
			"Intro.\n\n```mica id=cb-1\n:::grid {cols=2}\n:::cell\na\n:::\n:::cell\nb\n:::\n:::cell\nc\n:::\n:::cell\nd\n:::\n:::cell\ne\n:::\n:::cell\nf\n:::\n:::\n```\n",
		);
		await waitForSelector(".mica-lp .mica-cell", 6);
		await browser.executeObsidian(async () => {
			const cells = Array.from(document.querySelectorAll(".mica-lp .mica-cell")) as HTMLElement[];
			const a = cells[0]; // col 0, row 0
			const e5 = cells[4]; // "e": col 0, row 2
			const handle = a.querySelector(".mica-cell-tool") as HTMLElement;
			const ra = a.getBoundingClientRect();
			const re = e5.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			handle.dispatchEvent(new PointerEvent("pointerdown", opts(ra.left + 10, ra.top + 10)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(ra.left + 30, ra.top + 40)));
			await new Promise((r) => setTimeout(r, 30));
			// Below e, inside e's column band — refreshed until the drop is live.
			let dropX = re.left + 20;
			let dropY = re.bottom + 2;
			for (let tries = 0; tries < 30; tries++) {
				const fresh = e5.getBoundingClientRect();
				dropX = fresh.left + 20;
				dropY = fresh.bottom + 2;
				window.dispatchEvent(new PointerEvent("pointermove", opts(dropX, dropY)));
				const ind = document.querySelector(".mica-drop-indicator") as HTMLElement | null;
				if (ind && ind.style.display !== "none") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			window.dispatchEvent(new PointerEvent("pointerup", opts(dropX, dropY)));
		});
		await browser.waitUntil(
			async () => {
				const doc = await docContains("");
				const order = [...doc.matchAll(/:::cell\n(\w)\n/g)].map((m) => m[1]).join("");
				return order === "cbedaf";
			},
			{ timeout: 8000, timeoutMsg: "expected flow order c,b,e,d,a,f after the column bubble" },
		);
	});

	it("a region dropped below a friendly tabs group stays at root (group directivized)", async function () {
		await seedAndOpen(
			"FriendlyGlue.md",
			"Intro.\n\n```mica id=fg-1\ntab: One\n> [!note] Mover\n\nkeeper prose\n```\n",
		);
		await waitForSelector(".mica-lp .mica-region", 2);
		await browser.executeObsidian(async () => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Mover"),
			) as HTMLElement;
			const grip = region.querySelector(".mica-region-grip") as HTMLElement;
			const wrap = document.querySelector(".mica-lp .mica-tabs") as HTMLElement;
			const rr = region.getBoundingClientRect();
			const rw = wrap.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.right - 30, rr.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rw.left + 40, rw.bottom + 6)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rw.left + 40, rw.bottom + 6)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				// The group must be directivized and the callout must sit at ROOT
				// (after the closing :::), not inside the last tab.
				const close = v.lastIndexOf(":::");
				const mover = v.indexOf("[!note] Mover");
				return v.includes(":::tabs") && mover > 0 && close > 0 && mover > close;
			},
			{ timeout: 8000, timeoutMsg: "the region glued into the friendly group instead of staying at root" },
		);
	});

	it("a sole-region cell's content drags OUT into a sibling cell", async function () {
		await seedAndOpen(
			"SoleOut.md",
			"Intro.\n\n```mica id=so-1\n:::grid {cols=2}\n:::cell\n> [!tip] Nomad\n:::\n:::cell\nhost text\n:::\n:::\n```\n",
		);
		await waitForSelector(".mica-lp .mica-cell", 2);
		await browser.executeObsidian(async () => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Nomad"),
			) as HTMLElement;
			const grip = region.querySelector(".mica-region-grip") as HTMLElement;
			const cells = Array.from(document.querySelectorAll(".mica-lp .mica-cell")) as HTMLElement[];
			const host = cells[1];
			const rr = region.getBoundingClientRect();
			const rh = host.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 30)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.right - 30, rr.top + 50)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rh.left + rh.width / 2, rh.bottom - 10)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rh.left + rh.width / 2, rh.bottom - 10)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				const host = v.indexOf("host text");
				const nomad = v.indexOf("[!tip] Nomad");
				return host > 0 && nomad > host;
			},
			{ timeout: 8000, timeoutMsg: "the sole region never moved into the sibling cell" },
		);
	});
});

describe("round 10: sole-item safety + cross-block moves", function () {
	it("dragging a tab's ONLY section within its own tab changes nothing", async function () {
		const fixture = "Intro.\n\n```mica id=sole-1\ntab: Only\n> [!note] Lonely\ntab: Other\nother stuff\n```\n";
		await seedAndOpen("SoleDrag.md", fixture);
		await waitForSelector(".mica-lp .mica-region", 1);
		const before = await docContains("");
		await browser.executeObsidian(async () => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Lonely"),
			) as HTMLElement;
			const grip = region.querySelector(".mica-region-grip") as HTMLElement;
			const rr = region.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 6)));
			// Wiggle strictly WITHIN the region's own bounds.
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.left + 60, rr.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.left + 80, rr.top + rr.height / 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rr.left + 80, rr.top + rr.height / 2)));
		});
		await new Promise((r) => setTimeout(r, 400));
		const after = await docContains("");
		expect(after).toBe(before);
	});

	it("dragging a grid's ONLY cell within the grid changes nothing", async function () {
		const fixture = "Intro.\n\n```mica id=sole-2\n:::grid {cols=1}\n:::cell\nlone cell\n:::\n:::\n```\n";
		await seedAndOpen("SoleCell.md", fixture);
		await waitForSelector(".mica-lp .mica-cell", 1);
		const before = await docContains("");
		await browser.executeObsidian(async () => {
			const cell = document.querySelector(".mica-lp .mica-cell") as HTMLElement;
			const handle = cell.querySelector(".mica-cell-tool") as HTMLElement;
			const rc = cell.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			handle.dispatchEvent(new PointerEvent("pointerdown", opts(rc.right - 10, rc.top + 8)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rc.left + 40, rc.top + 30)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rc.left + 60, rc.top + rc.height / 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rc.left + 60, rc.top + rc.height / 2)));
		});
		await new Promise((r) => setTimeout(r, 400));
		const after = await docContains("");
		expect(after).toBe(before);
	});

	it("a callout drags into ANOTHER mica block entirely", async function () {
		await seedAndOpen(
			"CrossBlock.md",
			"First block:\n\n```mica id=xb-1\ntab: Src\n> [!tip] Traveler\n\nstays here\n```\n\nSecond block:\n\n```mica id=xb-2\ntab: Dst\ndestination prose\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp").length >= 2),
			{ timeout: 8000, timeoutMsg: "both blocks never rendered" },
		);
		await browser.executeObsidian(async () => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Traveler"),
			) as HTMLElement;
			const grip = region.querySelector(".mica-region-grip") as HTMLElement;
			const dstRegion = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("destination prose"),
			) as HTMLElement;
			const rr = region.getBoundingClientRect();
			const rd = dstRegion.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.right - 30, rr.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rd.left + 40, rd.top - 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rd.left + 40, rd.top - 2)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				const b2 = v.indexOf("id=xb-2");
				const traveler = v.indexOf("[!tip] Traveler");
				// Landed inside block 2, gone from block 1, block 1 keeps its prose.
				return traveler > b2 && v.indexOf("stays here") < b2 && v.lastIndexOf("[!tip] Traveler") === traveler;
			},
			{ timeout: 8000, timeoutMsg: "the callout never crossed into the second block" },
		);
	});

	it("a whole GRID drags into another block", async function () {
		await seedAndOpen(
			"CrossGrid.md",
			"A:\n\n```mica id=xg-1\nlead text\n\n:::grid {cols=1}\n:::cell\ncargo\n:::\n:::\n```\n\nB:\n\n```mica id=xg-2\ntab: Dock\ndock prose\n```\n",
		);
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-lp").length >= 2),
			{ timeout: 8000, timeoutMsg: "both blocks never rendered" },
		);
		await browser.executeObsidian(async () => {
			const wrap = document.querySelector(".mica-lp .mica-grid-wrap") as HTMLElement;
			const grip = wrap.querySelector(".mica-grid-tools .mica-region-grip") as HTMLElement;
			const dst = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("dock prose"),
			) as HTMLElement;
			const rw = wrap.getBoundingClientRect();
			const rd = dst.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rw.right - 10, rw.top + 8)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rw.left + 40, rw.top + 40)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rd.left + 40, rd.bottom + 2)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(rd.left + 40, rd.bottom + 2)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				const b2 = v.indexOf("id=xg-2");
				const grid = v.indexOf(":::grid");
				return grid > b2 && v.indexOf("cargo") > b2 && v.indexOf("lead text") < b2;
			},
			{ timeout: 8000, timeoutMsg: "the grid never crossed into the second block" },
		);
	});
});

describe("round 11: home-zone inertness", function () {
	it("a wiggle inside the item's own bounds never commits a move", async function () {
		const fixture =
			"Intro.\n\n```mica id=hz-1\ntab: Main\n> [!note] Alpha keeps its spot\n\n> [!tip] Beta below\n```\n";
		await seedAndOpen("HomeZone.md", fixture);
		await waitForSelector(".mica-lp .mica-region", 2);
		const before = await docContains("");
		const probe = await browser.executeObsidian(async () => {
			const region = Array.from(document.querySelectorAll(".mica-lp .mica-region")).find((r) =>
				r.textContent?.includes("Alpha"),
			) as HTMLElement;
			const grip = region.querySelector(".mica-region-grip") as HTMLElement;
			const rr = region.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rr.right - 10, rr.top + 6)));
			// Past the 5px threshold but well WITHIN the region's own bounds.
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.right - 24, rr.top + 14)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rr.left + rr.width / 2, rr.top + rr.height / 2)));
			await new Promise((r) => setTimeout(r, 30));
			const ind = document.querySelector(".mica-drop-indicator") as HTMLElement | null;
			const shown = Boolean(ind && ind.style.display !== "none");
			window.dispatchEvent(
				new PointerEvent("pointerup", opts(rr.left + rr.width / 2, rr.top + rr.height / 2)),
			);
			return { shown };
		});
		expect(probe.shown).toBe(false); // nothing promised inside the home zone
		await new Promise((r) => setTimeout(r, 400));
		const after = await docContains("");
		expect(after).toBe(before);
	});

	it("leaving the home zone re-arms the drop (the drag still works)", async function () {
		await seedAndOpen(
			"HomeZone2.md",
			"Intro.\n\n```mica id=hz-2\ntab: Main\n> [!note] Mover\n\n> [!tip] Anchor\n```\n",
		);
		await waitForSelector(".mica-lp .mica-region", 2);
		await browser.executeObsidian(async () => {
			const regions = Array.from(document.querySelectorAll(".mica-lp .mica-region")) as HTMLElement[];
			const mover = regions.find((r) => r.textContent?.includes("Mover")) as HTMLElement;
			const anchor = regions.find((r) => r.textContent?.includes("Anchor")) as HTMLElement;
			const grip = mover.querySelector(".mica-region-grip") as HTMLElement;
			const rm = mover.getBoundingClientRect();
			const ra = anchor.getBoundingClientRect();
			const opts = (x: number, y: number): PointerEventInit => ({
				bubbles: true,
				cancelable: true,
				clientX: x,
				clientY: y,
				button: 0,
				pointerId: 1,
			});
			grip.dispatchEvent(new PointerEvent("pointerdown", opts(rm.right - 10, rm.top + 6)));
			window.dispatchEvent(new PointerEvent("pointermove", opts(rm.left + 40, rm.top + 20)));
			await new Promise((r) => setTimeout(r, 30));
			// Leave home: below the anchor.
			window.dispatchEvent(new PointerEvent("pointermove", opts(ra.left + 40, ra.bottom + 4)));
			await new Promise((r) => setTimeout(r, 30));
			window.dispatchEvent(new PointerEvent("pointerup", opts(ra.left + 40, ra.bottom + 4)));
		});
		await browser.waitUntil(
			async () => {
				const v = await docContains("");
				return v.indexOf("[!tip] Anchor") < v.indexOf("[!note] Mover");
			},
			{ timeout: 8000, timeoutMsg: "leaving the home zone should still allow the move" },
		);
	});
});
