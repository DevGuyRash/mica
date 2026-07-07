#!/usr/bin/env sh
# Contract tests driven through the official Obsidian CLI (https://obsidian.md/cli).
#
# The CLI talks to the RUNNING desktop app, so these tests exercise the real
# plugin runtime in your real vault — but only ever touch a scratch note under
# mica-e2e-scratch/. Non-brittle by design: every assertion is a plugin-owned
# contract (window.mica results, file contents), never Obsidian internals.
#
# Requirements (one-time):
#   1. Update Obsidian to a version that ships the CLI.
#   2. Settings → activate the command line interface.
#   3. Register the CLI so `obsidian` is on PATH.
# If any requirement is missing this script SKIPS (exit 0) with instructions.
set -u

SCRATCH_DIR="mica-e2e-scratch"
NOTE="$SCRATCH_DIR/cli-contract.md"
FAILURES=0

if ! command -v obsidian >/dev/null 2>&1; then
	echo "SKIP: 'obsidian' CLI not on PATH."
	echo "  Enable it: update Obsidian → Settings → activate CLI → register."
	echo "  Docs: https://obsidian.md/cli"
	exit 0
fi

# The desktop app's own launcher is also called `obsidian`. Never probe that —
# passing args to the Electron binary could poke the user's live session. The
# registered CLI shim lives elsewhere (e.g. ~/.local/bin on Linux).
OBSIDIAN_BIN=$(command -v obsidian)
case "$(readlink -f "$OBSIDIAN_BIN" 2>/dev/null || printf '%s' "$OBSIDIAN_BIN")" in
*/usr/bin/obsidian | */usr/lib/obsidian/* | *electron*)
	echo "SKIP: '$OBSIDIAN_BIN' is the desktop app launcher, not the CLI shim."
	echo "  Activate the CLI in Obsidian Settings and register it, then re-run."
	echo "  Docs: https://obsidian.md/cli"
	exit 0
	;;
esac

if ! obsidian eval "1 + 1" >/dev/null 2>&1; then
	echo "SKIP: 'obsidian' CLI present but not responding (is the app running with the CLI activated?)."
	exit 0
fi

# eval_js <js> — print the CLI's result for a (synchronous) expression.
eval_js() {
	obsidian eval "$1" 2>/dev/null
}

# fire_async <js-promise-expr> — run an async expression, parking its result in
# a global; await_global then polls it. Robust regardless of the CLI's own
# Promise semantics.
fire_async() {
	eval_js "(async () => { window.__micaE2E = 'pending'; try { window.__micaE2E = JSON.stringify(await ($1)); } catch (e) { window.__micaE2E = 'ERROR: ' + (e && e.message); } })() && 'fired'" >/dev/null
}

await_global() {
	for _ in $(seq 1 40); do
		result=$(eval_js "window.__micaE2E ?? 'pending'")
		[ "$result" != "pending" ] && {
			printf '%s' "$result"
			return 0
		}
		sleep 0.25
	done
	printf 'TIMEOUT'
	return 1
}

check() {
	desc="$1" got="$2" want_pattern="$3"
	if printf '%s' "$got" | grep -q "$want_pattern"; then
		echo "PASS: $desc"
	else
		echo "FAIL: $desc"
		echo "      wanted match: $want_pattern"
		echo "      got: $got"
		FAILURES=$((FAILURES + 1))
	fi
}

echo "== Mica contract tests via official Obsidian CLI =="

check "plugin is active" "$(eval_js "!!app.plugins.plugins['mica']")" "true"
check "window.mica API present" "$(eval_js "typeof window.mica?.blockUpdate")" "function"
check "core version reachable" "$(eval_js "window.mica.version()")" "[0-9][0-9.]*"

# Arrange: scratch note with a block (unique token per run).
TOKEN="cli-$(date +%s)"
fire_async "app.vault.createFolder('$SCRATCH_DIR').catch(() => {}).then(() => app.vault.create('$NOTE', ['before', '\\\`\\\`\\\`mica id=$TOKEN', 'original body', '\\\`\\\`\\\`', 'tail'].join('\\n')).catch(() => {}))"
await_global >/dev/null

check "block is listed by id" "$(
	fire_async "window.mica.blockList('$NOTE')"
	await_global
)" "$TOKEN"

# The anti-corruption contract: grow the content, then verify exact replacement.
fire_async "window.mica.blockUpdate('$NOTE', '$TOKEN', 'GROWN 1\\nGROWN 2\\nGROWN 3\\n')"
await_global >/dev/null
AFTER=$(
	fire_async "app.vault.read(app.vault.getAbstractFileByPath('$NOTE'))"
	await_global
)
check "grown content present" "$AFTER" "GROWN 3"
if printf '%s' "$AFTER" | grep -q "original body"; then
	echo "FAIL: old content survived the update (append bug)"
	FAILURES=$((FAILURES + 1))
else
	echo "PASS: old content fully replaced"
fi
check "trailing prose intact" "$AFTER" "tail"

# Cleanup scratch.
fire_async "Promise.resolve(app.vault.getAbstractFileByPath('$SCRATCH_DIR')).then(f => f ? app.fileManager.trashFile(f) : 'absent')"
await_global >/dev/null

echo "== done: $FAILURES failure(s) =="
[ "$FAILURES" -eq 0 ]
