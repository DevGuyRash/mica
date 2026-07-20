// Boundary smoke test: instantiate the inlined WASM core in Node and exercise
// every export, including runtime randomness (new_id -> getrandom) and a
// scan/parse/serialize round-trip. Proves the WASM boundary end-to-end without
// launching Obsidian. Run: `pnpm smoke`.

import { readFile } from "node:fs/promises";
import init, {
	apply_op_text,
	apply_ops_text,
	block_content_edit,
	diff,
	ensure_ids,
	fold_ledger,
	guarded_block_content_edit,
	hash_content,
	migrate_tabs,
	mica_version,
	new_id,
	parse_block,
	rewrite_block_id_at,
	scan,
	serialize,
	set_block_attr_edit,
} from "../src/wasm/pkg/mica_core.js";

const bytes = await readFile(new URL("../src/wasm/pkg/mica_core_bg.wasm", import.meta.url));
await init({ module_or_path: bytes });

function assert(cond, msg) {
	if (!cond) {
		console.error("FAIL:", msg);
		process.exit(1);
	}
}

const version = mica_version();
assert(typeof version === "string" && version.length > 0, "version");

const id = new_id(); // exercises getrandom at runtime on wasm
assert(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/.test(id), `uuidv7 shape: ${id}`);

const hash = hash_content("hello");
assert(/^b3:[0-9a-f]{64}$/.test(hash), `hash: ${hash}`);

const doc = "text\n````mica\n:::tab A\nhi\n```js\nx\n```\n:::\n````\nafter\n";
const spans = scan(doc);
assert(spans.length === 1 && spans[0].closed, `scan found ${spans.length} block(s)`);
assert(spans[0].fence_len === 4, `outer fence length ${spans[0].fence_len}`);

const content = doc.slice(spans[0].content_start, spans[0].content_end);
const cst = parse_block(content);
assert(cst.children.length === 1 && cst.children[0].kind === "container", "parsed a tab container");
assert(serialize(cst) === content, "round-trip serialize == content");

// M3 boundary: identity + ledger fold.
const withIds = ensure_ids("```mica\nx\n```\n");
assert(/^```mica id=[0-9a-f-]{36}\n/.test(withIds), `ensure_ids adds an id: ${withIds}`);

const state = fold_ledger([
	{ type: "add-version", eid: "e1", ts: 1, block: "b", hash: "h1" },
	{ type: "set-head", eid: "s1", ts: 1, block: "b", hash: "h1" },
	{ type: "add-version", eid: "e2", ts: 2, block: "b", hash: "h2" },
	{ type: "set-head", eid: "s2", ts: 2, block: "b", hash: "h2" },
]);
assert(state && typeof state === "object" && !(state instanceof Map), "fold_ledger returns a plain object");
assert(state.b?.head === "h2" && state.b?.versions?.length === 2, `fold_ledger state: ${JSON.stringify(state)}`);

// M8 end-to-end: migrate a legacy tabs note, then edit the migrated block and
// confirm a clean, non-appending replace using real JS (UTF-16) string offsets.
const legacy =
	"# Note\n\n`````tabs\ntab: Kernel\n> [!success]- Kernel (V1.0)\n> ````md\n> LOYALTY\n> ````\ntab: Frame\nframe body\n`````\n\ntail\n";
const mig = migrate_tabs(legacy, "success, bug, todo");
assert(mig.changed && mig.blocks.length === 1, "migrate produced one block");
assert(mig.doc.includes("```mica") && !mig.doc.includes("`````tabs"), "converted to a mica block");
assert(mig.doc.includes("tab: Kernel") && mig.doc.includes("tab: Frame"), "friendly tab: syntax preserved");
assert(!mig.doc.includes(":::"), "friendly output has no colon-fence scaffolding");
const idAttr = scan(mig.doc)[0].attrs.find(([k]) => k === "id");
assert(idAttr, "migrated block has an id");

const grown = "tab: Kernel\nMUCH longer\nline2\nline3\n\ntab: Frame\nframe body\n";
const e2 = block_content_edit(mig.doc, idAttr[1], grown);
assert(e2 && e2.insert === grown, "edit computed");
const applied = mig.doc.slice(0, e2.from) + e2.insert + mig.doc.slice(e2.to);
assert(applied.includes("MUCH longer") && !applied.includes("LOYALTY"), "content replaced, not appended");
assert((applied.match(/```mica/g) || []).length === 1, "no duplicated fence");

// Fresh-scan edit contracts: ambiguous ids reject, exact occurrence repair and
// header-only edits return minimal UTF-16 changes, and reducer batches commit
// atomically without round-tripping a JS CST.
const duplicateId = "legacy-short";
const duplicateDoc = `😀 prose id=${duplicateId}\n\`\`\`mica id=${duplicateId} name=One\na\n\`\`\`\n\n\`\`\`mica id=${duplicateId} name=Two\nb\n\`\`\`\n\n\`\`\`mica id=${duplicateId} name=Three\nc\n\`\`\`\n`;
assert(
	guarded_block_content_edit(duplicateDoc, duplicateId, "a\n", "changed\n") === null,
	"guarded by-id edit rejects duplicate identity",
);
const duplicateSpans = scan(duplicateDoc);
assert(duplicateSpans.length === 3, "duplicate fixture scans three times");
const freshIds = [new_id(), new_id()];
// The leading emoji occupies two UTF-16 code units but four UTF-8 bytes.
const startsDescending = ["Three", "Two"].map((name) =>
	duplicateDoc.indexOf(`\`\`\`mica id=${duplicateId} name=${name}`),
);
let repaired = duplicateDoc;
for (let i = 0; i < startsDescending.length; i++) {
	const idEdit = rewrite_block_id_at(repaired, startsDescending[i], duplicateId, freshIds[i]);
	assert(idEdit, "exact duplicate-id occurrence produced an edit");
	repaired = repaired.slice(0, idEdit.from) + idEdit.insert + repaired.slice(idEdit.to);
}
assert((repaired.match(new RegExp(`id=${duplicateId}`, "g")) || []).length === 2, "one block id plus prose remain");
assert(repaired.startsWith(`😀 prose id=${duplicateId}`), "prose id lookalike was not rewritten");
assert(
	freshIds.every((freshId) => repaired.includes(freshId)),
	"every copy received a fresh id",
);
const attrEdit = set_block_attr_edit(repaired, freshIds[0], "name", "Repaired");
assert(attrEdit && attrEdit.to - attrEdit.from < repaired.length, "attribute edit is header-only");

const reducerInput = "tab: One\nbody\n";
const reduced = apply_op_text(reducerInput, { op: "renameTab", path: [0], index: 0, title: "Two" });
assert(reduced.changed && reduced.text.startsWith("tab: Two\n"), "coarse reducer edit succeeded");
const rejectedBatch = apply_ops_text(reducerInput, [
	{ op: "renameTab", path: [0], index: 0, title: "Two" },
	{ op: "deleteTab", path: [0], index: 99 },
]);
assert(!rejectedBatch.changed && rejectedBatch.text === reducerInput, "reducer batch rejected atomically");

const dd = diff("a\nb\n", "a\nc\n", "line", 3);
assert(dd.hunks.length >= 1 && typeof dd.similarity === "number", "diff produced hunks");

console.log(`SMOKE OK — core v${version}, id ${id}, ${hash}; migrate+edit+diff verified`);
