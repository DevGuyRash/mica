import type { MicaNode } from "../wasm/bridge";

/** Exact structural identity carried by a mounted clipboard action. */
export interface CopySelectionRef {
	readonly blockId: string | null;
	readonly path: readonly number[];
	readonly expectedKind: MicaNode["kind"];
	readonly expectedName: string | null;
	readonly expectedSource: string;
}

/** Resolve one clipboard selection against the current CST. There is
 * deliberately no ancestor fallback: a stale section action must fail rather
 * than copy a surrounding tab, grid, or block. */
export function resolveExactCopySelection(
	nodes: readonly MicaNode[],
	selection: Pick<CopySelectionRef, "path" | "expectedKind" | "expectedName" | "expectedSource">,
): MicaNode | null {
	let current: MicaNode | null = null;
	let children = nodes;
	for (const index of selection.path) {
		current = children[index] ?? null;
		if (!current) return null;
		children = current.kind === "container" ? current.children : [];
	}
	if (!current || current.kind !== selection.expectedKind) return null;
	if (current.kind === "container" && selection.expectedName !== null && current.name !== selection.expectedName)
		return null;
	return matchesSerializedNode(current, selection.expectedSource) ? current : null;
}

/** Validate against the exact mounted source without allocating a second copy
 * of the selected subtree. A mismatch stops at its first divergent segment. */
function matchesSerializedNode(node: MicaNode, expected: string): boolean {
	let offset = 0;
	const match = (text: string): boolean => {
		if (!expected.startsWith(text, offset)) return false;
		offset += text.length;
		return true;
	};
	const stack: Array<{ nodes: readonly MicaNode[]; index: number; close: string }> = [
		{ nodes: [node], index: 0, close: "" },
	];
	while (stack.length) {
		const frame = stack[stack.length - 1];
		const current = frame.nodes[frame.index++];
		if (!current) {
			if (!match(frame.close)) return false;
			stack.pop();
			continue;
		}
		if (current.kind === "leaf") {
			if (!match(current.text)) return false;
		} else {
			if (!match(current.open_line)) return false;
			stack.push({ nodes: current.children, index: 0, close: current.close_line });
		}
	}
	return offset === expected.length;
}
