/**
 * Nested callouts — callouts authored INSIDE another callout's quoted body
 * (`> > [!tip] …`) — are not structural leaves: they live within the parent
 * region's text. These helpers find them, lift them out (one quote level
 * stripped), and splice edits back, so the UI can offer edit/delete/drag on
 * them through guarded `saveRegion` text surgery.
 */

export interface NestedCallout {
	/** Line range within the region source (`[startLine, endLine)`). */
	startLine: number;
	endLine: number;
	/** Quote depth of its own header (2 = directly inside the region's callout). */
	depth: number;
}

function quoteDepth(line: string): number {
	let depth = 0;
	let rest = line.trimStart();
	while (rest.startsWith(">")) {
		depth++;
		rest = rest.slice(1).trimStart();
	}
	return depth;
}

function afterQuotes(line: string): string {
	let rest = line.trimStart();
	while (rest.startsWith(">")) rest = rest.slice(1).trimStart();
	return rest;
}

/** Strip exactly one leading `> ` (or `>`), preserving deeper quoting. */
function stripOneQuote(line: string): string {
	return line.replace(/^(\s*)> ?/, "$1");
}

/** Re-add one quote level to every line (empty lines become `>`). */
export function requoteOnce(text: string): string {
	return text
		.split("\n")
		.map((l) => (l.length ? `> ${l}` : ">"))
		.join("\n");
}

/**
 * Every nested callout header (depth ≥ 2) in document order — the same order
 * Obsidian renders `.callout .callout` elements, which is what the caller
 * zips these against. Deeper nests are reported too (their extent is their
 * own subtree; an inner header ends the outer sibling scan at equal depth).
 */
export function findNestedCallouts(md: string): NestedCallout[] {
	const lines = md.split("\n");
	const out: NestedCallout[] = [];
	const active: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		const depth = quoteDepth(lines[i]);
		const header = depth >= 2 && afterQuotes(lines[i]).startsWith("[!");
		while (active.length) {
			const top = out[active[active.length - 1]];
			if (depth > top.depth || (depth === top.depth && !header)) break;
			top.endLine = i;
			active.pop();
		}
		if (!header) continue;
		out.push({ startLine: i, endLine: lines.length, depth });
		active.push(out.length - 1);
	}
	return out;
}

/** Materialize a nested callout only when a user starts an action. Keeping
 * discovery range-only avoids reconstructing every overlapping subtree. */
export function dedentNested(md: string, callout: NestedCallout): string {
	return md
		.split("\n")
		.slice(callout.startLine, callout.endLine)
		.map((line) => stripOneQuote(line))
		.join("\n");
}

/** Replace `[startLine, endLine)` with `replacement` (null removes them). */
export function spliceLines(md: string, startLine: number, endLine: number, replacement: string | null): string {
	const lines = md.split("\n");
	lines.splice(startLine, endLine - startLine, ...(replacement === null ? [] : replacement.split("\n")));
	return lines.join("\n");
}
