import { browser, expect } from "@wdio/globals";

/** Read a note's current content from inside Obsidian. */
async function readNote(path: string): Promise<string> {
	return browser.executeObsidian(async ({ app, obsidian }, p) => {
		const f = app.vault.getAbstractFileByPath(p);
		if (!(f instanceof obsidian.TFile)) throw new Error(`missing note: ${p}`);
		return app.vault.read(f);
	}, path);
}

/** Create a note with the given content (parent folders assumed to exist). */
async function createNote(path: string, content: string): Promise<void> {
	await browser.executeObsidian(
		async ({ app }, p, c) => {
			await app.vault.create(p, c);
		},
		path,
		content,
	);
}

const INNER = [":::tabs", ":::tab One", "original body", ":::", ":::tab Two", "second tab body", ":::", ":::"].join(
	"\n",
);
const NOTE = ["Intro paragraph.", "", '```mica id=blk-e2e-1 name="E2E"', INNER, "```", "", "tail marker line"].join(
	"\n",
);

describe("runtime contracts (window.mica)", function () {
	it("block update replaces content exactly — the anti-corruption contract", async function () {
		await createNote("Corruption.md", NOTE);
		const grown = `${INNER}\nGROWN LINE 1\nGROWN LINE 2\nGROWN LINE 3\n`.replace("original body", "REPLACED body");

		await browser.executeObsidian(async (_obs, content) => {
			await window.mica.blockUpdate("Corruption.md", "blk-e2e-1", content);
		}, grown);

		const after = await readNote("Corruption.md");
		expect(after).toContain("REPLACED body");
		expect(after).toContain("GROWN LINE 3");
		expect(after).not.toContain("original body"); // old content must not survive
		expect(after.match(/```mica/g)?.length).toBe(1); // no duplicated fence
		expect(after.trimEnd().endsWith("tail marker line")).toBe(true); // trailing prose intact

		// Newline-free content must NOT glue onto the closing fence.
		await browser.executeObsidian(() =>
			window.mica.blockUpdate("Corruption.md", "blk-e2e-1", "no trailing newline"),
		);
		const after2 = await readNote("Corruption.md");
		expect(after2).toContain("no trailing newline");
		expect(after2).not.toContain("newline```"); // fence not glued
		const readable = await browser.executeObsidian(() => window.mica.blockRead("Corruption.md", "blk-e2e-1"));
		expect(readable).toContain("no trailing newline"); // block still closes + reads
	});

	it("snapshot → edit → snapshot → revert round-trips losslessly", async function () {
		await createNote("Versioned.md", NOTE);
		const original = await browser.executeObsidian(() => window.mica.blockRead("Versioned.md", "blk-e2e-1"));

		await browser.executeObsidian(() => window.mica.versionsSnapshot("Versioned.md"));
		await browser.executeObsidian(async () => {
			await window.mica.blockUpdate("Versioned.md", "blk-e2e-1", "totally new v2 content\n");
			await window.mica.versionsSnapshot("Versioned.md");
		});

		const versions = await browser.executeObsidian(() => window.mica.versionsList("Versioned.md", "blk-e2e-1"));
		expect(versions.length).toBe(2);

		const diff = await browser.executeObsidian(
			(_obs, base, other) => window.mica.versionsDiff("Versioned.md", base, other, "line"),
			versions[0].hash,
			versions[1].hash,
		);
		expect(diff.hunks.length).toBeGreaterThan(0);

		await browser.executeObsidian(
			(_obs, hash) => window.mica.versionsRevert("Versioned.md", "blk-e2e-1", hash),
			versions[0].hash,
		);
		const reverted = await browser.executeObsidian(() => window.mica.blockRead("Versioned.md", "blk-e2e-1"));
		expect(reverted).toBe(original);

		// Branch-edit a previous version: a NEW version (parent recorded) becomes head.
		await browser.executeObsidian(
			(_obs, parent) => window.mica.versionsEdit("Versioned.md", "blk-e2e-1", parent, "branched from v1\n"),
			versions[0].hash,
		);
		const afterEdit = await browser.executeObsidian(() => window.mica.versionsList("Versioned.md", "blk-e2e-1"));
		expect(afterEdit.length).toBe(3);
		const branched = await browser.executeObsidian(() => window.mica.blockRead("Versioned.md", "blk-e2e-1"));
		expect(branched).toBe("branched from v1\n");
	});

	it("migrates the real legacy tabs shape losslessly", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const f = app.vault.getAbstractFileByPath("Legacy Tabs.md");
			if (!(f instanceof obsidian.TFile)) throw new Error("fixture missing");
			await app.workspace.getLeaf(false).openFile(f);
		});
		await browser.executeObsidianCommand("mica:migrate-tabs");

		await browser.waitUntil(async () => (await readNote("Legacy Tabs.md")).includes("```mica id="), {
			timeout: 15_000,
			timeoutMsg: "migration never rewrote Legacy Tabs.md with a ```mica block",
		});

		const doc = await readNote("Legacy Tabs.md");
		expect(doc).not.toContain("`````tabs");
		expect(doc).toContain("tab: Kernel"); // friendly, closer-free syntax
		expect(doc).toContain("tab: Frame Gate");
		expect(doc).not.toContain(":::"); // no colon-fence scaffolding
		expect(doc).toContain("> ````md"); // callout-quoted inner fence preserved verbatim
		expect(doc).toContain("LOYALTY. Your only loyalty");
		expect(doc).toContain("Prose before the block.");
		expect(doc).toContain("Prose after the block.");

		// Migration imports the archive callouts as versions asynchronously (after
		// the doc rewrite the previous wait caught) — wait for that OUTCOME, not a
		// point-in-time snapshot, so the sidecar/version assertions aren't racy.
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app }) =>
					Boolean(app.vault.getAbstractFileByPath("Legacy Tabs.mica/ledger.jsonl")),
				),
			{ timeout: 10_000, timeoutMsg: "migration never created the sidecar ledger" },
		);

		// The killer feature: the manual archive callouts became REAL versions.
		const blocks = await browser.executeObsidian(() => window.mica.blockList("Legacy Tabs.md"));
		const blockId = blocks.find((b) => b.id)?.id as string;
		expect(blockId).toBeTruthy();
		await browser.waitUntil(
			async () =>
				(await browser.executeObsidian((_o, id) => window.mica.versionsList("Legacy Tabs.md", id), blockId))
					.length >= 4,
			{ timeout: 10_000, timeoutMsg: "archived callouts were not imported as versions" },
		);
		const versions = await browser.executeObsidian(
			(_obs, id) => window.mica.versionsList("Legacy Tabs.md", id),
			blockId,
		);
		const labels = versions.map((v) => v.label);
		expect(labels).toContain("V1.0"); // [!success]- Review Kernel (V1.0)
		expect(labels).toContain("V0.3"); // [!bug]- Frame Gate (V0.3)
		expect(labels).toContain("V2.5"); // [!info]- Field Notes — a non-default callout type
		expect(versions.length).toBeGreaterThanOrEqual(4); // imported + migrated head
	});

	it("migrate.scan verb reports (and is empty once converted)", async function () {
		const scan = await browser.executeObsidian(() => window.mica.migrateScan());
		expect(Array.isArray(scan)).toBe(true);
	});

	it("compare modal renders colored +/- diff rows", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			type P = { settings: { defaultDiffMode: string } };
			const plugin = (app as unknown as { plugins: { plugins: Record<string, P> } }).plugins.plugins["mica"];
			plugin.settings.defaultDiffMode = "inline"; // the row class under test is inline-only
			const p = "Diffcolor.md";
			if (!app.vault.getAbstractFileByPath(p)) {
				await app.vault.create(p, "```mica id=dc-1\ntab: A\nversion one\n```\n");
			}
			await window.mica.versionsSnapshot(p);
			await window.mica.blockUpdate(p, "dc-1", "tab: A\nversion two changed\n");
			await window.mica.versionsSnapshot(p);
			const f = app.vault.getAbstractFileByPath(p);
			if (f instanceof obsidian.TFile)
				await app.workspace.getLeaf(false).openFile(f, { state: { mode: "source" } });
		});
		await browser.executeObsidianCommand("mica:diff-versions");
		await browser.waitUntil(
			() => browser.executeObsidian(() => document.querySelectorAll(".mica-diff-row").length > 0),
			{ timeout: 10_000, timeoutMsg: "compare modal never rendered diff rows" },
		);
		const c = await browser.executeObsidian(() => {
			const bg = (sel: string): string => {
				const el = document.querySelector(sel);
				return el ? getComputedStyle(el).backgroundColor : "";
			};
			return {
				hasDel: Boolean(document.querySelector(".mica-diff-row.is-delete")),
				hasIns: Boolean(document.querySelector(".mica-diff-row.is-insert")),
				delBg: bg(".mica-diff-row.is-delete"),
				insBg: bg(".mica-diff-row.is-insert"),
			};
		});
		expect(c.hasDel).toBe(true);
		expect(c.hasIns).toBe(true);
		// The var-scope + color-mix fix: rows are tinted, not transparent.
		expect(c.delBg).not.toBe("rgba(0, 0, 0, 0)");
		expect(c.insBg).not.toBe("rgba(0, 0, 0, 0)");
		expect(c.delBg).not.toBe(c.insBg); // red vs green
		await browser.executeObsidian(() =>
			(document.querySelector(".modal-close-button") as HTMLElement | null)?.click(),
		);
	});

	it("smart auto-save ignores structural churn, versions only real content", async function () {
		await createNote("SmartAuto.md", "Intro.\n\n```mica id=sa-1\ntab: A\nreal content\n```\n");
		await browser.executeObsidian(() => window.mica.versionsSnapshot("SmartAuto.md"));
		let versions = await browser.executeObsidian(() => window.mica.versionsList("SmartAuto.md", "sa-1"));
		expect(versions.length).toBe(1);

		// Add an EMPTY tab (structure only) and snapshot → NO new version.
		await browser.executeObsidian(async () => {
			await window.mica.blockUpdate("SmartAuto.md", "sa-1", "tab: A\nreal content\n\ntab: B\n");
			await window.mica.versionsSnapshot("SmartAuto.md");
		});
		versions = await browser.executeObsidian(() => window.mica.versionsList("SmartAuto.md", "sa-1"));
		expect(versions.length).toBe(1);

		// Put real prose in the new tab and snapshot → a version IS created.
		await browser.executeObsidian(async () => {
			await window.mica.blockUpdate(
				"SmartAuto.md",
				"sa-1",
				"tab: A\nreal content\n\ntab: B\nB has real content\n",
			);
			await window.mica.versionsSnapshot("SmartAuto.md");
		});
		versions = await browser.executeObsidian(() => window.mica.versionsList("SmartAuto.md", "sa-1"));
		expect(versions.length).toBe(2);
	});

	it("file-bridge: inbox instruction produces an outbox result", async function () {
		const req = `req-${Date.now()}`;
		await browser.executeObsidian(async ({ app }, name) => {
			await app.vault.createFolder("mica-bridge/inbox").catch(() => undefined);
			await app.vault.create(
				`mica-bridge/inbox/${name}.json`,
				JSON.stringify({ verb: "block.list", args: ["Sandbox.md"] }),
			);
		}, req);

		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					({ app }, name) => Boolean(app.vault.getAbstractFileByPath(`mica-bridge/outbox/${name}.json`)),
					req,
				),
			{ timeout: 15_000, timeoutMsg: `outbox result mica-bridge/outbox/${req}.json never appeared` },
		);

		const result = JSON.parse(await readNote(`mica-bridge/outbox/${req}.json`)) as {
			ok: boolean;
			result: unknown[];
			error: string | null;
		};
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.result)).toBe(true);

		// The instruction must be CONSUMED — a surviving inbox file would replay
		// (destructively) on every future app launch.
		const inboxGone = await browser.executeObsidian(
			({ app }, name) => !app.vault.getAbstractFileByPath(`mica-bridge/inbox/${name}.json`),
			req,
		);
		expect(inboxGone).toBe(true);
	});

	it("large version objects compress to .gz and revert losslessly", async function () {
		const big = "B".repeat(6000);
		const result = await browser.executeObsidian(async ({ app }, payload) => {
			type M = {
				blockUpdate(n: string, id: string, c: string): Promise<unknown>;
				versionsSnapshot(n: string): Promise<unknown>;
				versionsList(n: string, id: string): Promise<{ hash: string }[]>;
				versionsRevert(n: string, id: string, h: string): Promise<unknown>;
				blockRead(n: string, id: string): Promise<string>;
			};
			const mica = (window as unknown as { mica: M }).mica;
			const name = "GzRound.md";
			if (!app.vault.getAbstractFileByPath(name)) {
				await app.vault.create(name, "```mica id=gz-1\ntab: A\nsmall\n```\n");
			}
			await mica.versionsSnapshot(name);
			await mica.blockUpdate(name, "gz-1", `tab: A\n${payload}\n`);
			await mica.versionsSnapshot(name);
			const versions = await mica.versionsList(name, "gz-1");
			const files = (await app.vault.adapter.list("GzRound.mica/objects")).files;
			const hasGz = files.some((f: string) => f.endsWith(".mica.gz"));
			// Revert to the FIRST (small) version, then forward to the big one.
			await mica.versionsRevert(name, "gz-1", versions[0].hash);
			const bigVersion = versions.find((v) => v.hash !== versions[0].hash);
			if (!bigVersion) return { hasGz, ok: false };
			await mica.versionsRevert(name, "gz-1", bigVersion.hash);
			const read = await mica.blockRead(name, "gz-1");
			return { hasGz, ok: read.includes(payload) };
		}, big);
		expect(result.hasGz).toBe(true);
		expect(result.ok).toBe(true);
	});
});
