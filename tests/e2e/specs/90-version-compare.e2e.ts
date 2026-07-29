import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { clickLatestMenuItem, seedAndOpenNote } from "../helpers";

async function seedAndOpen(path: string, content: string): Promise<void> {
	await seedAndOpenNote(path, content, { overwriteExisting: true });
}

/** Scope every chip query to its own block. Each test seeds a fresh note, and
 * background leaves stay mounted, so an unscoped `.mica-lp .mica-chip` can match
 * a previous test's block and click something that opens nothing. */
async function waitForCleanChip(blockId: string): Promise<void> {
	await browser.waitUntil(
		() =>
			browser.executeObsidian((_, id) => {
				const chip = document.querySelector<HTMLButtonElement>(
					`.mica-lp[data-mica-block-id="${CSS.escape(id)}"] .mica-chip`,
				);
				return Boolean(chip && !chip.classList.contains("is-dirty"));
			}, blockId),
		{ timeout: 15_000, timeoutMsg: `the fixture block ${blockId} never settled` },
	);
}

async function openHistory(blockId: string): Promise<void> {
	await browser.executeObsidian((_, id) => {
		const chip = document.querySelector<HTMLButtonElement>(
			`.mica-lp[data-mica-block-id="${CSS.escape(id)}"] .mica-chip`,
		);
		if (!chip) throw new Error(`no version chip for block ${id}`);
		chip.click();
	}, blockId);
	await browser.waitUntil(
		() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-versions-modal"))),
		{ timeout: 10_000, timeoutMsg: `version history did not open for block ${blockId}` },
	);
}

async function closeHistory(): Promise<void> {
	await browser.executeObsidian(() => {
		(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null)?.click();
	});
	await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-versions-modal")), {
		timeout: 8000,
		timeoutMsg: "version history did not close",
	});
}

/** Toolbar controls are identified by their visible text, the same way a user finds them. */
async function clickToolbar(label: string): Promise<void> {
	await browser.executeObsidian((_, expected) => {
		const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-versions-toolbar button")).find(
			(candidate) => candidate.textContent?.trim() === expected,
		);
		if (!button) throw new Error(`no toolbar control named ${expected}`);
		button.click();
	}, label);
}

/**
 * Checkpoints are addressed by stable `versionId`, never by the `v{n}` label:
 * the label is a dense count of currently visible checkpoints, so any removal
 * renumbers every older row and a label-based test silently changes meaning.
 */
interface TimelineEntry {
	versionId: string;
	label: string;
	base: boolean;
	selected: boolean;
}

const timelineEntries = (): Promise<TimelineEntry[]> =>
	browser.executeObsidian(() =>
		Array.from(document.querySelectorAll<HTMLElement>(".mica-versions-list .mica-vrow[data-mica-version]")).map(
			(row) => ({
				versionId: row.dataset.micaVersion ?? "",
				label: row.querySelector(".mica-vrow-n")?.textContent?.trim() ?? "",
				base: row.classList.contains("is-base"),
				selected: row.classList.contains("is-selected"),
			}),
		),
	);

async function pickVersion(versionId: string): Promise<void> {
	await browser.executeObsidian((_, id) => {
		const box = document
			.querySelector<HTMLElement>(`.mica-vrow[data-mica-version="${CSS.escape(id)}"]`)
			?.querySelector<HTMLInputElement>(".mica-vrow-select");
		if (!box) throw new Error(`no checkbox for checkpoint ${id}`);
		box.click();
	}, versionId);
}

/** The first `count` checkpoints that are not the comparison base — picking the
 * base only reports it as the base, which is a different test. */
async function pickNonBaseVersions(count: number): Promise<string[]> {
	const entries = await timelineEntries();
	const chosen = entries.filter((entry) => !entry.base).slice(0, count);
	if (chosen.length < count) throw new Error(`only ${chosen.length} non-base checkpoints available, needed ${count}`);
	for (const entry of chosen) await pickVersion(entry.versionId);
	return chosen.map((entry) => entry.versionId);
}

/** Resolve a label to its stable id at the moment of use. Finding a row by its
 * visible label is fine; *acting* on it afterwards must go through the id, which
 * survives the renumbering any removal causes. */
async function versionIdByLabel(label: string): Promise<string> {
	const entry = (await timelineEntries()).find((candidate) => candidate.label === label);
	if (!entry) throw new Error(`no timeline row labelled ${label}`);
	return entry.versionId;
}

async function openVersionMenu(versionId: string): Promise<void> {
	await browser.executeObsidian((_, id) => {
		const row = document.querySelector<HTMLElement>(`.mica-vrow[data-mica-version="${CSS.escape(id)}"]`);
		if (!row) throw new Error(`no timeline row for ${id}`);
		row.querySelector<HTMLButtonElement>('[aria-label="Version actions"]')?.click();
	}, versionId);
}

const nUpHeads = (): Promise<string[]> =>
	browser.executeObsidian(() =>
		Array.from(document.querySelectorAll<HTMLElement>(".mica-diff-nup-head")).map(
			(head) => head.textContent?.trim() ?? "",
		),
	);

// A block's ledger lives in a sidecar that outlives the note body, so reusing
// one note would let checkpoints accumulate between tests and quietly change
// what every `v{n}` label refers to. Each test gets its own history.
let sequence = 0;
const freshFixture = (prefix: string): { note: string; id: string } => {
	sequence++;
	return { note: `${prefix}-${sequence}.md`, id: `${prefix}-${sequence}` };
};

describe("version history comparison", function () {
	describe("comparing several versions", function () {
		let note = "";
		let id = "";

		beforeEach(async function () {
			({ note, id } = freshFixture("multi-compare"));
			await seedAndOpen(note, `\`\`\`mica id=${id}\nalpha\n\`\`\`\n`);
			await browser.executeObsidian(
				async (_, path, blockId) => {
					await window.mica.versionsSnapshot(path);
					for (const body of ["bravo\n", "charlie\n", "delta\n", "echo\n", "foxtrot\n"])
						await window.mica.blockUpdate(path, blockId, body);
				},
				note,
				id,
			);
			await waitForCleanChip(id);
			await openHistory(id);
			// Layout is a remembered preference and therefore leaks across tests;
			// every assertion about the surface names the layout it expects.
			await clickToolbar("Inline");
		});

		afterEach(async function () {
			await closeHistory();
		});

		it("never renders the comparison base as one of its own columns", async function () {
			// Pick the base itself alongside two others: the base must stay the
			// base rather than appearing twice, once as an empty self-diff.
			const baseLabel = await browser.executeObsidian(
				() =>
					document
						.querySelector(".mica-vrow-rolebadge.is-base")
						?.closest(".mica-vrow")
						?.querySelector(".mica-vrow-n")?.textContent ?? "",
			);
			expect(baseLabel).toMatch(/^v\d+$/);
			await pickVersion(await versionIdByLabel(baseLabel));
			await pickVersion(await versionIdByLabel("v3"));
			await pickVersion(await versionIdByLabel("v2"));
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-diff-nup"))),
				{
					timeout: 8000,
					timeoutMsg: "several-version comparison never rendered",
				},
			);
			const heads = await nUpHeads();
			expect(heads[0]).toContain(`${baseLabel} (base)`);
			expect(heads.filter((head) => head.startsWith(baseLabel))).toHaveLength(1);
			expect(heads).toHaveLength(3);

			// Dropping it is reported, not silent.
			const droppedNote = await browser.executeObsidian(
				() => document.querySelector(".mica-comparison-note")?.textContent ?? "",
			);
			expect(droppedNote).toContain(baseLabel);
			expect(droppedNote).toContain("base");
		});

		it("honours every layout instead of only rendering one", async function () {
			await pickVersion(await versionIdByLabel("v3"));
			await pickVersion(await versionIdByLabel("v2"));
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-diff-nup"))),
				{
					timeout: 8000,
					timeoutMsg: "several-version comparison never rendered",
				},
			);

			await clickToolbar("Inline");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() =>
							Boolean(document.querySelector(".mica-diff-nup")) &&
							document.querySelectorAll(".mica-diff-nup-col .mica-diff-gutter").length > 0,
					),
				{ timeout: 8000, timeoutMsg: "Inline did not render unified-diff columns" },
			);

			await clickToolbar("Split");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() =>
							Boolean(document.querySelector(".mica-diff.is-sbs .mica-diff-nup")) &&
							document.querySelectorAll(".mica-diff-nup-col .mica-diff-gutter").length === 0,
					),
				{ timeout: 8000, timeoutMsg: "Split did not switch the columns to version content" },
			);

			await clickToolbar("Patch");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() =>
							!document.querySelector(".mica-diff-nup") &&
							document.querySelectorAll(".mica-diff-stack-item").length === 2,
					),
				{ timeout: 8000, timeoutMsg: "Patch did not stack one unified patch per version" },
			);
		});

		it("copies every displayed comparison, in display order", async function () {
			await pickVersion(await versionIdByLabel("v3"));
			await pickVersion(await versionIdByLabel("v2"));
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-diff-nup"))),
				{
					timeout: 8000,
					timeoutMsg: "several-version comparison never rendered",
				},
			);
			const displayed = (await nUpHeads()).slice(1);
			expect(displayed).toHaveLength(2);

			// Capture into a window slot and wait for it to appear, rather than
			// guessing how long the copy takes.
			await browser.executeObsidian(() => {
				const clipboard = navigator.clipboard as {
					writeText: (value: string) => Promise<void>;
					__micaOriginal?: (value: string) => Promise<void>;
				};
				clipboard.__micaOriginal ??= clipboard.writeText.bind(clipboard);
				(window as unknown as { __micaCopied: string | null }).__micaCopied = null;
				clipboard.writeText = (value: string): Promise<void> => {
					(window as unknown as { __micaCopied: string | null }).__micaCopied = value;
					return Promise.resolve();
				};
				Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-versions-toolbar button"))
					.find((candidate) => candidate.textContent?.trim().startsWith("Copy"))
					?.click();
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() => (window as unknown as { __micaCopied: string | null }).__micaCopied !== null,
					),
				{ timeout: 8000, timeoutMsg: "the copy never reached the clipboard" },
			);
			const copied = await browser.executeObsidian(() => {
				const clipboard = navigator.clipboard as {
					writeText: (value: string) => Promise<void>;
					__micaOriginal?: (value: string) => Promise<void>;
				};
				if (clipboard.__micaOriginal) clipboard.writeText = clipboard.__micaOriginal;
				return (window as unknown as { __micaCopied: string }).__micaCopied;
			});

			// The clipboard must describe the comparison on screen — this is the
			// case that used to silently copy an entirely different diff.
			const headings = copied.split("\n").filter((line) => line.startsWith("## "));
			expect(headings).toHaveLength(2);
			for (const [position, label] of displayed.entries()) expect(headings[position]).toContain(label);
			expect(copied).toContain("```diff");
		});

		it("keeps a version that leaves the timeline out of the comparison", async function () {
			// A dangling pick used to leave the surface loading a snapshot that
			// could never resolve, re-rendering itself indefinitely.
			await pickVersion(await versionIdByLabel("v3"));
			await pickVersion(await versionIdByLabel("v2"));
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-diff-nup"))),
				{
					timeout: 8000,
					timeoutMsg: "several-version comparison never rendered",
				},
			);
			await openVersionMenu(await versionIdByLabel("v2"));
			await clickLatestMenuItem("Remove from timeline");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() =>
							!document.querySelector(".mica-diff-caption")?.textContent?.includes("Loading") &&
							Boolean(
								document.querySelector(".mica-diff-nup") ||
								document.querySelector(".mica-diff-sbs") ||
								document.querySelector(".mica-diff-hunk"),
							),
					),
				{ timeout: 10_000, timeoutMsg: "removing a compared checkpoint left the surface stuck loading" },
			);
			const heads = await nUpHeads();
			expect(heads.some((head) => head.startsWith("v2 "))).toBe(false);
		});
	});

	describe("comparing individual elements", function () {
		let note = "";
		let id = "";
		const body = [
			":::tabs",
			":::tab Main",
			"```js",
			"first();",
			"```",
			"",
			"```ts",
			"second();",
			"```",
			"",
			"Trailing prose.",
			":::",
			":::",
			"",
		].join("\n");

		beforeEach(async function () {
			({ note, id } = freshFixture("element-compare"));
			await seedAndOpen(note, `\`\`\`\`mica id=${id}\n${body}\`\`\`\`\n`);
			await browser.executeObsidian(
				async (_, path, blockId, revisions) => {
					await window.mica.versionsSnapshot(path);
					for (const revision of revisions) await window.mica.blockUpdate(path, blockId, revision);
					await window.mica.versionsSnapshot(path);
				},
				note,
				id,
				[
					body.replace("second();", "second(changed);").replace("Trailing prose.", "Trailing prose, edited."),
					body.replace("first();", "first(changed);").replace("Trailing prose.", "Trailing prose, revised."),
				],
			);
			await waitForCleanChip(id);
			await openHistory(id);
			await clickToolbar("Inline");
			await clickToolbar("Inspect");
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-inspector-render"))),
				{ timeout: 10_000, timeoutMsg: "the inspector never rendered" },
			);
		});

		afterEach(async function () {
			await closeHistory();
		});

		it("names elements by location, type and ordinal rather than their content", async function () {
			await browser.executeObsidian(() => {
				const codes = document.querySelectorAll<HTMLElement>(
					'.mica-inspector-render [data-mica-inspect-key^="code:"]',
				);
				codes[0]?.click();
				codes[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() => document.querySelector(".mica-inspector-selection-count")?.textContent === "2 selected",
					),
				{ timeout: 8000, timeoutMsg: "Ctrl-click did not add a second element" },
			);
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"))
					.find((button) => button.textContent?.trim() === "Compare selected elements")
					?.click();
			});
			await browser.waitUntil(
				() => browser.executeObsidian(() => document.querySelectorAll(".mica-focused-row").length === 2),
				{ timeout: 8000, timeoutMsg: "element comparison did not render one row per element" },
			);
			const summaries = await browser.executeObsidian(() =>
				Array.from(document.querySelectorAll<HTMLElement>(".mica-focused-row-summary")).map(
					(summary) => summary.textContent?.trim() ?? "",
				),
			);
			expect(summaries).toHaveLength(2);
			// Two sibling code blocks in one tab must not read identically, and
			// must not be named after whatever their first line happens to say.
			expect(summaries[0]).not.toEqual(summaries[1]);
			for (const summary of summaries) {
				expect(summary).toContain("Main");
				expect(summary).toContain("Code block");
			}
			expect(summaries.join(" ")).toContain("1 of 2");
			expect(summaries.join(" ")).toContain("2 of 2");
		});

		it("labels every row before it is opened and keeps open rows open", async function () {
			await browser.executeObsidian(() => {
				const scopes = document.querySelectorAll<HTMLElement>(
					'.mica-inspector-render [data-mica-inspect-key^="code:"]',
				);
				scopes[0]?.click();
				scopes[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() => document.querySelector(".mica-inspector-selection-count")?.textContent === "2 selected",
					),
				{ timeout: 8000, timeoutMsg: "Ctrl-click did not add a second element" },
			);
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"))
					.find((button) => button.textContent?.trim() === "Compare selected elements")
					?.click();
			});
			await browser.waitUntil(
				() => browser.executeObsidian(() => document.querySelectorAll(".mica-focused-row").length === 2),
				{ timeout: 8000, timeoutMsg: "element comparison did not render one row per element" },
			);

			// A collapsed row still states what it is and how it changed.
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() =>
						Array.from(document.querySelectorAll<HTMLElement>(".mica-focused-row-status")).every(
							(status) => (status.textContent?.trim().length ?? 0) > 0,
						),
					),
				{ timeout: 10_000, timeoutMsg: "a collapsed element row never acquired a status" },
			);

			// Opening the second row must leave the first alone: the surface
			// rebuild that follows a lineage resolve used to collapse everything.
			await browser.executeObsidian(() => {
				const rows = document.querySelectorAll<HTMLDetailsElement>(".mica-focused-row");
				rows[1]?.querySelector<HTMLElement>("summary")?.click();
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() => {
						const rows = Array.from(document.querySelectorAll<HTMLDetailsElement>(".mica-focused-row"));
						return rows.length === 2 && rows[0].open && rows[1].open;
					}),
				{ timeout: 10_000, timeoutMsg: "opening a second element row collapsed the first" },
			);
			// Force a genuine rebuild rather than waiting to see whether one
			// happens: changing Layout re-renders the whole surface, which is
			// exactly what used to collapse every row.
			await clickToolbar("Split");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() => {
						const rows = Array.from(document.querySelectorAll<HTMLDetailsElement>(".mica-focused-row"));
						return rows.length === 2 && rows.every((row) => row.open);
					}),
				{ timeout: 10_000, timeoutMsg: "a surface rebuild collapsed the open element rows" },
			);
			// An open row carries content — a diff, or the picker that asks which
			// counterpart it is — never an empty body.
			expect(
				await browser.executeObsidian(() =>
					Array.from(
						document.querySelectorAll<HTMLElement>(".mica-focused-row[open] .mica-focused-row-body"),
					).map((body) => body.childElementCount > 0),
				),
			).toEqual([true, true]);
			// Closing one is equally durable — a rebuild must not reopen it.
			await browser.executeObsidian(() => {
				document
					.querySelectorAll<HTMLDetailsElement>(".mica-focused-row")[0]
					?.querySelector("summary")
					?.click();
			});
			await clickToolbar("Inline");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() => {
						const rows = Array.from(document.querySelectorAll<HTMLDetailsElement>(".mica-focused-row"));
						return rows.length === 2 && !rows[0].open && rows[1].open;
					}),
				{ timeout: 10_000, timeoutMsg: "a surface rebuild reopened a row the user had closed" },
			);
		});

		it("offers one control that exits the whole element comparison", async function () {
			await browser.executeObsidian(() => {
				document.querySelector<HTMLElement>('.mica-inspector-render [data-mica-inspect-key^="code:"]')?.click();
			});
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"))
					.find((button) => button.textContent?.trim()?.startsWith("Compare selected element"))
					?.click();
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() =>
						Boolean(
							document.querySelector(".mica-comparison-bar") ||
							document.querySelector(".mica-focused-header"),
						),
					),
				{ timeout: 8000, timeoutMsg: "element comparison never announced itself" },
			);
			// Escape belongs to Obsidian — it closes the window, as it does
			// everywhere else in the app. Leaving a comparison is an explicit
			// control, so it never costs the whole window by accident.
			await browser.executeObsidian(() => {
				const exit = Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-versions-surface button"))
					.concat(Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-comparison-bar button")))
					.find((button) => /exit element comparison|elements? ✕/i.test(button.textContent ?? ""));
				if (!exit) throw new Error("no control offered a way out of the element comparison");
				exit.click();
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() =>
							Boolean(document.querySelector(".mica-versions-modal")) &&
							!document.querySelector(".mica-focused-row") &&
							!document.querySelector(".mica-comparison-bar"),
					),
				{ timeout: 8000, timeoutMsg: "exiting the element comparison did not return to the whole-block diff" },
			);
		});

		it("compares one element across several versions at once", async function () {
			await browser.executeObsidian(() => {
				document.querySelector<HTMLElement>('.mica-inspector-render [data-mica-inspect-key^="code:"]')?.click();
			});
			await browser.executeObsidian(() => {
				Array.from(document.querySelectorAll<HTMLButtonElement>(".mica-inspector-footer button"))
					.find((button) => button.textContent?.trim()?.startsWith("Compare selected element"))
					?.click();
			});
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-focused-row"))),
				{ timeout: 8000, timeoutMsg: "element comparison never rendered" },
			);
			// Picking versions used to silently suppress the element comparison.
			// Two non-base checkpoints give the row two columns to span.
			const targets = await pickNonBaseVersions(2);
			expect(targets).toHaveLength(2);
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() => {
						const summary = document.querySelector(".mica-comparison-summary")?.textContent ?? "";
						return (
							summary.includes("Code block") &&
							document.querySelectorAll(".mica-focused-cell").length >= 2
						);
					}),
				{
					timeout: 10_000,
					timeoutMsg: "element focus and several-version compare did not compose",
				},
			);
			// Every cell names the pair it shows, so a column can be told from
			// its neighbour without counting.
			const captions = await browser.executeObsidian(() =>
				Array.from(document.querySelectorAll<HTMLElement>(".mica-focused-cell-title")).map(
					(caption) => caption.textContent?.trim() ?? "",
				),
			);
			expect(captions).toHaveLength(2);
			expect(new Set(captions).size).toBe(2);
			for (const caption of captions) expect(caption).toMatch(/ → /);
		});
	});

	describe("checkpoint actions", function () {
		let note = "";
		let id = "";

		beforeEach(async function () {
			({ note, id } = freshFixture("version-actions"));
			await seedAndOpen(note, `\`\`\`mica id=${id}\nfirst\n\`\`\`\n`);
			await browser.executeObsidian(
				async (_, path, blockId) => {
					await window.mica.versionsSnapshot(path);
					await window.mica.blockUpdate(path, blockId, "second\n");
					await window.mica.blockUpdate(path, blockId, "third\n");
				},
				note,
				id,
			);
			await waitForCleanChip(id);
			await openHistory(id);
			await clickToolbar("Inline");
		});

		it("adds and edits a label from the row menu", async function () {
			await openVersionMenu(await versionIdByLabel("v2"));
			await clickLatestMenuItem("Add label…");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() =>
						Boolean(document.querySelector('.mica-version-label-modal input[aria-label="Version label"]')),
					),
				{ timeout: 8000, timeoutMsg: "the label prompt never opened" },
			);
			await browser.executeObsidian(() => {
				const modal = document.querySelector<HTMLElement>(".mica-version-label-modal")!;
				const input = modal.querySelector<HTMLInputElement>('input[aria-label="Version label"]')!;
				input.value = "milestone";
				input.dispatchEvent(new Event("input", { bubbles: true }));
				Array.from(modal.querySelectorAll<HTMLButtonElement>("button"))
					.find((button) => button.textContent?.trim() === "Save label")
					?.click();
			});
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						async (_, path, blockId) => {
							const versions = await window.mica.versionsList(path, blockId);
							return versions.some((version) => version.label === "milestone");
						},
						note,
						id,
					),
				{ timeout: 10_000, timeoutMsg: "the label was never persisted" },
			);
			// The menu reflects that a label now exists.
			await openVersionMenu(await versionIdByLabel("v2"));
			expect(
				await browser.executeObsidian(() =>
					Array.from(document.querySelectorAll<HTMLElement>("body > .menu .menu-item-title")).map(
						(item) => item.textContent?.trim() ?? "",
					),
				),
			).toContain("Edit label…");
			await browser.keys([Key.Escape]);
		});

		it("pins a comparison base from the row menu and keeps it out of the columns", async function () {
			await openVersionMenu(await versionIdByLabel("v1"));
			await clickLatestMenuItem("Use as diff base");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() =>
						(document.querySelector(".mica-base-pick")?.textContent ?? "").includes("v1 · pinned"),
					),
				{ timeout: 8000, timeoutMsg: "the row menu did not pin the comparison base" },
			);
			await pickVersion(await versionIdByLabel("v1"));
			await pickVersion(await versionIdByLabel("v3"));
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() =>
						(document.querySelector(".mica-comparison-note")?.textContent ?? "").includes("v1"),
					),
				{ timeout: 8000, timeoutMsg: "picking the pinned base was not reported" },
			);
			expect((await nUpHeads()).filter((head) => head.startsWith("v1"))).toHaveLength(1);
		});

		it("restores a checkpoint as a new checkpoint without rewriting history", async function () {
			const before = await browser.executeObsidian(
				async (_, path, blockId) => (await window.mica.versionsList(path, blockId)).length,
				note,
				id,
			);
			await openVersionMenu(await versionIdByLabel("v1"));
			await clickLatestMenuItem("Restore as new checkpoint");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						async (_, path, blockId, previous) => {
							const versions = await window.mica.versionsList(path, blockId);
							return versions.length === previous + 1;
						},
						note,
						id,
						before,
					),
				{ timeout: 12_000, timeoutMsg: "restore did not append a new checkpoint" },
			);
			const content = await browser.executeObsidian(
				(_, path, blockId) => window.mica.blockRead(path, blockId),
				note,
				id,
			);
			expect(content).toContain("first");
		});

		it("moves HEAD from the row menu so later saves branch from there", async function () {
			// v1 is the oldest visible checkpoint; capture its id so the parent
			// assertion names an actual checkpoint rather than "something".
			const oldest = await browser.executeObsidian(
				async (_, path, blockId) => {
					const versions = await window.mica.versionsList(path, blockId);
					return versions[0].versionId;
				},
				note,
				id,
			);
			await openVersionMenu(await versionIdByLabel("v1"));
			await clickLatestMenuItem("Reset HEAD here");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(
						() => document.querySelector(".mica-vrow.is-head .mica-vrow-n")?.textContent?.trim() === "v1",
					),
				{ timeout: 12_000, timeoutMsg: "HEAD did not move to the chosen checkpoint" },
			);
			await closeHistory();
			await browser.executeObsidian(
				async (_, path, blockId) => {
					await window.mica.blockUpdate(path, blockId, "branched\n");
					await window.mica.versionsSnapshot(path);
				},
				note,
				id,
			);
			const branched = await browser.executeObsidian(
				async (_, path, blockId) => {
					const versions = await window.mica.versionsList(path, blockId);
					return versions.at(-1) ?? null;
				},
				note,
				id,
			);
			// The checkpoint saved after the reset descends from the reset point,
			// not from whatever was head beforehand.
			expect(branched?.effectiveParentVersionId).toBe(oldest);
			await openHistory(id);
		});

		it("copies a checkpoint's content from the row menu", async function () {
			await browser.executeObsidian(() => {
				const clipboard = navigator.clipboard as {
					writeText(value: string): Promise<void>;
					__micaOriginal?: (value: string) => Promise<void>;
				};
				clipboard.__micaOriginal = clipboard.writeText.bind(clipboard);
				(window as unknown as { __micaCopied: string }).__micaCopied = "";
				clipboard.writeText = (value: string): Promise<void> => {
					(window as unknown as { __micaCopied: string }).__micaCopied = value;
					return Promise.resolve();
				};
			});
			await openVersionMenu(await versionIdByLabel("v1"));
			await clickLatestMenuItem("Copy content");
			await browser.waitUntil(
				() =>
					browser.executeObsidian(() =>
						(window as unknown as { __micaCopied: string }).__micaCopied.includes("first"),
					),
				{ timeout: 8000, timeoutMsg: "Copy content never reached the clipboard" },
			);
			await browser.executeObsidian(() => {
				const clipboard = navigator.clipboard as {
					writeText: (value: string) => Promise<void>;
					__micaOriginal?: (value: string) => Promise<void>;
				};
				if (clipboard.__micaOriginal) clipboard.writeText = clipboard.__micaOriginal;
			});
		});

		it("removes a checkpoint from the row menu and restores it from its gap", async function () {
			await openVersionMenu(await versionIdByLabel("v2"));
			await clickLatestMenuItem("Remove from timeline");
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector("button.mica-vrow-gap"))),
				{ timeout: 10_000, timeoutMsg: "removing a checkpoint left no chronological gap" },
			);
			await browser.executeObsidian(() => {
				document.querySelector<HTMLButtonElement>("button.mica-vrow-gap")?.click();
			});
			await browser.waitUntil(
				() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-vrow.is-removed"))),
				{ timeout: 8000, timeoutMsg: "the gap did not reveal the removed checkpoint in place" },
			);
			await browser.executeObsidian(() => {
				const row = document.querySelector<HTMLElement>(".mica-vrow.is-removed");
				row?.querySelector<HTMLButtonElement>('[aria-label="Version actions"]')?.click();
			});
			await clickLatestMenuItem("Restore to timeline");
			await browser.waitUntil(
				() => browser.executeObsidian(() => !document.querySelector(".mica-vrow.is-removed")),
				{ timeout: 10_000, timeoutMsg: "restoring from the row menu did not return the checkpoint" },
			);
		});

		afterEach(async function () {
			await browser.executeObsidian(() => {
				(
					document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null
				)?.click();
			});
		});
	});
});
