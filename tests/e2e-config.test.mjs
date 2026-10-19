import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
// Frozen launcher-maintainer evidence, not a claim that the app was downloaded
// or that a browser profile ran. Update deliberately if the minimum changes.
const compatibility = JSON.parse(
	await readFile(new URL("./fixtures/obsidian-1.13.0-compatibility.json", import.meta.url), "utf8"),
);

function profileConfig(profile) {
	const env = { ...process.env };
	if (profile === undefined) delete env.MICA_E2E_PROFILE;
	else env.MICA_E2E_PROFILE = profile;
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			'const {config} = await import("./wdio.conf.mts"); console.log(JSON.stringify(config.capabilities));',
		],
		{ cwd: new URL("..", import.meta.url), env, encoding: "utf8" },
	);
}

for (const profile of [undefined, "minimum", "mobile"]) {
	test(`${profile ?? "default"} retains the manifest minimum and oldest supported installer`, () => {
		const result = profileConfig(profile);
		assert.equal(result.status, 0, result.stderr);
		const [capability] = JSON.parse(result.stdout);
		assert.equal(
			compatibility.version,
			manifest.minAppVersion,
			"a minimum change needs a reviewed compatibility snapshot",
		);
		assert.equal(
			capability.browserVersion,
			manifest.minAppVersion,
			"a current app must never substitute for the minimum gate",
		);
		const options = capability["wdio:obsidianOptions"];
		assert.equal(
			options.installerVersion,
			compatibility.minInstallerVersion,
			"the pinned minimum profile must use the oldest supported installer, never stale 1.5.8 or a convenience cache",
		);
		assert.deepEqual(options.plugins, ["."]);
		assert.equal(options.vault, "tests/e2e/vault");
		assert.equal(options.emulateMobile, profile === "mobile" ? true : undefined);
	});
}

test("moving latest remains a separate advisory target", () => {
	const result = profileConfig("desktop-latest");
	assert.equal(result.status, 0, result.stderr);
	const [capability] = JSON.parse(result.stdout);
	assert.equal(capability.browserVersion, "latest");
	assert.equal(capability["wdio:obsidianOptions"].installerVersion, "latest");
});

test("unknown profiles fail instead of selecting a convenient fallback", () => {
	const result = profileConfig("current-instead-of-minimum");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /unknown MICA_E2E_PROFILE/);
});
