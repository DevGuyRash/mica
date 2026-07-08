import { nodeAtPath, parseBlock, serializeCst, type Cst, type MicaNode } from "../wasm/bridge";

type Container = Extract<MicaNode, { kind: "container" }>;

/**
 * A structural edit to a block, expressed against the CST. Every user gesture
 * (typing in a region, adding/removing/renaming a tab, changing grid columns,
 * inserting a group) becomes one of these and is applied by the pure reducer
 * `applyOp`, then serialized and dispatched as a single CodeMirror change.
 * `path` is a child-index path from the block root to the target container.
 */
export type StructOp =
	| { op: "saveRegion"; path: number[]; start: number; end: number; expected: string; text: string }
	| { op: "insertTab"; path: number[]; at: number }
	| { op: "deleteTab"; path: number[]; index: number }
	| { op: "renameTab"; path: number[]; index: number; title: string }
	| { op: "insertCell"; path: number[]; at: number }
	| { op: "deleteCell"; path: number[]; index: number }
	| { op: "setCols"; path: number[]; cols: number }
	| { op: "insertGroup"; path: number[]; at: number; kind: "tabs" | "grid" }
	| { op: "deleteGroup"; path: number[]; index: number };

/** Where the renderer should place focus after an op re-renders the block. */
export interface Reveal {
	path: number[];
	kind: "tab-edit" | "region-edit";
}

export function mkLeaf(text = ""): MicaNode {
	return { kind: "leaf", text, is_code: false };
}

/** New structures are created EMPTY so adding one is not a content change. */
function friendlyTab(title: string): Container {
	return {
		kind: "container",
		name: "tab",
		title,
		colons: 0,
		open_line: `tab: ${title}\n`,
		children: [mkLeaf("")],
		close_line: "",
	};
}

function directiveTab(title: string, colons = 3): Container {
	const c = ":".repeat(colons);
	return {
		kind: "container",
		name: "tab",
		title,
		colons,
		open_line: `${c}tab ${title}\n`,
		children: [mkLeaf("")],
		close_line: `${c}\n`,
	};
}

export function newCell(): Container {
	return {
		kind: "container",
		name: "cell",
		title: "",
		colons: 3,
		open_line: ":::cell\n",
		children: [mkLeaf("")],
		close_line: ":::\n",
	};
}

export function newGrid(cols = 2): Container {
	return {
		kind: "container",
		name: "grid",
		title: `{cols=${cols}}`,
		colons: 3,
		open_line: `:::grid {cols=${cols}}\n`,
		children: [newCell(), newCell()],
		close_line: ":::\n",
	};
}

function groupIsDirective(g: Container): boolean {
	const first = g.children.find((c) => c.kind === "container" && c.name === "tab");
	return Boolean(first && first.kind === "container" && first.open_line.startsWith(":::"));
}

function newTabFor(g: Container): Container {
	if (!groupIsDirective(g)) return friendlyTab("New tab");
	const first = g.children.find((c) => c.kind === "container" && c.name === "tab");
	const colons = first && first.kind === "container" ? first.colons || 3 : 3;
	return directiveTab("New tab", colons);
}

/** A friendly (closer-free) group for empty root blocks, else a `:::tabs` group. */
export function newTabsGroup(directive: boolean): Container {
	return {
		kind: "container",
		name: "tabs",
		title: "",
		colons: directive ? 3 : 0,
		open_line: directive ? ":::tabs\n" : "",
		children: [directive ? directiveTab("New tab") : friendlyTab("New tab")],
		close_line: directive ? ":::\n" : "",
	};
}

function setTabTitle(t: Container, title: string): void {
	if (t.open_line.startsWith(":::")) {
		const c = ":".repeat(t.colons || 3);
		t.open_line = `${c}tab ${title}\n`;
	} else {
		t.open_line = `tab: ${title}\n`;
	}
	t.title = title;
}

function setCols(g: Container, cols: number): void {
	g.title = `{cols=${cols}}`;
	g.open_line = `:::grid {cols=${cols}}\n`;
}

/** The container whose `children` an op targets (`[]` = block root). */
function containerAt(cst: Cst, path: number[]): { children: MicaNode[] } | null {
	if (path.length === 0) return cst;
	const n = nodeAtPath(cst, path);
	return n && n.kind === "container" ? n : null;
}

function namedAt(cst: Cst, path: number[], name: string): Container | null {
	const n = nodeAtPath(cst, path);
	return n && n.kind === "container" && n.name === name ? n : null;
}

/**
 * Apply a structural op to `cst` in place. Returns false (a no-op) when the
 * target can't be found or a `saveRegion`'s expected text no longer matches —
 * so a change that happened underneath the editor is never clobbered.
 */
export function applyOp(cst: Cst, op: StructOp): boolean {
	switch (op.op) {
		case "saveRegion": {
			const t = containerAt(cst, op.path);
			if (!t || op.end > t.children.length || op.start > op.end) return false;
			const run = serializeCst({ children: t.children.slice(op.start, op.end) });
			if (run !== op.expected) return false; // structure changed underneath — abort
			t.children.splice(op.start, op.end - op.start, ...parseBlock(op.text).children);
			return true;
		}
		case "insertTab": {
			const g = namedAt(cst, op.path, "tabs");
			if (!g) return false;
			g.children.splice(op.at, 0, newTabFor(g));
			return true;
		}
		case "deleteTab": {
			const g = namedAt(cst, op.path, "tabs");
			if (!g || !g.children[op.index]) return false;
			g.children.splice(op.index, 1);
			return true;
		}
		case "renameTab": {
			const g = namedAt(cst, op.path, "tabs");
			const t = g?.children[op.index];
			if (!t || t.kind !== "container") return false;
			setTabTitle(t, op.title);
			return true;
		}
		case "insertCell": {
			const g = namedAt(cst, op.path, "grid");
			if (!g) return false;
			g.children.splice(op.at, 0, newCell());
			return true;
		}
		case "deleteCell": {
			const g = namedAt(cst, op.path, "grid");
			if (!g || !g.children[op.index]) return false;
			g.children.splice(op.index, 1);
			return true;
		}
		case "setCols": {
			const g = namedAt(cst, op.path, "grid");
			if (!g) return false;
			setCols(g, Math.max(1, op.cols));
			return true;
		}
		case "insertGroup": {
			const t = containerAt(cst, op.path);
			if (!t) return false;
			const empty = t.children.every((c) => c.kind === "leaf" && !c.text.trim());
			// Nested groups always use explicit `:::` bounds; only an empty root
			// block gets the friendly closer-free form.
			const directive = op.path.length > 0 || !empty;
			t.children.splice(op.at, 0, op.kind === "grid" ? newGrid() : newTabsGroup(directive));
			return true;
		}
		case "deleteGroup": {
			const t = containerAt(cst, op.path);
			if (!t || !t.children[op.index]) return false;
			t.children.splice(op.index, 1);
			return true;
		}
	}
}

/** After an insert, focus the thing that was just created. */
export function revealFor(op: StructOp): Reveal | null {
	switch (op.op) {
		case "insertTab":
			return { path: [...op.path, op.at], kind: "tab-edit" };
		case "insertCell":
			return { path: [...op.path, op.at], kind: "region-edit" };
		case "insertGroup":
			return { path: [...op.path, op.at, 0], kind: op.kind === "grid" ? "region-edit" : "tab-edit" };
		default:
			return null;
	}
}
