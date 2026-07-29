import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { clickLatestMenuItem, seedAndOpenNote } from "../helpers";

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
	// The window animates in. Measuring anything before it settles reports the
	// transition rather than the layout, so wait for its geometry to hold.
	let previous = -1;
	await browser.waitUntil(
		async () => {
			const height = await browser.executeObsidian(() =>
				Math.round(document.querySelector(".mica-versions-modal")?.getBoundingClientRect().height ?? 0),
			);
			const settled = height > 0 && height === previous;
			previous = height;
			return settled;
		},
		{ timeout: 10_000, timeoutMsg: "the version history window never settled at a stable size" },
	);
}

/**
 * Timeline behaviour, driven the way a user drives it and asserted against
 * stable identities.
 *
 * Two rules keep this suite from rotting:
 *
 * 1. Checkpoints are addressed by `versionId`, never by the `v{n}` label. The
 *    label is a dense count of *currently visible* checkpoints, so removing one
 *    renumbers every older row — a test that says "click v2" is asserting
 *    something different before and after any removal.
 * 2. Every wait is on an observable end state read through `timeline()`. There
 *    are no fixed pauses, so the suite neither flakes on a slow machine nor
 *    passes by luck on a fast one.
 */

interface TimelineRowView {
	versionId: string;
	label: string;
	removed: boolean;
	head: boolean;
	base: boolean;
	selected: boolean;
	checked: boolean;
}

interface TimelineView {
	rows: TimelineRowView[];
	working: { present: boolean; selected: boolean; hasCheckbox: boolean };
	count: string;
	bulk: string[];
	bulkText: string[];
	rowTops: { versionId: string; top: number; labelLeft: number; overflows: boolean }[];
	removedToggle: string | null;
	gap: string | null;
}

/** One structured read of the whole timeline. Assertions compare values, so a
 * failure reports what the timeline actually looked like. */
function timeline(): Promise<TimelineView> {
	return browser.executeObsidian(() => {
		const list = document.querySelector<HTMLElement>(".mica-versions-list");
		const workingRow = list?.querySelector<HTMLElement>(".mica-vrow.is-working") ?? null;
		return {
			rows: Array.from(list?.querySelectorAll<HTMLElement>(".mica-vrow[data-mica-version]") ?? []).map((row) => ({
				versionId: row.dataset.micaVersion ?? "",
				label: row.querySelector(".mica-vrow-n")?.textContent?.trim() ?? "",
				removed: row.classList.contains("is-removed"),
				head: row.classList.contains("is-head"),
				base: row.classList.contains("is-base"),
				selected: row.classList.contains("is-selected"),
				checked: Boolean(row.querySelector<HTMLInputElement>(".mica-vrow-select")?.checked),
			})),
			working: {
				present: Boolean(workingRow),
				selected: Boolean(workingRow?.classList.contains("is-selected")),
				hasCheckbox: Boolean(workingRow?.querySelector(".mica-vrow-select")),
			},
			count: list?.querySelector(".mica-version-selection-count")?.textContent?.trim() ?? "",
			bulk: Array.from(list?.querySelectorAll<HTMLElement>(".mica-version-bulk-actions [data-mica-action]") ?? [])
				.map((button) => button.dataset.micaAction ?? "")
				.sort(),
			bulkText: Array.from(
				list?.querySelectorAll<HTMLElement>(".mica-version-bulk-actions [data-mica-action]") ?? [],
			).map((button) => button.textContent?.trim() ?? ""),
			rowTops: Array.from(list?.querySelectorAll<HTMLElement>(".mica-vrow[data-mica-version]") ?? []).map(
				(row) => ({
					versionId: row.dataset.micaVersion ?? "",
					top: Math.round(row.getBoundingClientRect().top),
					labelLeft: Math.round(
						row.querySelector<HTMLElement>(".mica-vrow-n")?.getBoundingClientRect().left ?? 0,
					),
					overflows:
						row.getBoundingClientRect().right >
						(list?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY) + 1,
				}),
			),
			removedToggle:
				list?.querySelector<HTMLElement>('[data-mica-action="toggle-removed"]')?.textContent?.trim() ?? null,
			gap: list?.querySelector<HTMLElement>('[data-mica-action="reveal-removed"]')?.textContent?.trim() ?? null,
		};
	});
}

async function waitForTimeline(
	predicate: (view: TimelineView) => boolean,
	message: string,
	timeout = 10_000,
): Promise<TimelineView> {
	let last: TimelineView | null = null;
	await browser.waitUntil(
		async () => {
			last = await timeline();
			return predicate(last);
		},
		{ timeout, timeoutMsg: () => `${message}\nlast observed timeline: ${JSON.stringify(last, null, 2)}` },
	);
	return last!;
}

/** Activate a checkpoint's checkbox by stable id, optionally with modifiers. */
async function check(versionId: string, modifiers: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
	await browser.executeObsidian(
		(_, id, shiftKey, ctrlKey) => {
			const box = document
				.querySelector<HTMLElement>(`.mica-vrow[data-mica-version="${CSS.escape(id)}"]`)
				?.querySelector<HTMLInputElement>(".mica-vrow-select");
			if (!box) throw new Error(`no checkbox for checkpoint ${id}`);
			box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey, ctrlKey }));
		},
		versionId,
		Boolean(modifiers.shift),
		Boolean(modifiers.ctrl),
	);
}

async function clickAction(action: string): Promise<void> {
	await browser.executeObsidian((_, name) => {
		const button = document.querySelector<HTMLButtonElement>(`.mica-versions-list [data-mica-action="${name}"]`);
		if (!button) throw new Error(`no timeline control for ${name}`);
		button.click();
	}, action);
}

async function openRowMenu(versionId: string): Promise<void> {
	await browser.executeObsidian((_, id) => {
		const row = document.querySelector<HTMLElement>(`.mica-vrow[data-mica-version="${CSS.escape(id)}"]`);
		if (!row) throw new Error(`no timeline row for ${id}`);
		row.querySelector<HTMLButtonElement>('[aria-label="Version actions"]')?.click();
	}, versionId);
}

const ledger = (note: string, id: string): Promise<{ versionId: string; label: string | null }[]> =>
	browser.executeObsidian(
		async (_, path, blockId) =>
			(await window.mica.versionsList(path, blockId)).map((version) => ({
				versionId: version.versionId,
				label: version.label,
			})),
		note,
		id,
	);

describe("version timeline", function () {
	// A block's ledger lives in a sidecar that outlives the note body, so
	// rewriting the same note would let checkpoints accumulate across tests and
	// silently change what every ordinal means. Each test gets its own history.
	let sequence = 0;
	let note = "";
	let id = "";
	let ids: string[] = [];

	beforeEach(async function () {
		sequence++;
		note = `Timeline-${sequence}.md`;
		id = `timeline-${sequence}`;
		await seedAndOpenNote(note, `\`\`\`mica id=${id}\nfirst\n\`\`\`\n`, { overwriteExisting: true });
		await browser.executeObsidian(
			async (_, path, blockId) => {
				await window.mica.versionsSnapshot(path);
				for (const body of ["second\n", "third\n", "fourth\n", "fifth\n"])
					await window.mica.blockUpdate(path, blockId, body);
			},
			note,
			id,
		);
		ids = (await ledger(note, id)).map((version) => version.versionId);
		expect(ids).toHaveLength(5);
		await waitForCleanChip(id);
		await openHistory(id);
		await waitForTimeline((view) => view.rows.length === 5, "version history did not open with every checkpoint");
	});

	afterEach(async function () {
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null)?.click();
		});
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-versions-modal")), {
			timeout: 8000,
			timeoutMsg: "version history did not close",
		});
	});

	it("shows every checkpoint newest-first with selection available and no mode to enter", async function () {
		const view = await timeline();
		expect(view.rows.map((row) => row.versionId)).toEqual([...ids].reverse());
		expect(view.rows.map((row) => row.label)).toEqual(["v5", "v4", "v3", "v2", "v1"]);
		expect(view.rows.every((row) => !row.checked)).toBe(true);
		expect(view.count).toBe("Select checkpoints to compare");
		// Bulk actions stay out of the way until there is something to act on.
		expect(view.bulk).toEqual([]);
		expect(view.removedToggle).toBeNull();
		expect(view.gap).toBeNull();
	});

	it("marks head, base and selected roles simultaneously without losing any", async function () {
		const view = await timeline();
		const head = view.rows.filter((row) => row.head);
		const base = view.rows.filter((row) => row.base);
		const selected = view.rows.filter((row) => row.selected);
		expect(head).toHaveLength(1);
		expect(head[0].versionId).toBe(ids.at(-1));
		expect(base).toHaveLength(1);
		expect(selected).toHaveLength(1);
		// A row can hold several roles at once; the head is the selected version
		// on open, and its parent is the base.
		expect(selected[0].versionId).toBe(head[0].versionId);
		expect(base[0].versionId).not.toBe(head[0].versionId);
		expect(view.working.present).toBe(false);
	});

	it("selects a contiguous run with Shift and extends it with Ctrl", async function () {
		await check(ids[4]);
		await waitForTimeline(
			(view) => view.rows.filter((row) => row.checked).length === 1,
			"the first pick never took",
		);

		await check(ids[2], { shift: true });
		let view = await waitForTimeline(
			(current) => current.rows.filter((row) => row.checked).length === 3,
			"Shift did not span the run between the anchor and the target",
		);
		expect(view.rows.filter((row) => row.checked).map((row) => row.versionId)).toEqual([ids[4], ids[3], ids[2]]);

		// Shift alone replaces; Shift with Ctrl extends.
		await check(ids[0], { shift: true, ctrl: true });
		view = await waitForTimeline(
			(current) => current.rows.filter((row) => row.checked).length === 5,
			"Ctrl with Shift did not extend the existing run",
		);
		await check(ids[1], { shift: true });
		view = await waitForTimeline(
			(current) => current.rows.filter((row) => row.checked).length === 2,
			"Shift without Ctrl did not replace the selection",
		);
		expect(view.rows.filter((row) => row.checked).map((row) => row.versionId)).toEqual([ids[1], ids[0]]);
	});

	it("keeps the working copy out of the picked set", async function () {
		// Edit the note directly: going through `blockUpdate` checkpoints the
		// change, which is precisely what leaves no dirty working copy behind.
		await browser.executeObsidian(async ({ app, obsidian }, path) => {
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof obsidian.TFile)) throw new Error(`not a file: ${path}`);
			await app.vault.modify(file, (await app.vault.read(file)).replace("fifth", "unsaved edit"));
		}, note);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null)?.click();
		});
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-versions-modal")), {
			timeout: 8000,
			timeoutMsg: "version history did not close before reopening",
		});
		await openHistory(id);
		const view = await waitForTimeline(
			(current) => current.working.present,
			"the dirty working copy never appeared",
		);
		// It has no checkpoint identity, so it can hold a role but never a
		// checkbox — selecting it for removal would be meaningless.
		expect(view.working.hasCheckbox).toBe(false);
		expect(view.working.selected).toBe(true);
		expect(view.rows).toHaveLength(5);
		expect(view.rows.every((row) => !row.checked)).toBe(true);
	});

	it("removes selected checkpoints and restores them, addressing them by stable id", async function () {
		await check(ids[1]);
		await check(ids[3]);
		let view = await waitForTimeline(
			(current) => current.bulk.includes("remove-selected"),
			"selecting checkpoints did not offer a bulk removal",
		);
		expect(view.count).toBe("2 selected");
		expect(view.bulk).toEqual(["clear-selection", "remove-selected"]);

		await clickAction("remove-selected");
		view = await waitForTimeline((current) => current.rows.length === 3, "removal did not leave the timeline");
		expect(view.rows.map((row) => row.versionId)).toEqual([ids[4], ids[2], ids[0]]);
		// The remaining checkpoints renumber densely — which is exactly why the
		// rest of this suite never addresses them by label.
		expect(view.rows.map((row) => row.label)).toEqual(["v3", "v2", "v1"]);
		expect(view.removedToggle).toBe("Removed · 2");
		expect(view.gap).toContain("1 removed checkpoint");
		expect(await ledger(note, id)).toHaveLength(3);

		await clickAction("reveal-removed");
		view = await waitForTimeline(
			(current) => current.rows.length === 5,
			"revealing removed checkpoints did not restore the full list",
		);
		// Removed checkpoints sit in their chronological slots, not in a bucket.
		expect(view.rows.map((row) => row.versionId)).toEqual([...ids].reverse());
		expect(view.rows.map((row) => row.removed)).toEqual([false, true, false, true, false]);

		await check(ids[1]);
		await check(ids[3]);
		view = await waitForTimeline(
			(current) => current.bulk.includes("restore-selected"),
			"selecting removed checkpoints did not offer a restore",
		);
		expect(view.bulk).toEqual(["clear-selection", "restore-selected"]);
		await clickAction("restore-selected");
		await waitForTimeline(
			(current) => current.rows.every((row) => !row.removed) && current.rows.length === 5,
			"restoring did not return the checkpoints to the timeline",
		);
		expect((await ledger(note, id)).map((version) => version.versionId)).toEqual(ids);
	});

	it("offers remove and restore together when the selection mixes both", async function () {
		await check(ids[1]);
		await waitForTimeline((view) => view.bulk.includes("remove-selected"), "no bulk removal offered");
		await clickAction("remove-selected");
		await waitForTimeline((view) => view.rows.length === 4, "removal did not take");
		await clickAction("reveal-removed");
		await waitForTimeline((view) => view.rows.length === 5, "removed checkpoint was not revealed");

		await check(ids[1]);
		await check(ids[2]);
		const view = await waitForTimeline(
			(current) => current.bulk.length === 3,
			"a mixed selection did not offer both bulk actions",
		);
		expect(view.bulk).toEqual(["clear-selection", "remove-selected", "restore-selected"]);
		expect(view.count).toBe("2 selected");
	});

	it("keeps a removed checkpoint selectable but never comparable", async function () {
		await check(ids[1]);
		await check(ids[2]);
		await waitForTimeline((view) => view.count === "2 selected", "two checkpoints were never selected");

		await openRowMenu(ids[1]);
		await clickLatestMenuItem("Remove from timeline");
		const view = await waitForTimeline(
			(current) => current.rows.length === 4,
			"the checkpoint never left the timeline",
		);
		// It stays selected so restore can reach it without hunting for it
		// again, and the bulk bar offers exactly that.
		expect(view.count).toBe("2 selected");
		expect(view.bulk).toEqual(["clear-selection", "remove-selected", "restore-selected"]);

		// But a checkpoint that has left the timeline has no snapshot, so it must
		// never become a comparison column. Holding one used to leave the surface
		// loading a version that could never resolve, re-rendering forever.
		// Loading a snapshot is legitimately asynchronous, so "Loading…" is a
		// normal intermediate state. The defect this guards against is being
		// *stuck* there: a dangling pick used to re-enter loading forever.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					() =>
						!(
							document.querySelector(".mica-versions-surface .mica-diff-caption")?.textContent ?? ""
						).includes("Loading"),
				),
			{ timeout: 10_000, timeoutMsg: "the comparison surface never stopped loading after a removal" },
		);
		const columns = await browser.executeObsidian(() =>
			Array.from(document.querySelectorAll<HTMLElement>(".mica-diff-nup-head")).map(
				(head) => head.textContent?.trim() ?? "",
			),
		);
		expect(columns.length).toBeLessThanOrEqual(2);

		await clickAction("restore-selected");
		await waitForTimeline(
			(current) => current.rows.length === 5 && current.rows.every((row) => !row.removed),
			"restoring the selection did not return the checkpoint",
		);
	});

	it("names what a bulk action acts on, not just how many", async function () {
		await check(ids[1]);
		const view = await waitForTimeline(
			(current) => current.bulk.includes("remove-selected"),
			"no bulk removal was offered",
		);
		// "Remove 1" sitting beside a comparison selection reads as "clear 1".
		// A destructive control states its object.
		expect(view.bulkText).toContain("Remove 1 from timeline");
		expect(view.bulkText).toContain("Clear");
	});

	it("does not move the rows under the pointer when a checkpoint is selected", async function () {
		const before = await timeline();
		await check(ids[3]);
		const after = await waitForTimeline((current) => current.count === "1 selected", "the pick never registered");
		// Selecting reveals the bulk actions and the comparison bar. If that
		// shifted the rows, the next click in a multi-select would land on the
		// wrong checkpoint.
		expect(after.rowTops.map((row) => [row.versionId, row.top])).toEqual(
			before.rowTops.map((row) => [row.versionId, row.top]),
		);
	});

	it("keeps every version label on the same left edge, badges or not", async function () {
		const view = await timeline();
		const withRole = view.rows.filter((row) => row.base || row.selected || row.head);
		expect(withRole.length).toBeGreaterThan(0);
		expect(withRole.length).toBeLessThan(view.rows.length);
		// Roles trail the label, so a badge can never indent the row that has
		// one — nor can an empty reserved column indent the rows that do not.
		expect(new Set(view.rowTops.map((row) => row.labelLeft)).size).toBe(1);
	});

	it("keeps a long checkpoint label inside the timeline", async function () {
		await browser.executeObsidian(
			async (_, path, blockId, hash) => {
				await window.mica.versionsLabel(
					path,
					blockId,
					hash,
					"a deliberately long checkpoint label for wrapping",
				);
			},
			note,
			id,
			(await browser.executeObsidian(
				async (_, path, blockId) => (await window.mica.versionsList(path, blockId))[2].hash,
				note,
				id,
			)) as string,
		);
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null)?.click();
		});
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-versions-modal")), {
			timeout: 8000,
			timeoutMsg: "version history did not close before reopening",
		});
		await openHistory(id);
		const view = await waitForTimeline(
			(current) => current.rows.length === 5,
			"the labelled timeline never reopened",
		);
		expect(view.rowTops.some((row) => row.overflows)).toBe(false);
		expect(new Set(view.rowTops.map((row) => row.labelLeft)).size).toBe(1);
	});

	it("exposes revealing removed checkpoints as a real, named, keyboard-reachable control", async function () {
		await check(ids[1]);
		await waitForTimeline((view) => view.bulk.includes("remove-selected"), "no bulk removal offered");
		await clickAction("remove-selected");
		await waitForTimeline((view) => Boolean(view.gap), "removal left no chronological gap");

		const affordance = await browser.executeObsidian(() => {
			const gap = document.querySelector<HTMLElement>('[data-mica-action="reveal-removed"]');
			if (!gap) return null;
			return {
				tag: gap.tagName,
				type: gap.getAttribute("type"),
				name: gap.textContent?.trim() ?? "",
				focusable: gap.tabIndex >= 0,
			};
		});
		// A divider that reveals hidden checkpoints has to be operable, not just
		// clickable-if-you-guess.
		expect(affordance).toMatchObject({ tag: "BUTTON", type: "button", focusable: true });
		expect(affordance?.name).toContain("removed checkpoint");

		await browser.executeObsidian(() => {
			document.querySelector<HTMLElement>('[data-mica-action="reveal-removed"]')?.focus();
		});
		await browser.keys([Key.Enter]);
		await waitForTimeline(
			(view) => view.rows.some((row) => row.removed),
			"the reveal control could not be operated from the keyboard",
		);
	});

	it("clears the selection without touching the timeline", async function () {
		await check(ids[0]);
		await check(ids[1]);
		await waitForTimeline((view) => view.count === "2 selected", "two checkpoints were never selected");
		await clickAction("clear-selection");
		const view = await waitForTimeline(
			(current) => current.bulk.length === 0,
			"clearing did not retire the bulk actions",
		);
		expect(view.count).toBe("Select checkpoints to compare");
		expect(view.rows).toHaveLength(5);
		expect(await ledger(note, id)).toHaveLength(5);
	});

	it("keeps the checkbox reachable from the keyboard and off the row's own activation", async function () {
		const selectedBefore = (await timeline()).rows.find((row) => row.selected)?.versionId;
		await browser.executeObsidian((_, target) => {
			const box = document
				.querySelector<HTMLElement>(`.mica-vrow[data-mica-version="${CSS.escape(target)}"]`)
				?.querySelector<HTMLInputElement>(".mica-vrow-select");
			if (!box) throw new Error("no checkbox to focus");
			box.focus();
		}, ids[0]);
		expect(
			await browser.executeObsidian(() => document.activeElement?.classList.contains("mica-vrow-select")),
		).toBe(true);
		await browser.keys([" "]);
		const view = await waitForTimeline(
			(current) => current.rows.some((row) => row.checked),
			"Space on a focused checkbox did not select the checkpoint",
		);
		expect(view.rows.filter((row) => row.checked).map((row) => row.versionId)).toEqual([ids[0]]);
		// Selecting for a bulk action must not also change which version the
		// diff is showing — the checkbox sits inside a clickable row.
		expect(view.rows.find((row) => row.selected)?.versionId).toBe(selectedBefore);
	});

	it("survives a labelled checkpoint being renamed underneath it", async function () {
		await check(ids[2]);
		await waitForTimeline((view) => view.count === "1 selected", "the checkpoint was never selected");
		await openRowMenu(ids[2]);
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
			input.value = "checkpoint alpha";
			input.dispatchEvent(new Event("input", { bubbles: true }));
			Array.from(modal.querySelectorAll<HTMLButtonElement>("button"))
				.find((button) => button.textContent?.trim() === "Save label")
				?.click();
		});
		await browser.waitUntil(
			async () => (await ledger(note, id)).some((version) => version.label === "checkpoint alpha"),
			{ timeout: 10_000, timeoutMsg: "the label was never persisted" },
		);
		// A reload rebuilds every row; the selection is keyed by identity, so it
		// must survive one.
		const view = await waitForTimeline(
			(current) => current.rows.length === 5,
			"the timeline did not settle after labelling",
		);
		expect(view.rows.filter((row) => row.checked).map((row) => row.versionId)).toEqual([ids[2]]);
	});
});
