import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMetadata, validateEvidence, validateReceipt, publishRelease } from "../scripts/release.mjs";

const source = "a".repeat(40);
const preview = "b".repeat(40);
const digest = "c".repeat(64);
const metadata = {
	pkg: { version: "1.2.3" },
	manifest: { id: "example", version: "1.2.3", minAppVersion: "1.13.0" },
	versions: { "1.2.3": "1.13.0" },
	lock: { version: "1.2.3", packages: { "": { version: "1.2.3" } } },
};
const evidence = {
	source,
	preview,
	previewReport: "https://community.obsidian.md/plugins/example",
	qualificationReport: "https://github.com/owner/example/issues/1",
};
const receipt = {
	schema: 1,
	repository: "owner/example",
	version: "1.2.3",
	tree: "d".repeat(40),
	...evidence,
	assets: Object.fromEntries(
		["main.js", "manifest.json", "styles.css"].map((name) => [name, { sha256: digest, size: 1 }]),
	),
};

test("metadata accepts one exact unprefixed semver authority", () => {
	assert.equal(validateMetadata(metadata), "1.2.3");
	for (const version of ["v1.2.3", "01.2.3", "1.2", "1.2.3-beta.1"]) {
		assert.throws(() => validateMetadata({ ...metadata, manifest: { ...metadata.manifest, version } }));
	}
});

test("metadata rejects package, lock, versions and Cargo drift", () => {
	assert.throws(() => validateMetadata({ ...metadata, pkg: { version: "1.2.4" } }));
	assert.throws(() => validateMetadata({ ...metadata, lock: { ...metadata.lock, version: "1.2.4" } }));
	assert.throws(() => validateMetadata({ ...metadata, versions: {} }));
	assert.throws(() => validateMetadata({ ...metadata, cargo: '[workspace.package]\nversion = "1.2.4"' }));
});

test("evidence requires full exact SHAs and records external reports without claiming verification", () => {
	assert.doesNotThrow(() => validateEvidence(evidence, true));
	assert.throws(() => validateEvidence({ ...evidence, preview: "review" }, true));
	assert.throws(() => validateEvidence({ ...evidence, source: source.slice(0, 7) }, true));
	assert.throws(() => validateEvidence({ ...evidence, previewReport: "http://example.com" }, true));
	assert.throws(() => validateEvidence({ ...evidence, qualificationReport: "" }, true));
	assert.doesNotThrow(() => validateEvidence({ ...evidence, qualificationReport: "" }, false));
});

test("receipt rejects extra public assets, empty files and unbound source", () => {
	assert.doesNotThrow(() =>
		validateReceipt(receipt, { repository: "owner/example", source, preview, version: "1.2.3" }),
	);
	assert.throws(() => validateReceipt({ ...receipt, source: preview }, { source }));
	assert.throws(() =>
		validateReceipt({ ...receipt, assets: { ...receipt.assets, "data.json": { sha256: digest, size: 1 } } }),
	);
	assert.throws(() =>
		validateReceipt({ ...receipt, assets: { ...receipt.assets, "main.js": { sha256: digest, size: 0 } } }),
	);
	assert.throws(() =>
		validateReceipt({ ...receipt, assets: { ...receipt.assets, "main.js": { sha256: "bad", size: 1 } } }),
	);
});

function fakeHost({ existing = null, tag = null, immutable = true, badUpload = false } = {}) {
	const calls = [];
	let release = existing;
	return {
		calls,
		api: async (args) => {
			calls.push(args);
			const endpoint = args[0];
			if (endpoint.endsWith("/releases?per_page=100")) {
				assert.deepEqual(args.slice(1), ["--paginate", "--slurp"]);
				return [release ? [{ ...release, tag_name: "1.2.3" }] : []];
			}
			if (endpoint.endsWith("/git/ref/tags/1.2.3")) return tag;
			if (endpoint.endsWith("/commits/main")) return { sha: source };
			if (endpoint.endsWith("/git/refs")) {
				tag = {
					object: {
						type: "commit",
						sha: source,
						url: "https://api.github.com/repos/owner/example/git/commits/source",
					},
				};
				return {};
			}
			throw new Error(`Unexpected API: ${args}`);
		},
		gh: async (args) => {
			calls.push(args);
			if (args[1] === "create") release = { draft: true, immutable: false, assets: [] };
			if (args[1] === "upload")
				release.assets = badUpload
					? []
					: Object.entries(receipt.assets).map(([name, asset]) => ({
							name,
							digest: `sha256:${asset.sha256}`,
							size: asset.size,
						}));
			if (args[1] === "edit")
				release = {
					draft: false,
					immutable,
					assets: Object.entries(receipt.assets).map(([name, asset]) => ({
						name,
						digest: `sha256:${asset.sha256}`,
						size: asset.size,
					})),
				};
		},
		verifyDownloads: async () => calls.push(["download-and-hash"]),
	};
}

test("publisher refuses existing public releases and never edits their assets", async () => {
	const host = fakeHost({ existing: { draft: false, immutable: true } });
	await assert.rejects(publishRelease(receipt, host, true), /already exists/);
	assert.ok(!host.calls.some((args) => ["create", "upload", "edit"].includes(args[1])));
});

test("publisher refuses unverified immutable settings before any mutation", async () => {
	const host = fakeHost();
	await assert.rejects(publishRelease(receipt, host, false), /immutable/);
	assert.equal(host.calls.length, 0);
});

test("publisher refuses conflicting tags and an advanced main", async () => {
	const host = fakeHost({ tag: { object: { sha: preview, type: "commit" } } });
	await assert.rejects(publishRelease(receipt, host, true), /tag/);
	assert.ok(!host.calls.some((args) => args.includes("POST")));
	const advanced = fakeHost();
	const original = advanced.api;
	advanced.api = (args) => (args[0].endsWith("/commits/main") ? { sha: preview } : original(args));
	await assert.rejects(publishRelease(receipt, advanced, true), /main/);
});

test("publisher refuses ambiguous leftover drafts instead of clobbering them", async () => {
	const host = fakeHost({ existing: { draft: true, immutable: false, assets: [] } });
	await assert.rejects(publishRelease(receipt, host, true), /already exists/);
	assert.ok(!host.calls.some((args) => args[1] === "upload"));
});

test("publisher uploads exactly three assets to a draft before publishing and verifying", async () => {
	const host = fakeHost();
	await publishRelease(receipt, host, true);
	const commands = host.calls.filter((args) => args[0] === "release");
	assert.deepEqual(
		commands.map((args) => args[1]),
		["create", "upload", "edit", "verify", "verify-asset", "verify-asset", "verify-asset"],
	);
	assert.ok(commands[0].includes("--draft"));
	assert.equal(commands[1].filter((arg) => arg.startsWith("release/")).length, 3);
	assert.ok(!commands.flat().includes("--clobber"));
	assert.ok(host.calls.some((args) => args[0] === "download-and-hash"));
});

test("a published but non-immutable result stops delivery without destructive repair", async () => {
	const host = fakeHost({ immutable: false });
	await assert.rejects(publishRelease(receipt, host, true), /immutable/);
	assert.ok(!host.calls.some((args) => args.includes("DELETE") || args.includes("--clobber")));
});

test("incomplete or mismatching draft uploads stop before publication", async () => {
	const host = fakeHost({ badUpload: true });
	await assert.rejects(publishRelease(receipt, host, true), /exactly three assets/);
	assert.ok(!host.calls.some((args) => args[1] === "edit"));
});

test("release workflow is manual-only, least-privilege and pins every action", async () => {
	const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	assert.match(workflow, /\n\s+workflow_dispatch:/);
	assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|pull_request_target|schedule|workflow_run|release):/m);
	assert.match(workflow, /default: false/);
	assert.match(workflow, /permissions:\n\s+contents: read/);
	assert.match(workflow, /publish:[\s\S]*permissions:\n\s+contents: write/);
	assert.match(workflow, /persist-credentials: false/);
	assert.equal(
		(workflow.match(/inputs\.source_sha == github\.sha/g) || []).length,
		2,
		"both jobs must reject unmerged input before checking out executable code",
	);
	assert.match(workflow, /artifact-ids: \$\{\{ needs\.qualify\.outputs\.artifact_id \}\}/);
	assert.match(workflow, /Advisory product compatibility[\s\S]*?continue-on-error: true/);
	for (const [, action, revision] of workflow.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g)) {
		assert.match(revision, /^[0-9a-f]{40}$/, `${action} must be pinned to a full commit`);
	}
});

async function fixture(callback, { differentPreview = false, qualificationRequired = false } = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "obsidian-release-test-"));
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	try {
		await mkdir(path.join(directory, ".github"));
		await mkdir(path.join(directory, "dist"));
		const manifest = `${JSON.stringify(metadata.manifest)}\n`;
		const files = {
			"package.json": JSON.stringify({ ...metadata.pkg, scripts: {} }),
			"package-lock.json": JSON.stringify(metadata.lock),
			"manifest.json": manifest,
			"versions.json": JSON.stringify(metadata.versions),
			".github/obsidian-release.json": JSON.stringify({
				repository: "owner/example",
				assetDirectory: "dist",
				qualificationEvidenceRequired: qualificationRequired,
			}),
			".gitignore": "release/\ndist/\n",
			"source.txt": "qualified source\n",
			"dist/main.js": "module.exports = {};\n",
			"dist/manifest.json": manifest,
			"dist/styles.css": ".example {}\n",
		};
		for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes);
		git("init", "--initial-branch=main");
		git("config", "user.name", "Release fixture");
		git("config", "user.email", "fixture@example.invalid");
		git("add", ".");
		git("commit", "-m", "test: initial candidate");
		const previewSha = git("rev-parse", "HEAD");
		if (differentPreview) {
			await writeFile(path.join(directory, "source.txt"), "changed after preview\n");
			git("add", ".");
		}
		git("commit", "--allow-empty", "-m", "test: merged candidate");
		const sourceSha = git("rev-parse", "HEAD");
		git("update-ref", "refs/remotes/origin/main", sourceSha);
		const env = {
			...process.env,
			SOURCE_SHA: sourceSha,
			PREVIEW_SHA: previewSha,
			PREVIEW_REPORT: evidence.previewReport,
			QUALIFICATION_REPORT: "",
		};
		const cli = (command) =>
			spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/release.mjs", import.meta.url)), command], {
				cwd: directory,
				env,
				encoding: "utf8",
			});
		await callback({ directory, cli, sourceSha, previewSha });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("staging accepts a same-tree merge, binds hashes and rejects tampering", async () => {
	await fixture(async ({ directory, cli, sourceSha, previewSha }) => {
		const staged = cli("stage");
		assert.equal(staged.status, 0, staged.stderr);
		const bound = JSON.parse(await readFile(path.join(directory, "release/receipt.json"), "utf8"));
		assert.equal(bound.source, sourceSha);
		assert.equal(bound.preview, previewSha);
		assert.equal(cli("verify-staged").status, 0);
		await writeFile(path.join(directory, "release/main.js"), "tampered\n");
		assert.notEqual(cli("verify-staged").status, 0);
		assert.notEqual(cli("stage").status, 0, "stale staging directories must not be reused");
	});
});

test("staging rejects content changed after the passing preview", async () => {
	await fixture(
		async ({ cli }) => {
			const result = cli("stage");
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /preview tree/);
		},
		{ differentPreview: true },
	);
});

test("staging rejects mismatching built manifests and missing required qualification", async () => {
	await fixture(async ({ directory, cli }) => {
		await writeFile(path.join(directory, "dist/manifest.json"), "{}\n");
		const result = cli("stage");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /manifest/);
	});
	await fixture(
		async ({ cli }) => {
			assert.notEqual(cli("stage").status, 0);
		},
		{ qualificationRequired: true },
	);
});

test("staged validation rejects symlinks and extra private files", async () => {
	await fixture(async ({ directory, cli }) => {
		assert.equal(cli("stage").status, 0);
		await writeFile(path.join(directory, "release/data.json"), "private settings\n");
		assert.notEqual(cli("verify-staged").status, 0);
		await rm(path.join(directory, "release/data.json"));
		await rm(path.join(directory, "release/main.js"));
		await symlink(path.join(directory, "dist/main.js"), path.join(directory, "release/main.js"));
		assert.notEqual(cli("verify-staged").status, 0);
	});
});

test("advisory runner preserves successful and failing product exit status", async () => {
	for (const status of [0, 7]) {
		await fixture(async ({ directory, cli }) => {
			const packagePath = path.join(directory, "package.json");
			const pkg = JSON.parse(await readFile(packagePath, "utf8"));
			pkg.scripts["release:advisory"] = `node -e 'process.exit(${status})'`;
			await writeFile(packagePath, JSON.stringify(pkg));
			const result = cli("advisory");
			assert.equal(result.status === 0, status === 0, result.stderr);
		});
	}
});
