import {
	applyOpCore,
	applyOpsText as applyOpsTextCore,
	applyOpText as applyOpTextCore,
	type Cst,
} from "../wasm/bridge";

/**
 * A structural edit to a block, expressed against the CST. Every user gesture
 * (typing in a region, adding/removing/renaming/moving tabs, cells, and whole
 * groups, changing grid columns, inserting leaves or groups) becomes one of
 * these and is applied by the SHARED Rust reducer (`apply_op` in mica-core) —
 * the same reducer the `mica` CLI uses — then serialized and dispatched as a
 * single CodeMirror change. `path` is a child-index path from the block root.
 */
export type StructOp =
	| { op: "saveRegion"; path: number[]; start: number; end: number; expected: string; text: string }
	| { op: "insertTab"; path: number[]; at: number }
	| { op: "deleteTab"; path: number[]; index: number }
	| { op: "renameTab"; path: number[]; index: number; title: string }
	| { op: "setTabAttr"; path: number[]; index: number; key: string; value: string | null }
	| { op: "insertCell"; path: number[]; at: number }
	| { op: "deleteCell"; path: number[]; index: number }
	| { op: "setCols"; path: number[]; cols: number }
	| { op: "moveCellInColumn"; path: number[]; from: number; to: number }
	| { op: "insertColumn"; path: number[]; at: number }
	| { op: "insertRow"; path: number[]; atRow: number }
	| { op: "deleteColumn"; path: number[]; at: number }
	| { op: "deleteRow"; path: number[]; atRow: number }
	| { op: "moveColumn"; path: number[]; from: number; to: number }
	| { op: "moveRow"; path: number[]; from: number; to: number }
	| { op: "clearCell"; path: number[]; index: number }
	| { op: "setGroupAttr"; path: number[]; key: string; value: string | null }
	| { op: "insertGroup"; path: number[]; at: number; kind: "tabs" | "grid" }
	| { op: "insertLeaf"; path: number[]; at: number; text: string }
	| { op: "deleteNode"; path: number[] }
	| { op: "duplicateNode"; path: number[] }
	| { op: "moveNode"; from: number[]; toParent: number[]; toIndex: number }
	| { op: "moveRegion"; path: number[]; start: number; end: number; toParent: number[]; toIndex: number };

/** Where the renderer should place focus after an op re-renders the block. */
export interface Reveal {
	path: number[];
	kind: "tab-edit" | "region-edit";
}

/**
 * Apply a structural op via the shared Rust reducer. Returns the new tree and
 * whether anything changed (`false` = the op was rejected as a no-op: missing
 * target, stale `expected` text, or an invalid move — never a partial write).
 */
export function applyOp(cst: Cst, op: StructOp): { changed: boolean; cst: Cst } {
	return applyOpCore(cst, op);
}

/** Parse, reduce, and serialize entirely in Rust for mutation hot paths. */
export function applyOpText(content: string, op: StructOp): { changed: boolean; text: string } {
	return applyOpTextCore(content, op);
}

/** Apply a multi-block gesture's reducer operations atomically. */
export function applyOpsText(content: string, ops: readonly StructOp[]): { changed: boolean; text: string } {
	return applyOpsTextCore(content, ops);
}

/** After an insert, focus the thing that was just created. */
export function revealFor(op: StructOp): Reveal | null {
	switch (op.op) {
		case "insertTab":
			return { path: [...op.path, op.at], kind: "tab-edit" };
		case "insertCell":
			return { path: [...op.path, op.at], kind: "region-edit" };
		case "insertGroup":
			return op.kind === "tabs" ? { path: [...op.path, op.at, 0], kind: "tab-edit" } : null;
		default:
			return null;
	}
}
