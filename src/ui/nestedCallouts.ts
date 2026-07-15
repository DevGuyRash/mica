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
	/** The nested callout with ONE quote level stripped (a plain callout). */
	dedented: string;
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
	for (let i = 0; i < lines.length; i++) {
		const depth = quoteDepth(lines[i]);
		if (depth < 2 || !afterQuotes(lines[i]).startsWith("[!")) continue;
		let j = i + 1;
		while (j < lines.length) {
			const dj = quoteDepth(lines[j]);
			if (dj < depth) break;
			if (dj === depth && afterQuotes(lines[j]).startsWith("[!")) break; // sibling
			j++;
		}
		out.push({
			startLine: i,
			endLine: j,
			dedented: lines
				.slice(i, j)
				.map((l) => stripOneQuote(l))
				.join("\n"),
			depth,
		});
	}
	return out;
}

/** Replace `[startLine, endLine)` with `replacement` (null removes them). */
export function spliceLines(md: string, startLine: number, endLine: number, replacement: string | null): string {
	const lines = md.split("\n");
	lines.splice(startLine, endLine - startLine, ...(replacement === null ? [] : replacement.split("\n")));
	return lines.join("\n");
}
