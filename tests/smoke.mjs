// Boundary smoke test: instantiate the inlined WASM core in Node and exercise
// every export, including runtime randomness (new_id -> getrandom) and a
// scan/parse/serialize round-trip. Proves the WASM boundary end-to-end without
// launching Obsidian. Run: `pnpm smoke`.

import { readFile } from "node:fs/promises";
import init, {
	block_content_edit,
	diff,
	ensure_ids,
	fold_ledger,
	hash_content,
	migrate_tabs,
	mica_version,
	new_id,
	parse_block,
	scan,
	serialize,
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
assert(hash.startsWith("b3:") && hash.length === 19, `hash: ${hash}`);

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
const mig = migrate_tabs(legacy);
assert(mig.changed && mig.blocks.length === 1, "migrate produced one block");
assert(mig.doc.includes(":::tab Kernel") && mig.doc.includes(":::tab Frame"), "tabs -> directives");
const idAttr = scan(mig.doc)[0].attrs.find(([k]) => k === "id");
assert(idAttr, "migrated block has an id");

const grown = ":::tabs\n:::tab Kernel\nMUCH longer\nline2\nline3\n:::\n:::tab Frame\nframe body\n:::\n:::\n";
const e2 = block_content_edit(mig.doc, idAttr[1], grown);
assert(e2 && e2.insert === grown, "edit computed");
const applied = mig.doc.slice(0, e2.from) + e2.insert + mig.doc.slice(e2.to);
assert(applied.includes("MUCH longer") && !applied.includes("LOYALTY"), "content replaced, not appended");
assert((applied.match(/```mica/g) || []).length === 1, "no duplicated fence");

const dd = diff("a\nb\n", "a\nc\n", "line", 3);
assert(dd.hunks.length >= 1 && typeof dd.similarity === "number", "diff produced hunks");

console.log(`SMOKE OK — core v${version}, id ${id}, ${hash}; migrate+edit+diff verified`);
