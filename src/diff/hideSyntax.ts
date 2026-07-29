import type { Cst, MicaNode } from "../wasm/bridge";

/**
 * Remove Mica's container scaffolding from a snapshot before diffing.
 *
 * A line-prefix filter cannot do this correctly in either direction. It deletes
 * authored content that merely begins with `:::` — silently dropping real
 * changes out of a diff — and it cannot recognise a closer that is not at the
 * start of its line. The CST already records exactly which bytes are a
 * container's opening and closing lines, so scaffolding is identified rather
 * than guessed.
 *
 * Malformed historical content is deliberately left alone: where a closer was
 * once serialized glued onto a leaf (`a:::`), the parser sees leaf text, and
 * text is what the user wrote. Inventing structure to hide it would be a second
 * guess on top of the first.
 */
export function stripStructuralLines(cst: Cst): string {
	const kept: string[] = [];
	appendContent(cst.children, kept);
	return kept.join("");
}

function appendContent(nodes: readonly MicaNode[], out: string[]): void {
	for (const node of nodes) {
		if (node.kind === "leaf") {
			out.push(node.text);
			continue;
		}
		// `open_line` and `close_line` are the container's own syntax; its
		// children carry everything the user typed.
		appendContent(node.children, out);
	}
}
