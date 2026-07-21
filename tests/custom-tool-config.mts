import assert from "node:assert/strict";
import { normalizeCustomToolConfig } from "../src/ui/customToolConfig.ts";

const result = normalizeCustomToolConfig(
	[
		{ id: "stamp", name: "First", icon: "stamp", template: "one" },
		{ id: "stamp", name: "Second", icon: "stamp", template: "two" },
		{ id: "stamp-2", name: "Reserved", icon: "stamp", template: "three", surface: "code" },
	],
	["custom:stamp", "custom:stamp", "custom:stamp-2"],
);
assert.deepEqual(
	result.customTools.map((tool) => [tool.id, tool.surface]),
	[
		["stamp", "markdown"],
		["stamp-3", "markdown"],
		["stamp-2", "code"],
	],
);
assert.deepEqual(result.toolbarLayout, ["custom:stamp", "custom:stamp-3", "custom:stamp-2"]);
assert.equal(result.changed, true);

const stable = normalizeCustomToolConfig(result.customTools, result.toolbarLayout);
assert.equal(stable.changed, false);
assert.deepEqual(stable.customTools, result.customTools);
assert.deepEqual(stable.toolbarLayout, result.toolbarLayout);

console.log("CUSTOM TOOL CONFIG OK");
