import assert from "node:assert/strict";
import {
	blockNameValidationError,
	displayBlockName,
	noteBasenameFromPath,
	unnamedBlockOrdinals,
} from "../src/identity/blockLabel.ts";

assert.equal(displayBlockName("Explicit", { noteBasename: "Note", unnamedOrdinal: 4 }), "Explicit");
assert.equal(displayBlockName("  Explicit  ", { noteBasename: "Note", unnamedOrdinal: 4 }), "Explicit");
assert.equal(displayBlockName(null, { noteBasename: "Project notes", unnamedOrdinal: 1 }), "Project notes");
assert.equal(displayBlockName("", { noteBasename: "Project notes", unnamedOrdinal: 2 }), "Project notes · 2");
assert.equal(displayBlockName("\t", { noteBasename: "", unnamedOrdinal: 3 }), "Untitled block · 3");
assert.equal(
	displayBlockName(null, { noteBasename: 'A "quoted" `note`', unnamedOrdinal: 1 }),
	'A "quoted" `note`',
	"unsafe fence-attribute characters remain presentation-only",
);

assert.equal(noteBasenameFromPath("Folder/Project notes.md"), "Project notes");
assert.equal(noteBasenameFromPath("Folder\\Windows-style.MD"), "Windows-style");
assert.deepEqual(unnamedBlockOrdinals([null, "Named", "", "  ", "Second name", undefined]), [1, 0, 2, 3, 0, 4]);

assert.equal(blockNameValidationError("A safe block name"), null);
assert.equal(blockNameValidationError("It's valid"), null);
assert.match(blockNameValidationError('Bad "name"') ?? "", /quotation/);
assert.match(blockNameValidationError("Bad `name`") ?? "", /backticks/);
assert.match(blockNameValidationError("Bad\nname") ?? "", /control characters/);
assert.match(blockNameValidationError("Bad\tname") ?? "", /control characters/);
assert.match(blockNameValidationError("Bad\u0085name") ?? "", /control characters/);

console.log("BLOCK LABELS OK");
