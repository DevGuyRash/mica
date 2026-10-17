import { browser, expect } from "@wdio/globals";
import type MicaPlugin from "../../../src/main";

/** Inspect the binding returned by the product; tests must not reimplement note-key policy. */
async function historyPaths(path: string) {
	return browser.executeObsidian(async ({ app, obsidian }, note) => {
		const file = app.vault.getAbstractFileByPath(note);
		if (!(file instanceof obsidian.TFile)) throw new Error(`missing note: ${note}`);
		const plugin = (app as unknown as { plugins: { plugins: Record<string, MicaPlugin> } }).plugins.plugins["mica"];
		const store = await plugin.engine.historyStore(file);
		if (!store) throw new Error(`note has no prepared history: ${note}`);
		return { noteId: store.noteId, paths: store.paths, root: store.root.paths };
	}, path);
}

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
	it("constructs immediately addressable, fence-safe block source for templates", async function () {
		const result = await browser.executeObsidian(async ({ app }) => {
			const source = window.mica.createBlockSource({
				name: "Prompt block",
				body: "tab: Main\n\nliteral ````` run\n:::: directive\n",
			});
			await app.vault.create("Constructed.md", source);
			const blocks = await window.mica.blockList("Constructed.md");
			let invalid = "";
			try {
				window.mica.createBlockSource({ name: 'unsafe " name', body: "body" });
			} catch (error) {
				invalid = error instanceof Error ? error.message : String(error);
			}
			const unnamed = window.mica.createBlockSource({ name: "  ", body: "" });
			return { source, blocks, invalid, unnamed };
		});

		expect(result.source).toMatch(/^``````mica id=[0-9a-f-]+ name="Prompt block"$/m);
		expect(result.source.endsWith("``````\n")).toBe(true);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(result.blocks[0]?.name).toBe("Prompt block");
		expect(result.invalid).toContain("cannot contain double quotes");
		expect(result.unnamed).not.toContain(" name=");
	});

	it("auto-stamps raw id-less blocks even when automatic versions are disabled", async function () {
		const previous = await browser.executeObsidian(async ({ app, obsidian }) => {
			type Plugin = {
				settings: { autoSnapshotEnabled: boolean; autoAddIds: boolean; snapshotDebounceMs: number };
				engine: { resetDebouncers(): void };
			};
			const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins["mica"];
			const before = { ...plugin.settings };
			plugin.settings.autoSnapshotEnabled = false;
			plugin.settings.autoAddIds = true;
			plugin.settings.snapshotDebounceMs = 50;
			plugin.engine.resetDebouncers();
			await app.vault.create("RawIdless.md", "seed\n");
			const file = app.vault.getAbstractFileByPath("RawIdless.md");
			if (!(file instanceof obsidian.TFile)) throw new Error("missing raw id-less fixture");
			await app.vault.process(file, (text) => `${text}\n\`\`\`mica\ntab: Main\nbody\n\`\`\`\n`);
			return before;
		});

		try {
			await browser.waitUntil(async () => /```mica id=[0-9a-f-]+/.test(await readNote("RawIdless.md")), {
				timeout: 10_000,
				timeoutMsg: "the raw id-less block was not stamped",
			});
			const result = await browser.executeObsidian(async ({ app, obsidian }) => {
				const file = app.vault.getAbstractFileByPath("RawIdless.md");
				if (!(file instanceof obsidian.TFile)) throw new Error("missing raw id-less fixture");
				const plugin = (app as unknown as { plugins: { plugins: Record<string, MicaPlugin> } }).plugins.plugins["mica"];
				const store = await plugin.engine.historyStore(file);
				return {
					source: await window.mica.blockList("RawIdless.md"),
					hasHistory: store !== null && Boolean(app.vault.getAbstractFileByPath(store.paths.ledger)),
				};
			});
			expect(result.source[0]?.id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(result.hasHistory).toBe(false);
		} finally {
			await browser.executeObsidian(({ app }, before) => {
				type Plugin = {
					settings: { autoSnapshotEnabled: boolean; autoAddIds: boolean; snapshotDebounceMs: number };
					engine: { resetDebouncers(): void };
				};
				const plugin = (app as unknown as { plugins: { plugins: Record<string, Plugin> } }).plugins.plugins[
					"mica"
				];
				Object.assign(plugin.settings, before);
				plugin.engine.resetDebouncers();
			}, previous);
		}
	});

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
		expect(versions.every((version) => /^b3:[0-9a-f]{64}$/.test(version.hash))).toBe(true);

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

	it("uses stable selectors when distinct checkpoints share one content hash", async function () {
		await createNote("DuplicateHashSelectors.md", "```mica id=duplicate-hash-selectors\none\n```\n");
		const result = await browser.executeObsidian(async ({ app }) => {
			const note = "DuplicateHashSelectors.md";
			const blockId = "duplicate-hash-selectors";
			await window.mica.versionsSnapshot(note);
			await window.mica.blockUpdate(note, blockId, "two\n");
			const [v1] = await window.mica.versionsList(note, blockId);
			if (!v1) throw new Error("missing original selector fixture");
			await window.mica.versionsRestoreCheckpoint(note, blockId, v1.versionId);
			const duplicateHistory = await window.mica.versionsList(note, blockId);
			const v3 = duplicateHistory.at(-1);
			if (!v3 || v3.hash !== v1.hash || v3.versionId === v1.versionId)
				throw new Error("failed to create distinct checkpoints with duplicate content");

			const ambiguous: string[] = [];
			for (const mutation of [
				() => window.mica.versionsRevert(note, blockId, v1.hash),
				() => window.mica.versionsEdit(note, blockId, v1.hash, "must not be committed\n"),
				() => window.mica.versionsLabel(note, blockId, v1.hash, "must not be committed"),
			]) {
				try {
					await mutation();
				} catch (error) {
					ambiguous.push(error instanceof Error ? error.message : String(error));
				}
			}

			await window.mica.versionsLabel(note, blockId, v1.versionId, "original checkpoint");
			await window.mica.versionsEdit(note, blockId, v3.versionId, "branched from duplicate\n");
			const afterEdit = await window.mica.versionsList(note, blockId);
			const branch = afterEdit.at(-1);
			if (!branch) throw new Error("missing id-selected branch");
			await window.mica.versionsRevert(note, blockId, v1.versionId);

			const plugin = (
				app as unknown as {
					plugins: {
						getPlugin(id: string): {
							engine: {
								state(
									file: unknown,
								): Promise<
									Record<string, { rawHeadVersionId: string | null; headVersionId: string | null }>
								>;
							};
						};
					};
				}
			).plugins.getPlugin("mica");
			const file = app.vault.getAbstractFileByPath(note);
			const state = (await plugin.engine.state(file))[blockId];
			const final = await window.mica.versionsList(note, blockId);
			return {
				ambiguous,
				v1: v1.versionId,
				v3: v3.versionId,
				branchParent: branch.parentVersionId,
				labels: final
					.filter((version) => version.hash === v1.hash)
					.map((version) => [version.versionId, version.label]),
				head: state.rawHeadVersionId ?? state.headVersionId,
				content: await window.mica.blockRead(note, blockId),
			};
		});

		expect(result.ambiguous).toHaveLength(3);
		expect(result.ambiguous.every((message) => message.includes("identifies multiple checkpoints"))).toBe(true);
		expect(result.branchParent).toBe(result.v3);
		expect(result.labels).toContainEqual([result.v1, "original checkpoint"]);
		expect(result.labels).toContainEqual([result.v3, null]);
		expect(result.head).toBe(result.v1);
		expect(result.content).toBe("one\n");
	});

	it("keeps checkpoint identity across restore, timeline removal, and HEAD reset", async function () {
		await createNote("CheckpointIdentity.md", "```mica id=checkpoint-identity\none\n```\n");
		const result = await browser.executeObsidian(async ({ app }) => {
			await window.mica.versionsSnapshot("CheckpointIdentity.md");
			await window.mica.blockUpdate("CheckpointIdentity.md", "checkpoint-identity", "two\n");
			const initial = await window.mica.versionsList("CheckpointIdentity.md", "checkpoint-identity");
			if (initial.length !== 2) throw new Error(`expected two checkpoints, got ${initial.length}`);
			const [v1, v2] = initial;

			const removedHead = await window.mica.runInstruction({
				verb: "versions.set-visible",
				args: ["CheckpointIdentity.md", "checkpoint-identity", "false", v2.versionId],
			});
			const plugin = (
				app as unknown as {
					plugins: {
						getPlugin(id: string): {
							engine: {
								state(file: unknown): Promise<
									Record<
										string,
										{
											headVersionId: string | null;
											head: string | null;
											versions: typeof initial;
											removedVersions: typeof initial;
										}
									>
								>;
							};
						};
					};
				}
			).plugins.getPlugin("mica");
			const file = app.vault.getAbstractFileByPath("CheckpointIdentity.md");
			const hiddenState = (await plugin.engine.state(file))["checkpoint-identity"];
			const liveWhileHidden = await window.mica.blockRead("CheckpointIdentity.md", "checkpoint-identity");
			await window.mica.runInstruction({
				verb: "versions.visibility",
				args: ["CheckpointIdentity.md", "checkpoint-identity", "true", v2.versionId],
			});

			const restored = await window.mica.versionsRestoreCheckpoint(
				"CheckpointIdentity.md",
				"checkpoint-identity",
				v1.versionId,
			);
			const afterRestore = await window.mica.versionsList("CheckpointIdentity.md", "checkpoint-identity");
			const v3 = afterRestore.at(-1);
			if (!v3) throw new Error("missing forward restore checkpoint");
			const noOpRestore = await window.mica.versionsRestoreCheckpoint(
				"CheckpointIdentity.md",
				"checkpoint-identity",
				v1.versionId,
			);
			await window.mica.versionsSetVisible("CheckpointIdentity.md", "checkpoint-identity", [v2.versionId], false);
			const spliced = await window.mica.versionsList("CheckpointIdentity.md", "checkpoint-identity");
			const removed = await window.mica.versionsRemoved("CheckpointIdentity.md", "checkpoint-identity");
			const reset = await window.mica.versionsResetHead(
				"CheckpointIdentity.md",
				"checkpoint-identity",
				v1.versionId,
			);
			const resetState = (await plugin.engine.state(file))["checkpoint-identity"];
			return {
				idsUnique: new Set(afterRestore.map((version) => version.versionId)).size,
				hashes: afterRestore.map((version) => version.hash),
				v1: v1.versionId,
				v2: v2.versionId,
				v3: v3.versionId,
				v3Parent: v3.parentVersionId,
				v3Source: v3.sourceVersionId,
				v3Cause: v3.cause,
				removedHead,
				hiddenHead: hiddenState.headVersionId,
				liveWhileHidden,
				restored,
				noOpRestore,
				spliced: spliced.map((version) => ({
					id: version.versionId,
					parent: version.effectiveParentVersionId,
				})),
				removed: removed.map((version) => version.versionId),
				reset,
				resetHead: resetState.headVersionId,
			};
		});
		expect(result.idsUnique).toBe(3);
		expect(result.hashes[0]).toBe(result.hashes[2]);
		expect(result.v3Parent).toBe(result.v2);
		expect(result.v3Source).toBe(result.v1);
		expect(result.v3Cause).toBe("restore");
		expect(result.removedHead).toBe(1);
		expect(result.hiddenHead).toBe(result.v1);
		expect(result.liveWhileHidden).toBe("two\n");
		expect(result.restored).toBe(true);
		expect(result.noOpRestore).toBe(false);
		expect(result.spliced).toEqual([
			{ id: result.v1, parent: null },
			{ id: result.v3, parent: result.v1 },
		]);
		expect(result.removed).toEqual([result.v2]);
		expect(result.reset).toBe(true);
		expect(result.resetHead).toBe(result.v1);
	});

	it("keeps history at its stable identity after rename and refreshes metadata without minting a version", async function () {
		const originalPath = "RenameOrigin.md";
		const renamedPath = "RenameDestination.md";
		const id = "rename-history";
		await createNote(originalPath, `\`\`\`mica id=${id} name="Before"\ntab: Main\nstable body\n\`\`\`\n`);
		await browser.executeObsidian(async () => {
			await window.mica.versionsSnapshot("RenameOrigin.md");
			const [version] = await window.mica.versionsList("RenameOrigin.md", "rename-history");
			if (!version) throw new Error("missing rename fixture version");
			await window.mica.versionsLabel("RenameOrigin.md", "rename-history", version.hash, "kept label");
		});
		const original = await historyPaths(originalPath);
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getAbstractFileByPath("RenameOrigin.md");
			if (!(file instanceof obsidian.TFile)) throw new Error("missing rename fixture note");
			await app.fileManager.renameFile(file, "RenameDestination.md");
		});

		await browser.waitUntil(
			async () => {
				const manifest = JSON.parse(await readNote(original.paths.manifest)) as { path: string };
				return manifest.path === renamedPath;
			},
			{ timeout: 10_000, timeoutMsg: "the central history path hint did not follow its renamed note" },
		);

		const result = await browser.executeObsidian(async ({ app, obsidian }, manifestPath) => {
			const before = await window.mica.versionsList("RenameDestination.md", "rename-history");
			await window.mica.blockSetAttr("RenameDestination.md", "rename-history", "name", "After");
			await window.mica.versionsSnapshot("RenameDestination.md");
			const after = await window.mica.versionsList("RenameDestination.md", "rename-history");
			const manifestFile = app.vault.getAbstractFileByPath(manifestPath);
			if (!(manifestFile instanceof obsidian.TFile)) throw new Error("missing stable history manifest");
			const manifest = JSON.parse(await app.vault.read(manifestFile)) as {
				path: string;
				blocks: Record<string, string>;
			};
			return { before, after, manifest };
		}, original.paths.manifest);
		const renamed = await historyPaths(renamedPath);
		expect(renamed.noteId).toBe(original.noteId);
		expect(renamed.paths).toEqual(original.paths);
		expect(result.before.map((version) => version.hash)).toEqual(result.after.map((version) => version.hash));
		expect(result.after).toHaveLength(1);
		expect(result.after[0]?.label).toBe("kept label");
		expect(result.manifest.path).toBe(renamedPath);
		expect(result.manifest.blocks[id]).toBe("After");
	});

	it("reports a duplicate identity during rename and preserves both notes and the central history", async function () {
		await createNote("RenameCollisionOrigin.md", "```mica id=rename-collision\ntab: Main\nsource history\n```\n");
		await browser.executeObsidian(() => window.mica.versionsSnapshot("RenameCollisionOrigin.md"));
		const original = await historyPaths("RenameCollisionOrigin.md");
		const manifestBefore = await readNote(original.paths.manifest);
		const ledgerBefore = await readNote(original.paths.ledger);
		const noteBefore = await readNote("RenameCollisionOrigin.md");
		try {
			await browser.executeObsidian(async ({ app, obsidian }, source) => {
				await app.vault.create("RenameCollisionDuplicate.md", source);
				const file = app.vault.getAbstractFileByPath("RenameCollisionOrigin.md");
				if (!(file instanceof obsidian.TFile)) throw new Error("missing collision fixture note");
				await app.fileManager.renameFile(file, "RenameCollisionDestination.md");
			}, noteBefore);
			await browser.waitUntil(
				() => browser.executeObsidian(() =>
					Array.from(document.querySelectorAll(".notice")).some((notice) =>
						notice.textContent?.includes("history needs attention") &&
						notice.textContent.includes("duplicate note identity"),
					),
				),
				{ timeout: 10_000, timeoutMsg: "the rename identity conflict was not surfaced" },
			);
			expect(await readNote("RenameCollisionDestination.md")).toBe(noteBefore);
			expect(await readNote("RenameCollisionDuplicate.md")).toBe(noteBefore);
			expect(await readNote(original.paths.manifest)).toBe(manifestBefore);
			expect(await readNote(original.paths.ledger)).toBe(ledgerBefore);
		} finally {
			// This negative fixture must not leave a duplicate identity for later repair cases.
			await browser.executeObsidian(async ({ app, obsidian }) => {
				const duplicate = app.vault.getAbstractFileByPath("RenameCollisionDuplicate.md");
				if (duplicate instanceof obsidian.TFile) await app.vault.delete(duplicate);
			});
		}
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
		expect(/^mica-id:\s*[0-9a-f-]+$/m.test(doc)).toBe(true);
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
		// point-in-time snapshot, so the central ledger/version assertions aren't racy.
		const migrated = await historyPaths("Legacy Tabs.md");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(({ app }, ledger) =>
					Boolean(app.vault.getAbstractFileByPath(ledger)),
					migrated.paths.ledger,
				),
			{ timeout: 10_000, timeoutMsg: "migration never created the central note ledger" },
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
		const journal = await browser.executeObsidian(async ({ app, obsidian }, migrationPath) => {
			const af = app.vault.getAbstractFileByPath(migrationPath);
			if (!(af instanceof obsidian.TFile)) throw new Error("migration journal was not retained");
			return JSON.parse(await app.vault.read(af)) as {
				format: number;
				status: string;
				note: string;
				original: string;
				migrated: string;
			};
		}, migrated.paths.migration);
		expect(journal).toMatchObject({ format: 1, status: "complete", note: "Legacy Tabs.md" });
		expect(journal.original).toMatch(/^b3:[0-9a-f]{64}$/);
		expect(journal.migrated).toMatch(/^b3:[0-9a-f]{64}$/);
	});

	it("recovers a torn ledger tail and an append that partially commits before throwing", async function () {
		const result = await browser.executeObsidian(async ({ app, obsidian }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, MicaPlugin> } }).plugins.plugins["mica"];
			const previousAuto = plugin.settings.autoSnapshotEnabled;
			plugin.settings.autoSnapshotEnabled = false;
			const name = "LedgerRecovery.md";
			const id = "ledger-recovery";
			await app.vault.create(name, `\`\`\`mica id=${id}\ntab: A\nv1\n\`\`\`\n`);
			const file = app.vault.getAbstractFileByPath(name);
			if (!(file instanceof obsidian.TFile)) throw new Error("missing recovery note");
			try {
				await window.mica.versionsSnapshot(name);
				const store = await plugin.engine.historyStore(file);
				if (!store) throw new Error("missing recovery history binding");
				const ledger = app.vault.getAbstractFileByPath(store.paths.ledger);
				if (!(ledger instanceof obsidian.TFile)) throw new Error("missing recovery ledger");
				await app.vault.append(ledger, '{"type":'); // torn JSON, deliberately no newline
				await app.vault.process(file, (doc) => doc.replace("v1", "v2"));
				await window.mica.versionsSnapshot(name);

				const mutableVault = app.vault as unknown as { append: typeof app.vault.append };
				const originalAppend = mutableVault.append;
				let injected = false;
				mutableVault.append = async (target, data, options) => {
					if (!injected && target.path === store.paths.ledger) {
						injected = true;
						const firstLine = data.slice(0, data.indexOf("\n") + 1);
						await originalAppend.call(app.vault, target, firstLine, options);
						throw new Error("injected post-commit append failure");
					}
					return originalAppend.call(app.vault, target, data, options);
				};
				try {
					await app.vault.process(file, (doc) => doc.replace("v2", "v3"));
					await window.mica.versionsSnapshot(name);
				} finally {
					mutableVault.append = originalAppend;
				}
				const text = await app.vault.read(ledger);
				const valid = text
					.split("\n")
					.map((line) => {
						try {
							return JSON.parse(line) as { eid?: string };
						} catch {
							return null;
						}
					})
					.filter((event): event is { eid: string } => typeof event?.eid === "string");
				const versions = await window.mica.versionsList(name, id);
				return {
					injected,
					separated: text.includes('{"type":\n{'),
					uniqueEids: new Set(valid.map((event) => event.eid)).size === valid.length,
					versionCount: versions.length,
				};
			} finally {
				plugin.settings.autoSnapshotEnabled = previousAuto;
			}
		});
		expect(result.injected).toBe(true);
		expect(result.separated).toBe(true);
		expect(result.uniqueEids).toBe(true);
		expect(result.versionCount).toBe(3);
	});

	it("rejects a corrupt successful object create and dual object representations", async function () {
		const result = await browser.executeObsidian(async ({ app, obsidian }) => {
			const plugin = (app as unknown as { plugins: { plugins: Record<string, MicaPlugin> } }).plugins.plugins["mica"];
			const previousAuto = plugin.settings.autoSnapshotEnabled;
			plugin.settings.autoSnapshotEnabled = false;
			const mutableVault = app.vault as unknown as { create: typeof app.vault.create };
			const originalCreate = mutableVault.create;
			let corruptObjectPath: string | null = null;
			let dualRepresentationPath: string | null = null;
			try {
				const corruptName = "CorruptObjectCreate.md";
				const corruptContent = "tab: A\ncorrupt successful-create fixture\n";
				await originalCreate.call(app.vault, corruptName, `\`\`\`mica id=corrupt-object\n${corruptContent}\`\`\`\n`);
				await window.mica.prepare(corruptName);
				const corruptFile = app.vault.getAbstractFileByPath(corruptName);
				if (!(corruptFile instanceof obsidian.TFile)) throw new Error("missing corrupt-object fixture");
				const store = await plugin.engine.historyStore(corruptFile);
				if (!store) throw new Error("missing corrupt-object history binding");
				let corruptedCreateRejected = false;
				mutableVault.create = async (path, data, options) => {
					if (
						path.startsWith(`${store.root.paths.objects}/`) &&
						path.endsWith(".mica.md") &&
						data === corruptContent
					) {
						corruptObjectPath = path;
						return originalCreate.call(app.vault, path, `${data}CORRUPTED`, options);
					}
					return originalCreate.call(app.vault, path, data, options);
				};
				try {
					await window.mica.versionsSnapshot(corruptName);
				} catch (error) {
					corruptedCreateRejected = String(error).includes("corrupt history object");
				} finally {
					mutableVault.create = originalCreate;
				}

				const dualName = "DualObject.md";
				await originalCreate.call(app.vault, dualName, "```mica id=dual-object\ntab: A\nvalid\n```\n");
				await window.mica.versionsSnapshot(dualName);
				const versions = await window.mica.versionsList(dualName, "dual-object");
				const hash = versions[0]?.hash;
				if (!hash) throw new Error("missing dual-object version");
				const gzPath = `${store.root.paths.objects}/${hash.replace(":", "-")}.mica.gz`;
				await app.vault.createBinary(gzPath, new Uint8Array().buffer);
				dualRepresentationPath = gzPath;
				let dualRejected = false;
				try {
					await window.mica.versionsDiff(dualName, hash, hash);
				} catch (error) {
					dualRejected = String(error).includes("both plaintext and compressed forms");
				}
				return { corruptedCreateRejected, dualRejected };
			} finally {
				mutableVault.create = originalCreate;
				plugin.settings.autoSnapshotEnabled = previousAuto;
				// Corruption is scoped to this case; later repair cases share the object pool.
				for (const path of [corruptObjectPath, dualRepresentationPath]) {
					if (path === null) continue;
					const injected = app.vault.getAbstractFileByPath(path);
					if (injected instanceof obsidian.TFile) await app.vault.delete(injected);
				}
			}
		});
		expect(result.corruptedCreateRejected).toBe(true);
		expect(result.dualRejected).toBe(true);
	});

	it("retains an orphan central record when its represented blocks resolve to different notes", async function () {
		await createNote("Shared.md", "```mica id=rehome-a\ntab: A\na\n```\n\n```mica id=rehome-b\ntab: B\nb\n```\n");
		await browser.executeObsidian(() => window.mica.versionsSnapshot("Shared.md"));
		const shared = await historyPaths("Shared.md");
		const manifestBefore = await readNote(shared.paths.manifest);
		const ledgerBefore = await readNote(shared.paths.ledger);
		const result = await browser.executeObsidian(async ({ app, obsidian }, paths) => {
			const original = app.vault.getAbstractFileByPath("Shared.md");
			if (!(original instanceof obsidian.TFile)) throw new Error("missing shared-history fixture");
			await app.vault.delete(original);
			const originalA = await app.vault.create("RehomeA.md", "```mica id=rehome-a\ntab: A\na\n```\n");
			const originalB = await app.vault.create("RehomeB.md", "```mica id=rehome-b\ntab: B\nb\n```\n");
			const beforeA = await app.vault.read(originalA);
			const beforeB = await app.vault.read(originalB);
			const report = await window.mica.repair();
			const manifest = app.vault.getAbstractFileByPath(paths.manifest);
			const ledger = app.vault.getAbstractFileByPath(paths.ledger);
			const a = app.vault.getAbstractFileByPath("RehomeA.md");
			const b = app.vault.getAbstractFileByPath("RehomeB.md");
			if (!(manifest instanceof obsidian.TFile) || !(ledger instanceof obsidian.TFile) ||
				!(a instanceof obsidian.TFile) || !(b instanceof obsidian.TFile)) throw new Error("repair removed preserved fixture state");
			return {
				stillThere: Boolean(app.vault.getAbstractFileByPath(paths.dir)),
				rehomed: report.rehomed,
				manifest: await app.vault.read(manifest),
				ledger: await app.vault.read(ledger),
				notesUnchanged: await app.vault.read(a) === beforeA && await app.vault.read(b) === beforeB,
			};
		}, shared.paths);
		expect(result.stillThere).toBe(true);
		expect(result.rehomed).toEqual([]);
		expect(result.manifest).toBe(manifestBefore);
		expect(result.ledger).toBe(ledgerBefore);
		expect(result.notesUnchanged).toBe(true);
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
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLElement | null)?.click(),
		);
		await browser.waitUntil(() => browser.executeObsidian(() => !document.querySelector(".mica-versions-modal")), {
			timeout: 8_000,
			timeoutMsg: "compare modal did not close",
		});
	});

	it("branch editor preserves a stored version's CRLF line endings", async function () {
		await browser.executeObsidian(async ({ app, obsidian }) => {
			const path = "CrlfVersion.md";
			const content = "```mica id=crlf-1\r\ntab: Main\r\nline one\r\nline two\r\n```\r\n";
			const existing = app.vault.getAbstractFileByPath(path);
			const file = existing instanceof obsidian.TFile ? existing : await app.vault.create(path, content);
			if (existing instanceof obsidian.TFile) await app.vault.modify(existing, content);
			await window.mica.versionsSnapshot(path);
			await app.workspace.getLeaf(false).openFile(file, { state: { mode: "source" } });
		});
		await browser.executeObsidianCommand("mica:diff-versions");
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Boolean(document.querySelector('.mica-versions-modal .mica-vrow [aria-label="Version actions"]')),
				),
			{ timeout: 10_000, timeoutMsg: "version actions never rendered" },
		);
		await browser.executeObsidian(() => {
			(
				document.querySelector(
					'.mica-versions-modal .mica-vrow [aria-label="Version actions"]',
				) as HTMLButtonElement
			).click();
		});
		await browser.waitUntil(
			() =>
				browser.executeObsidian(() =>
					Array.from(document.querySelectorAll(".menu-item-title")).some(
						(item) => item.textContent === "Edit as new version (branch)",
					),
				),
			{ timeout: 8_000, timeoutMsg: "branch action menu never opened" },
		);
		await browser.executeObsidian(() => {
			const branch = Array.from(document.querySelectorAll(".menu-item-title")).find(
				(item) => item.textContent === "Edit as new version (branch)",
			) as HTMLElement;
			branch.click();
		});
		await browser.waitUntil(
			() => browser.executeObsidian(() => Boolean(document.querySelector(".mica-lightbox .mica-mdeditor"))),
			{ timeout: 8_000, timeoutMsg: "branch editor never opened" },
		);

		const value = await browser.executeObsidian(() => {
			const host = document.querySelector(".mica-lightbox .mica-mdeditor") as HTMLElement & {
				micaEditor?: { getValue(): string };
			};
			return host.micaEditor?.getValue() ?? "";
		});
		expect(value).toBe("tab: Main\r\nline one\r\nline two\r\n");
		await browser.executeObsidian(() => {
			(document.querySelector(".mica-lightbox .modal-close-button") as HTMLButtonElement | null)?.click();
			(document.querySelector(".mica-versions-modal .modal-close-button") as HTMLButtonElement | null)?.click();
		});
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

	it("snapshot rejects duplicate live ids before creating merged history", async function () {
		const result = await browser.executeObsidian(async ({ app, obsidian }) => {
			const path = "DuplicateSnapshot.md";
			const content = "```mica id=duplicate-live\none\n```\n\n```mica id=duplicate-live\ntwo\n```\n";
			const existing = app.vault.getAbstractFileByPath(path);
			if (existing instanceof obsidian.TFile) await app.vault.modify(existing, content);
			else await app.vault.create(path, content);
			const file = app.vault.getAbstractFileByPath(path);
			if (!(file instanceof obsidian.TFile)) throw new Error("missing duplicate-id fixture");
			const plugin = (app as unknown as { plugins: { plugins: Record<string, MicaPlugin> } }).plugins.plugins["mica"];
			try {
				await window.mica.versionsSnapshot(path);
				const store = await plugin.engine.historyStore(file);
				return {
					message: null,
					hasLedger: store !== null && Boolean(app.vault.getAbstractFileByPath(store.paths.ledger)),
				};
			} catch (error) {
				const store = await plugin.engine.historyStore(file);
				return {
					message: error instanceof Error ? error.message : String(error),
					hasLedger: store !== null && Boolean(app.vault.getAbstractFileByPath(store.paths.ledger)),
				};
			}
		});
		expect(result.message).toContain("duplicate block id");
		expect(result.hasLedger).toBe(false);
	});

	it("file-bridge: inbox instruction produces an outbox result", async function () {
		const req = `req-${Date.now()}`;
		await browser.executeObsidian(() => window.mica.prepare("Sandbox.md"));
		const sandbox = await historyPaths("Sandbox.md");
		const inbox = `${sandbox.root.bridgeInbox}/${req}.json`;
		const outbox = `${sandbox.root.bridgeOutbox}/${req}.json`;
		await browser.executeObsidian(async ({ app }, inboxPath) => {
			await app.vault.create(
				inboxPath,
				JSON.stringify({ verb: "block.list", args: ["Sandbox.md"] }),
			);
		}, inbox);

		await browser.waitUntil(
			() =>
				browser.executeObsidian(
					({ app }, outboxPath) => Boolean(app.vault.getAbstractFileByPath(outboxPath)),
					outbox,
				),
			{ timeout: 15_000, timeoutMsg: `outbox result ${outbox} never appeared` },
		);

		const response = await readNote(outbox);
		const result = JSON.parse(response) as {
			ok: boolean;
			result: unknown[];
			error: string | null;
		};
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.result)).toBe(true);

		// Consumption retains the exact outcome in a non-executable receipt instead of replayable verb/args.
		const consumed = JSON.parse(await readNote(inbox)) as {
			micaConsumed: number;
			instructionHash: string;
			response: string;
			verb?: unknown;
			args?: unknown;
		};
		expect(consumed.micaConsumed).toBe(1);
		expect(consumed.instructionHash).toMatch(/^b3:[0-9a-f]{64}$/);
		expect(consumed.verb).toBeUndefined();
		expect(consumed.args).toBeUndefined();
		expect(consumed.response).toBe(response);
	});

	it("large version objects compress to .gz and revert losslessly", async function () {
		const big = "B".repeat(6000);
		const result = await browser.executeObsidian(async ({ app, obsidian }, payload) => {
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
			const file = app.vault.getAbstractFileByPath(name);
			if (!(file instanceof obsidian.TFile)) throw new Error("missing gzip fixture note");
			const plugin = (app as unknown as { plugins: { plugins: Record<string, MicaPlugin> } }).plugins.plugins["mica"];
			const store = await plugin.engine.historyStore(file);
			if (!store) throw new Error("missing gzip history binding");
			const files = (await app.vault.adapter.list(store.root.paths.objects)).files;
			const bigVersion = versions.find((v) => v.hash !== versions[0].hash);
			if (!bigVersion) return { hasGz: false, ok: false };
			const hasGz = files.includes(`${store.root.paths.objects}/${bigVersion.hash.replace(":", "-")}.mica.gz`);
			// Revert to the FIRST (small) version, then forward to the big one.
			await mica.versionsRevert(name, "gz-1", versions[0].hash);
			await mica.versionsRevert(name, "gz-1", bigVersion.hash);
			const read = await mica.blockRead(name, "gz-1");
			return { hasGz, ok: read.includes(payload) };
		}, big);
		expect(result.hasGz).toBe(true);
		expect(result.ok).toBe(true);
	});
});
