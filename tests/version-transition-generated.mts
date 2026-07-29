import assert from "node:assert/strict";
import type { Cst, MicaNode } from "../src/wasm/bridge.ts";
import { buildScopeIndexFromCst, type ScopeIndex } from "../src/ui/versionScopeCore.ts";
import { buildScopeTransition } from "../src/ui/versionTransition.ts";

interface Item {
	id: number;
	label: string;
	body: string;
}
interface Model {
	tabs: Item[];
	cells: Item[];
}
interface Snapshot {
	index: ScopeIndex;
	identity: Map<string, number>;
}

const words = [
	"amber",
	"birch",
	"cobalt",
	"delta",
	"ember",
	"fjord",
	"grove",
	"harbor",
	"iris",
	"juniper",
	"kestrel",
	"lumen",
	"meadow",
	"nectar",
	"opal",
	"prairie",
	"quartz",
	"river",
	"spruce",
	"tundra",
	"umber",
	"violet",
	"willow",
	"xylem",
	"yarrow",
	"zephyr",
];

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
const serialize = (node: MicaNode): string =>
	node.kind === "leaf" ? node.text : node.open_line + node.children.map(serialize).join("") + node.close_line;

function snapshot(model: Model): Snapshot {
	const tabs = container(
		"tabs",
		"",
		model.tabs.map((item) => container("tab", item.label, [leaf(`${item.body}\n`)])),
	);
	const grid = container(
		"grid",
		"{cols=3}",
		model.cells.map((item) => container("cell", "", [leaf(`${item.body}\n`)])),
	);
	const children = [tabs, grid];
	const cst: Cst = { children };
	const index = buildScopeIndexFromCst(children.map(serialize).join(""), cst);
	const identity = new Map<string, number>();
	for (const [at, item] of model.tabs.entries()) {
		identity.set(`tab:0.${at}`, item.id);
		identity.set(`section:0.${at}:0-1`, item.id);
	}
	for (const [at, item] of model.cells.entries()) {
		identity.set(`cell:1.${at}`, item.id);
		identity.set(`section:1.${at}:0-1`, item.id);
	}
	return { index, identity };
}

function rng(seed: number): () => number {
	let state = seed | 0;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x1_0000_0000;
	};
}

function makeBody(random: () => number, serial: number): string {
	const picked = Array.from({ length: 7 }, () => words[Math.floor(random() * words.length)]);
	return `${picked.join(" ")} topic ${serial}`;
}

function initial(seed: number, random: () => number): Model {
	let id = seed * 100;
	return {
		tabs: Array.from({ length: 4 }, (_, at) => ({
			id: id++,
			label: `Topic ${String.fromCharCode(65 + at)}`,
			body: makeBody(random, id),
		})),
		cells: Array.from({ length: 9 }, (_, at) => ({
			id: id++,
			label: "",
			body: makeBody(random, id + at),
		})),
	};
}

function mutate(model: Model, seed: number, random: () => number): Model {
	const next: Model = {
		tabs: model.tabs.map((item) => ({ ...item })),
		cells: model.cells.map((item) => ({ ...item })),
	};
	const edit = (items: Item[]): void => {
		if (!items.length) return;
		const item = items[Math.floor(random() * items.length)];
		const tokens = item.body.split(" ");
		tokens[Math.floor(random() * Math.max(1, tokens.length - 2))] = words[Math.floor(random() * words.length)];
		item.body = tokens.join(" ");
	};
	edit(next.tabs);
	edit(next.cells);
	if (random() < 0.65 && next.tabs.length) {
		const item = next.tabs[Math.floor(random() * next.tabs.length)];
		item.label = `${item.label.replace(/\s+\d+$/, "")} ${seed}`;
	}
	if (random() < 0.75) shuffle(next.tabs, random);
	if (random() < 0.75) shuffle(next.cells, random);
	if (random() < 0.4 && next.tabs.length > 2) next.tabs.splice(Math.floor(random() * next.tabs.length), 1);
	if (random() < 0.4 && next.cells.length > 5) next.cells.splice(Math.floor(random() * next.cells.length), 1);
	if (random() < 0.7) {
		const id = seed * 100 + 90;
		next.tabs.splice(Math.floor(random() * (next.tabs.length + 1)), 0, {
			id,
			label: `New topic ${seed}`,
			body: makeBody(random, id),
		});
	}
	if (random() < 0.7) {
		const id = seed * 100 + 91;
		next.cells.splice(Math.floor(random() * (next.cells.length + 1)), 0, {
			id,
			label: "",
			body: makeBody(random, id),
		});
	}
	return next;
}

function shuffle<T>(values: T[], random: () => number): void {
	for (let at = values.length - 1; at > 0; at--) {
		const other = Math.floor(random() * (at + 1));
		[values[at], values[other]] = [values[other], values[at]];
	}
}

function parseSeeds(): number {
	const raw = process.argv.find((arg) => arg.startsWith("--seeds="))?.slice("--seeds=".length);
	const parsed = Number.parseInt(raw ?? "250", 10);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(20_000, parsed)) : 250;
}

const seeds = parseSeeds();
let checkedMatches = 0;
for (let seed = 1; seed <= seeds; seed++) {
	const random = rng(seed);
	const beforeModel = initial(seed, random);
	const afterModel = mutate(initial(seed, rng(seed)), seed, random);
	const before = snapshot(beforeModel);
	const after = snapshot(afterModel);
	const transition = buildScopeTransition(before.index, after.index);
	for (const match of transition.forward.values()) {
		const fromId = before.identity.get(match.from.key);
		const toId = after.identity.get(match.to.key);
		if (fromId === undefined || toId === undefined) continue;
		assert.equal(
			fromId,
			toId,
			`seed ${seed}: ${match.from.key} was incorrectly paired with ${match.to.key}; replay with --seeds=${seed}; ` +
				`evidence=${JSON.stringify(match.evidence)} score=${match.score}; ` +
				`before=${JSON.stringify(beforeModel)} after=${JSON.stringify(afterModel)}`,
		);
		checkedMatches++;
	}
	for (const [key, id] of after.identity) {
		if ([...before.identity.values()].includes(id)) continue;
		assert.ok(
			transition.added.has(key) || transition.ambiguousTo.has(key),
			`seed ${seed}: new scope ${key} was neither added nor safely unresolved`,
		);
	}
}
assert.ok(checkedMatches >= seeds * 4, "the generated corpus must exercise accepted identities");
console.log(`VERSION TRANSITION GENERATED OK — ${seeds} seeds, ${checkedMatches} verified matches`);
