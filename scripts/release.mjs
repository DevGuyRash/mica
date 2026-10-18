import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ASSETS = ["main.js", "manifest.json", "styles.css"];
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CANONICAL = "DevGuyRash/viewgram";
const GH_VERSION = "2.101.0";
const GH_HASH = "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

export function validateMetadata({ pkg, manifest, versions, lock, cargo }) {
	assert.match(manifest.version, SEMVER, "manifest.version must be exact unprefixed x.y.z");
	assert.match(manifest.minAppVersion, SEMVER, "manifest must declare a minimum Obsidian version");
	assert.match(manifest.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, "manifest must declare a stable plugin ID");
	assert.equal(pkg.version, manifest.version, "package and manifest versions must agree");
	assert.equal(versions[manifest.version], manifest.minAppVersion, "versions.json must include the accurate minimum");
	if (lock) {
		assert.equal(lock.version, manifest.version, "lockfile root version must agree");
		assert.equal(lock.packages?.[""]?.version, manifest.version, "lockfile package version must agree");
	}
	if (cargo !== undefined) {
		assert.equal(
			cargo.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1],
			manifest.version,
			"Cargo workspace version must agree",
		);
	}
	return manifest.version;
}

function reportUrl(value, required, label) {
	if (!value && !required) return;
	const url = new URL(value);
	assert.equal(url.protocol, "https:", `${label} must be an HTTPS evidence URL`);
	assert.ok(!url.username && !url.password, "never put credentials in evidence URLs");
}

export function validateEvidence(evidence, qualificationRequired) {
	assert.match(evidence.source, SHA, "source must be a full commit SHA");
	assert.match(evidence.preview, SHA, "preview must be a full commit SHA");
	reportUrl(evidence.previewReport, true, "preview report");
	reportUrl(evidence.qualificationReport, qualificationRequired, "qualification report");
}

export function validateReceipt(receipt, expected = {}) {
	assert.equal(receipt.schema, 1);
	assert.match(receipt.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
	assert.match(receipt.version, SEMVER);
	assert.match(receipt.tree, SHA);
	validateEvidence(receipt, false);
	for (const [key, value] of Object.entries(expected))
		assert.equal(receipt[key], value, `receipt ${key} is not bound to this candidate`);
	assert.deepEqual(Object.keys(receipt.assets).sort(), [...ASSETS].sort(), "exactly three public assets are allowed");
	for (const asset of Object.values(receipt.assets)) {
		assert.match(asset.sha256, HASH);
		assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0, "assets must be nonempty");
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
	return (result.stdout || "").trim();
}

async function metadata() {
	const config = await json(".github/obsidian-release.json");
	const pkg = await json("package.json");
	const manifest = await json("manifest.json");
	const rust = await lstat("rust-toolchain.toml").then(
		() => true,
		(error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		},
	);
	const manager = pkg.packageManager?.startsWith("pnpm@") ? "pnpm" : "npm";
	const version = validateMetadata({
		pkg,
		manifest,
		versions: await json("versions.json"),
		lock: manager === "npm" ? await json("package-lock.json") : undefined,
		cargo: rust ? await readFile("Cargo.toml", "utf8") : undefined,
	});
	const pnpm = manager === "pnpm" ? pkg.packageManager.slice(5) : "";
	assert.ok(!pnpm || SEMVER.test(pnpm), "pnpm must have an exact packageManager pin");
	const toolchain = rust
		? (await readFile("rust-toolchain.toml", "utf8")).match(/^channel\s*=\s*"([^"]+)"/m)?.[1]
		: "";
	assert.ok(!rust || SEMVER.test(toolchain), "Rust must have an exact toolchain pin");
	assert.ok([".", "dist"].includes(config.assetDirectory));
	assert.equal(typeof config.qualificationEvidenceRequired, "boolean");
	assert.match(config.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
	return { ...config, version, manager, pnpm, rust, toolchain, advisory: Boolean(pkg.scripts["release:advisory"]) };
}

function environmentEvidence() {
	return {
		source: process.env.SOURCE_SHA,
		preview: process.env.PREVIEW_SHA,
		previewReport: process.env.PREVIEW_REPORT,
		qualificationReport: process.env.QUALIFICATION_REPORT || "",
	};
}

function checkSource(evidence) {
	const git = (...args) => run("git", args);
	assert.equal(git("rev-parse", "HEAD"), evidence.source, "checkout must be the exact source SHA");
	assert.equal(git("rev-parse", "origin/main"), evidence.source, "source must be the fetched main HEAD");
	assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "tracked source must be clean");
	const tree = git("rev-parse", `${evidence.source}^{tree}`);
	assert.equal(git("rev-parse", `${evidence.preview}^{tree}`), tree, "merged source must equal the preview tree");
	return tree;
}

function checkRemoteAssets(release, receipt) {
	assert.deepEqual(
		release.assets.map((asset) => asset.name).sort(),
		[...ASSETS].sort(),
		"remote release must contain exactly three assets",
	);
	for (const asset of release.assets) {
		assert.equal(asset.digest, `sha256:${receipt.assets[asset.name].sha256}`, `remote ${asset.name} hash differs`);
		assert.equal(asset.size, receipt.assets[asset.name].size, `remote ${asset.name} size differs`);
	}
}

async function findRelease(host, base, tag) {
	// The tag-name endpoint is documented for published releases only. Listing
	// with push access also finds drafts, including interrupted previous runs.
	const pages = await host.api([`${base}/releases?per_page=100`, "--paginate", "--slurp"]);
	assert.ok(
		Array.isArray(pages) && pages.every(Array.isArray),
		"release listing must include all authenticated pages",
	);
	const matches = pages.flat().filter((release) => release.tag_name === tag);
	assert.ok(matches.length <= 1, "ambiguous release state; preserve it for diagnosis");
	return matches[0] || null;
}

async function regularFile(file) {
	const info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0, `${file} must be a nonempty regular file`);
	const bytes = await readFile(file);
	return { sha256: hash(bytes), size: bytes.length };
}

async function stage(config) {
	const evidence = environmentEvidence();
	validateEvidence(evidence, config.qualificationEvidenceRequired);
	const tree = checkSource(evidence);
	assert.deepEqual(
		await readFile(path.join(config.assetDirectory, "manifest.json")),
		await readFile("manifest.json"),
		"built manifest must exactly match root manifest bytes",
	);
	await mkdir("release"); // Refuse stale staging directories instead of silently mixing runs.
	const assets = {};
	for (const name of ASSETS) {
		assets[name] = await regularFile(path.join(config.assetDirectory, name));
		await copyFile(path.join(config.assetDirectory, name), path.join("release", name));
	}
	const receipt = { schema: 1, repository: config.repository, version: config.version, tree, ...evidence, assets };
	validateReceipt(receipt);
	await writeFile("release/receipt.json", `${JSON.stringify(receipt, null, 2)}\n`);
	console.log(JSON.stringify(receipt, null, 2));
	console.log(
		"Evidence URLs record externally reviewed reports; this script does not authenticate or verify their contents.",
	);
}

async function checkStaged(config) {
	const evidence = environmentEvidence();
	validateEvidence(evidence, config.qualificationEvidenceRequired);
	const receipt = await json("release/receipt.json");
	validateReceipt(receipt, {
		repository: config.repository,
		version: config.version,
		...evidence,
		tree: checkSource(evidence),
	});
	assert.deepEqual((await readdir("release")).sort(), [...ASSETS, "receipt.json"].sort());
	for (const name of ASSETS)
		assert.deepEqual(
			await regularFile(path.join("release", name)),
			receipt.assets[name],
			`staged ${name} hash/size changed`,
		);
	assert.deepEqual(await readFile("release/manifest.json"), await readFile("manifest.json"));
	return receipt;
}

export async function publishRelease(receipt, host, immutableSettingConfirmed) {
	validateReceipt(receipt);
	assert.equal(
		immutableSettingConfirmed,
		true,
		"owner-verified immutable releases setting is required; the declaration may be stale",
	);
	const base = `repos/${receipt.repository}`;
	const tag = receipt.version;
	assert.equal(
		(await host.api([`${base}/commits/main`])).sha,
		receipt.source,
		"main advanced; qualify the current candidate",
	);
	const existing = await findRelease(host, base, tag);
	assert.equal(existing, null, "release already exists; preserve all public assets and ambiguous leftover drafts");
	const ref = await host.api([`${base}/git/ref/tags/${tag}`]);
	if (ref) {
		assert.equal(
			ref.object.type,
			"commit",
			"existing tag must directly identify the qualified commit; never rewrite tags",
		);
		assert.equal(ref.object.sha, receipt.source, "existing tag targets another source; never rewrite tags");
	} else {
		await host.api([
			`${base}/git/refs`,
			"--method",
			"POST",
			"-f",
			`ref=refs/tags/${tag}`,
			"-f",
			`sha=${receipt.source}`,
		]);
	}
	const scope = ["--repo", receipt.repository];
	const notes = `Source: ${receipt.source}\nPreview: ${receipt.preview}\nPreview report: ${receipt.previewReport}\nQualification: ${receipt.qualificationReport || "See qualified source PR"}\n\n${ASSETS.map((name) => `${name}: sha256:${receipt.assets[name].sha256}`).join("\n")}\n\nInstallation/activation remains subject to the completed Obsidian full release review.`;
	await host.gh([
		"release",
		"create",
		tag,
		...scope,
		"--verify-tag",
		"--target",
		receipt.source,
		"--draft",
		"--title",
		tag,
		"--notes",
		notes,
	]);
	await host.gh(["release", "upload", tag, ...scope, ...ASSETS.map((name) => `release/${name}`)]);
	const draft = await findRelease(host, base, tag);
	assert.equal(draft.draft, true, "assets must be attached before publication");
	checkRemoteAssets(draft, receipt);
	const finalRef = (await host.api([`${base}/git/ref/tags/${tag}`])).object;
	assert.equal(finalRef.type, "commit", "tag changed before publication; retain the draft");
	assert.equal(finalRef.sha, receipt.source, "tag changed before publication; retain the draft");
	assert.equal(
		(await host.api([`${base}/commits/main`])).sha,
		receipt.source,
		"main changed before publication; retain the draft",
	);
	await host.gh(["release", "edit", tag, ...scope, "--draft=false", "--latest"]);
	const published = await findRelease(host, base, tag);
	assert.equal(published.draft, false);
	assert.equal(
		published.immutable,
		true,
		"release is not immutable; stop delivery, preserve assets and diagnose settings",
	);
	checkRemoteAssets(published, receipt);
	await host.verifyDownloads(receipt);
	await host.gh(["release", "verify", tag, ...scope]);
	for (const name of ASSETS) await host.gh(["release", "verify-asset", tag, `release/${name}`, ...scope]);
}

async function installGh() {
	assert.equal(process.platform, "linux");
	assert.equal(process.arch, "x64");
	const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "obsidian-gh-"));
	const response = await fetch(
		`https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz`,
	);
	assert.ok(response.ok, `GitHub CLI download failed: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	assert.equal(hash(bytes), GH_HASH, "official GitHub CLI archive checksum mismatch");
	const archive = path.join(directory, "gh.tar.gz");
	await writeFile(archive, bytes);
	run("tar", ["-xzf", archive, "-C", directory]);
	await appendFile(process.env.GITHUB_PATH, `${directory}/gh_${GH_VERSION}_linux_amd64/bin\n`);
}

async function parity() {
	const bundle = await json(".github/release-bundle.json");
	assert.equal(bundle.canonical, CANONICAL);
	const source = await json(".github/release-source.json");
	const config = await json(".github/obsidian-release.json");
	assert.deepEqual(Object.keys(bundle.files).sort(), [
		".github/workflows/release.yml",
		"docs/RELEASE-CONTRACT.md",
		"scripts/release.mjs",
		"tests/release-contract.test.mjs",
	]);
	assert.equal(source.role, config.repository === CANONICAL ? "canonical" : "snapshot");
	if (source.role === "snapshot") assert.match(source.commit, SHA, "snapshot must pin a full canonical commit");
	const canonicalIndex = process.argv.indexOf("--canonical");
	const canonicalDirectory = canonicalIndex >= 0 ? process.argv[canonicalIndex + 1] : null;
	for (const [file, expected] of Object.entries(bundle.files)) {
		assert.ok(!file.includes("..") && !path.isAbsolute(file));
		assert.match(expected, HASH);
		assert.equal(hash(await readFile(file)), expected, `release bundle drift: ${file}`);
		if (canonicalDirectory)
			assert.equal(
				hash(await readFile(path.join(canonicalDirectory, file))),
				expected,
				`canonical parity failed: ${file}`,
			);
		if (process.argv.includes("--upstream") && source.role === "snapshot") {
			assert.match(source.commit, SHA, "snapshot must pin a full canonical commit");
			const response = await fetch(`https://raw.githubusercontent.com/${CANONICAL}/${source.commit}/${file}`);
			assert.ok(response.ok, `canonical snapshot read failed: ${response.status}`);
			assert.equal(
				hash(Buffer.from(await response.arrayBuffer())),
				expected,
				`pinned upstream parity failed: ${file}`,
			);
		}
	}
	assert.ok(["canonical", "snapshot"].includes(source.role));
	console.log(`release bundle parity OK (${source.role}; ${Object.keys(bundle.files).length} files)`);
}

async function main() {
	const command = process.argv[2];
	if (command === "parity") return parity();
	if (command === "install-gh") return installGh();
	const config = await metadata();
	if (command === "inspect") {
		if (process.env.GITHUB_REPOSITORY) assert.equal(config.repository, process.env.GITHUB_REPOSITORY);
		for (const key of ["version", "manager", "pnpm", "rust", "toolchain", "advisory"]) {
			console.log(`${key}=${config[key]}`);
			if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${config[key]}\n`);
		}
		return;
	}
	if (command === "advisory") {
		run(config.manager, ["run", "release:advisory"], { stdio: "inherit" });
		return;
	}
	if (command === "candidate") {
		const evidence = environmentEvidence();
		validateEvidence(evidence, config.qualificationEvidenceRequired);
		console.log(`Candidate tree: ${checkSource(evidence)}`);
		return;
	}
	if (command === "stage") return stage(config);
	if (command === "verify-staged") {
		console.log(JSON.stringify(await checkStaged(config), null, 2));
		return;
	}
	if (command === "publish") {
		assert.equal(process.env.GITHUB_REF, "refs/heads/main", "publication dispatch must run from main");
		assert.equal(process.env.GITHUB_REPOSITORY, config.repository);
		const receipt = await checkStaged(config);
		const gh = async (args) => {
			// GitHub may publish the immutable attestation asynchronously. Retry
			// verification reads for a short propagation window, never mutations.
			const verification = ["verify", "verify-asset"].includes(args[1]);
			const deadline = Date.now() + 180_000;
			for (;;) {
				try {
					console.log(run("gh", args));
					return;
				} catch (error) {
					if (!verification || Date.now() >= deadline) throw error;
					console.warn(`Verification pending; retrying in 10 seconds: ${error.message}`);
					await new Promise((resolve) => setTimeout(resolve, 10_000));
				}
			}
		};
		const api = async (args) => {
			const result = spawnSync("gh", ["api", ...args], { encoding: "utf8" });
			if (result.error) throw result.error;
			if (result.status !== 0) {
				if (!args.includes("POST") && /\(HTTP 404\)/.test(result.stderr)) return null;
				throw new Error(`GitHub API failed: ${result.stderr}`);
			}
			return JSON.parse(result.stdout);
		};
		const verifyDownloads = async () => {
			const directory = await mkdtemp(path.join(os.tmpdir(), "obsidian-assets-"));
			try {
				await gh([
					"release",
					"download",
					receipt.version,
					"--repo",
					receipt.repository,
					"--dir",
					directory,
					...ASSETS.flatMap((name) => ["--pattern", name]),
				]);
				for (const name of ASSETS)
					assert.deepEqual(
						await regularFile(path.join(directory, name)),
						receipt.assets[name],
						`downloaded ${name} differs`,
					);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		};
		await publishRelease(
			receipt,
			{ api, gh, verifyDownloads },
			process.env.IMMUTABLE_RELEASES_CONFIRMED === "true",
		);
		console.log(
			"Published release and GitHub verification passed. Obsidian full release review, installation and activation remain separate.",
		);
		return;
	}
	throw new Error(
		"Usage: node scripts/release.mjs inspect|candidate|parity [--canonical DIR|--upstream]|stage|verify-staged|publish|install-gh",
	);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
