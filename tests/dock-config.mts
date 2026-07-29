import assert from "node:assert/strict";
import { DEFAULT_DOCK_ACTION_LAYOUT, normalizeDockActionLayout } from "../src/ui/dockConfig.ts";
import {
	automaticDockBoundary,
	compactDockTargetLabel,
	copyTargetForScope,
	dockCopyTargetDescription,
	DockScopeCursorIndex,
	DockTargetController,
} from "../src/ui/dockScope.ts";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";
import { buildScopeIndexFromCst } from "../src/ui/versionScopeCore.ts";

assert.deepEqual(normalizeDockActionLayout(undefined), DEFAULT_DOCK_ACTION_LAYOUT);
assert.deepEqual(normalizeDockActionLayout(["copy", "copy", "unknown", "history"]), ["copy", "history"]);
assert.deepEqual(normalizeDockActionLayout([]), []);

const leaf = (text: string): MicaNode => ({ kind: "leaf", text, is_code: false });
const container = (name: string, title: string, children: MicaNode[]): MicaNode => ({
	kind: "container",
	name,
	title,
	colons: 3,
	open_line: `:::${name}${title ? ` ${title}` : ""}\n`,
	children,
	close_line: ":::\n",
});
const gridNode = container("grid", "{cols=2}", [
	container("cell", "", [leaf("left\n")]),
	container("cell", "", [leaf("right\n")]),
]);
const tabsNode = container("tabs", "", [
	container("tab", "First", [leaf("First intro\n"), gridNode]),
	container("tab", "Second", [leaf("```js\ntwo()\n```\n")]),
]);
const cst: Cst = { children: [tabsNode] };
const serialize = (node: MicaNode): string =>
	node.kind === "leaf" ? node.text : node.open_line + node.children.map(serialize).join("") + node.close_line;
const source = cst.children.map(serialize).join("");
const index = buildScopeIndexFromCst(source, cst);
const firstTab = index.scopes.find((scope) => scope.kind === "tab" && scope.siblingOrdinal === 0)!;
const grid = index.scopes.find((scope) => scope.kind === "grid")!;
const leftCell = index.scopes.find((scope) => scope.kind === "cell" && scope.siblingOrdinal === 0)!;
const leftText = index.scopes.find((scope) => scope.kind === "section" && scope.parentKey === leftCell.key)!;
assert.equal(automaticDockBoundary(index, grid).key, firstTab.key, "a grid inside a tab remains tab-owned");
assert.equal(automaticDockBoundary(index, leftText).key, firstTab.key, "a cell descendant remains tab-owned");

let pin: ReturnType<typeof import("../src/ui/versionScope.ts").locatorFor> | undefined;
let mode: "contextual" | "block" | "manual" = "contextual";
const controller = new DockTargetController(index, cst, () => mode, {
	get: () => pin,
	set: (value) => {
		pin = value;
	},
});
controller.setAutomatic(leftText.key);
assert.equal(controller.current().scope.key, firstTab.key);
assert.equal(compactDockTargetLabel(controller.current()), "First");
assert.equal(dockCopyTargetDescription(controller.current()), "tab “First”");
controller.setFocused(leftText.key);
assert.equal(controller.current().scope.key, leftText.key, "focus may descend beneath a tab boundary");
controller.pin(leftCell.key);
controller.setFocused(null);
assert.equal(controller.current().scope.key, leftCell.key);
controller.resumeAutomatic();
assert.equal(controller.current().scope.key, firstTab.key);
mode = "block";
assert.equal(controller.current().scope.kind, "block");
mode = "manual";
assert.equal(controller.current().scope.kind, "block");

const cursor = new DockScopeCursorIndex(index);
assert.equal(cursor.containing(leftText.start + 1).key, leftText.key);
assert.equal(cursor.containing(leftCell.start, leftCell.end).key, leftCell.key);
assert.equal(cursor.containing(firstTab.start, firstTab.end).key, firstTab.key);

const copiedTab = copyTargetForScope(cst, source, firstTab);
assert.ok(copiedTab && "nodes" in copiedTab);
assert.equal(copiedTab && "nodes" in copiedTab ? copiedTab.nodes.length : 0, 1);
const copiedText = copyTargetForScope(cst, source, leftText);
assert.deepEqual(copiedText, { text: "left\n" });

console.log("dock configuration and scope contracts passed");
