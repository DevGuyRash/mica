import { spawnSync } from "node:child_process";

/**
 * Launch the E2E suite on a virtual display where one is available.
 *
 * Obsidian is a real window. Without this it takes focus every time it starts,
 * and the suite starts it many times per run — enough to make the machine
 * unusable while tests are running. Nothing about the display changes what the
 * DOM does, so the specs are unaffected either way.
 *
 * Falls back to running the suite directly where Xvfb does not exist (macOS,
 * Windows, minimal CI images) so a missing display server can never be the
 * reason a run fails. Re-entry is guarded so an outer `xvfb-run` — as CI or a
 * developer may already use — does not nest a second virtual display.
 */
const forwarded = process.argv.slice(2);
const wdio = ["run", "wdio.conf.mts", ...forwarded];

const alreadyVirtual = process.env.MICA_E2E_XVFB === "1";
const canVirtualize = process.platform === "linux" && !spawnSync("xvfb-run", ["--help"], { stdio: "ignore" }).error;

/**
 * Xvfb provides an X11 display and nothing else. Electron prefers Wayland
 * whenever `WAYLAND_DISPLAY` is set, so on a Wayland desktop the test window
 * connects straight to the real compositor and Xvfb is bypassed — the windows
 * appear and steal focus despite the wrapper. Hiding the Wayland socket from
 * the child forces the X11 backend, which is the virtual display.
 */
function virtualDisplayEnv() {
	const env = { ...process.env, MICA_E2E_XVFB: "1" };
	delete env.WAYLAND_DISPLAY;
	env.XDG_SESSION_TYPE = "x11";
	env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
	return env;
}

/**
 * The virtual screen size is part of the test contract, not a detail.
 *
 * Xvfb defaults to 640x480, where docks do not fit and drag targets fall
 * outside the viewport. But an over-large screen is equally wrong: the
 * responsive action strips promote controls while they fit, so at 1920x1080
 * several specs sit exactly on the boundary where a toolbar may or may not
 * overflow, and they fail intermittently. A laptop-sized screen keeps those
 * layouts unambiguously in their overflowing state.
 *
 * Changing this changes what the suite measures — treat a failure that appears
 * after editing it as a signal about this constant, not about the specs.
 */
const VIRTUAL_SCREEN = "-screen 0 1440x900x24";

const run =
	!alreadyVirtual && canVirtualize
		? spawnSync("xvfb-run", ["-a", "-s", VIRTUAL_SCREEN, "wdio", ...wdio], {
				stdio: "inherit",
				env: virtualDisplayEnv(),
			})
		: spawnSync("wdio", wdio, { stdio: "inherit" });

if (run.error) {
	console.error(`mica: could not start the E2E runner — ${run.error.message}`);
	process.exit(1);
}
process.exit(run.status ?? 1);
