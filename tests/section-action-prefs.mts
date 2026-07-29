import assert from "node:assert/strict";
import {
	filterSectionActions,
	normalizeHiddenSectionActions,
	sectionActionPreferenceId,
} from "../src/ui/sectionActionPrefs.ts";

assert.deepEqual(normalizeHiddenSectionActions(undefined), { hidden: [], changed: false });
assert.deepEqual(normalizeHiddenSectionActions(["copy", "convert", "copy", "future-action", 3]), {
	hidden: ["copy", "convert"],
	changed: true,
});
assert.deepEqual(normalizeHiddenSectionActions(["delete", "fold"]), {
	hidden: ["delete", "fold"],
	changed: false,
});

assert.equal(sectionActionPreferenceId("copy-code"), "copy");
assert.equal(sectionActionPreferenceId("convert-callout"), "convert");
assert.equal(sectionActionPreferenceId("combine-previous"), "combine");
assert.equal(sectionActionPreferenceId("lightbox"), "lightbox");
assert.equal(sectionActionPreferenceId("future-action"), null);

const actions = [
	{ id: "copy", label: "Copy" },
	{ id: "edit", label: "Edit" },
	{ id: "convert-code", label: "Convert" },
	{ id: "combine-next", label: "Combine" },
	{ id: "delete", label: "Delete" },
	{ id: "future-action", label: "Future" },
];
assert.deepEqual(
	filterSectionActions(actions, new Set(["copy", "convert", "combine", "delete"])).map((action) => action.id),
	["edit", "future-action"],
);
assert.deepEqual(filterSectionActions(actions, undefined), actions);

// Every combine variant — pairwise, mixed, and whole-run — shares one
// user-facing toggle, so hiding "combine" hides all of them together.
for (const id of ["combine-previous", "combine-next", "combine-next-mixed", "combine-run-4"]) {
	assert.equal(sectionActionPreferenceId(id), "combine", `${id} is a combine action`);
}

console.log("SECTION ACTION PREFS OK");
