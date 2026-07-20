import { parser as markdownParser } from "@lezer/markdown";

/** A source-backed Markdown section quoted inside one or more blockquotes. */
export interface NestedSourceSection {
	/** Line range within the region source (`[startLine, endLine)`). */
	startLine: number;
	endLine: number;
	/** Quote depth at the section opener. */
	depth: number;
}

/**
 * Nested callouts — callouts authored INSIDE another callout's quoted body
 * (`> > [!tip] …`) — are not structural leaves: they live within the parent
 * region's text. Their source span is the authority for every later action.
 */
export type NestedCallout = NestedSourceSection;

/** A fenced code block living inside at least one quoted callout/body level. */
export interface NestedCodeBlock extends NestedSourceSection {
	fenceChar: "`" | "~";
	fenceLength: number;
	/** Trimmed CommonMark info string; empty fences keep an empty string. */
	info: string;
	closed: boolean;
}

export interface NestedSections {
	callouts: NestedCallout[];
	codeBlocks: NestedCodeBlock[];
}

interface SourceLine {
	content: string;
	eol: string;
	start: number;
}

type FenceRange = NestedCodeBlock;

function sourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	let pos = 0;
	while (pos < source.length) {
		const code = source.charCodeAt(pos);
		if (code !== 10 && code !== 13) {
			pos++;
			continue;
		}
		const eol = code === 13 && source.charCodeAt(pos + 1) === 10 ? "\r\n" : source[pos];
		lines.push({ content: source.slice(start, pos), eol, start });
		pos += eol.length;
		start = pos;
	}
	lines.push({ content: source.slice(start), eol: "", start });
	return lines;
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

function stripQuoteDepth(line: string, depth: number): string {
	let result = line;
	for (let i = 0; i < depth; i++) {
		const next = stripOneQuote(result);
		if (next === result) break;
		result = next;
	}
	return result;
}

function lineAtOffset(lines: readonly SourceLine[], offset: number, from: number): number {
	let line = from;
	while (line + 1 < lines.length && lines[line + 1].start <= offset) line++;
	return line;
}

/**
 * Collect CommonMark fenced-code spans once. Lezer owns fence recognition, so
 * callout-looking text inside CodeText is opaque instead of becoming a false
 * nested callout. Nodes and source lines are both ordered, keeping mapping
 * O(lines + syntax nodes) rather than doing a line search per fence.
 */
function fencedRanges(md: string, lines: readonly SourceLine[]): FenceRange[] {
	const ranges: FenceRange[] = [];
	const cursor = markdownParser.parse(md).cursor();
	let line = 0;
	do {
		if (cursor.name !== "FencedCode") continue;
		const startLine = lineAtOffset(lines, cursor.from, line);
		const lastOffset = Math.max(cursor.from, cursor.to - 1);
		const lastLine = lineAtOffset(lines, lastOffset, startLine);
		line = lastLine;

		const depth = quoteDepth(lines[startLine]?.content ?? "");
		const opener = stripQuoteDepth(lines[startLine]?.content ?? "", depth).trimStart();
		const match = opener.match(/^(`{3,}|~{3,})(.*)$/);
		if (!match) continue;
		const mark = match[1];
		ranges.push({
			startLine,
			endLine: lastLine + 1,
			depth,
			fenceChar: mark[0] as "`" | "~",
			fenceLength: mark.length,
			info: match[2].trim(),
			closed: cursor.node.getChildren("CodeMark").length >= 2,
		});
	} while (cursor.next());
	return ranges;
}

/**
 * Discover nested callouts and code fences from one source projection.
 * Complexity is O(bytes + Markdown syntax nodes), with O(section count)
 * retained space. Rendered DOM is never consulted.
 */
export function findNestedSections(md: string): NestedSections {
	const lines = sourceLines(md);
	const fences = fencedRanges(md, lines);
	const callouts: NestedCallout[] = [];
	const active: number[] = [];
	let fenceIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		while (fenceIndex < fences.length && fences[fenceIndex].endLine <= i) fenceIndex++;
		const fence = fences[fenceIndex];
		const inFence = Boolean(fence && fence.startLine <= i && i < fence.endLine);
		// A fence body is literal. Use the opener's structural depth throughout
		// so quote-looking code cannot open/close projected callout ranges.
		const depth = inFence ? fence.depth : quoteDepth(lines[i].content);
		const header = !inFence && depth >= 2 && afterQuotes(lines[i].content).startsWith("[!");

		while (active.length) {
			const top = callouts[active[active.length - 1]];
			if (depth > top.depth || (depth === top.depth && !header)) break;
			top.endLine = i;
			active.pop();
		}
		if (!header) continue;
		callouts.push({ startLine: i, endLine: lines.length, depth });
		active.push(callouts.length - 1);
	}

	return {
		callouts,
		codeBlocks: fences.filter((fence) => fence.depth > 0),
	};
}

/** Every nested callout header (depth >= 2) in document order. */
export function findNestedCallouts(md: string): NestedCallout[] {
	return findNestedSections(md).callouts;
}

/** Every fenced code block inside at least one quote level, in source order. */
export function findNestedCodeBlocks(md: string): NestedCodeBlock[] {
	return findNestedSections(md).codeBlocks;
}

function checkedRemovedDepth(section: NestedSourceSection, retainedDepth: number): number {
	if (!Number.isInteger(retainedDepth) || retainedDepth < 0 || retainedDepth > section.depth) {
		throw new RangeError("retained quote depth must be an integer within the section depth");
	}
	return section.depth - retainedDepth;
}

function checkLineRange(lines: readonly SourceLine[], section: NestedSourceSection): void {
	if (
		!Number.isInteger(section.startLine) ||
		!Number.isInteger(section.endLine) ||
		section.startLine < 0 ||
		section.endLine < section.startLine ||
		section.endLine > lines.length
	) {
		throw new RangeError("nested section line range is outside the source");
	}
}

function materializeRemovingDepth(md: string, section: NestedSourceSection, removeDepth: number): string {
	const lines = sourceLines(md);
	checkLineRange(lines, section);
	const selected = lines.slice(section.startLine, section.endLine);
	return selected
		.map(
			(line, index) =>
				`${stripQuoteDepth(line.content, removeDepth)}${index + 1 < selected.length ? line.eol : ""}`,
		)
		.join("");
}

/**
 * Lift a quoted source span out of its parent quote levels without reparsing
 * or normalizing its internal bytes. `retainedDepth=0` materializes literal
 * code; `retainedDepth=1` materializes a nested callout as a top-level callout.
 */
export function materializeQuotedSection(md: string, section: NestedSourceSection, retainedDepth = 0): string {
	return materializeRemovingDepth(md, section, checkedRemovedDepth(section, retainedDepth));
}

/** Add exactly `depth` canonical quote levels while preserving the text's EOLs. */
export function requoteAtDepth(text: string, depth: number): string {
	if (!Number.isInteger(depth) || depth < 0) throw new RangeError("quote depth must be a non-negative integer");
	if (depth === 0) return text;
	const prefix = "> ".repeat(depth);
	const blankPrefix = prefix.trimEnd();
	return sourceLines(text)
		.map((line) => `${line.content.length ? `${prefix}${line.content}` : blankPrefix}${line.eol}`)
		.join("");
}

function endsWithEol(text: string): boolean {
	return text.endsWith("\n") || text.endsWith("\r");
}

/**
 * Replace a quoted source span with a materialized edit, restoring exactly
 * the removed quote depth. The source's boundary EOL survives replacements;
 * `null` removes the span without leaving an extra blank line.
 */
export function spliceQuotedSection(
	md: string,
	section: NestedSourceSection,
	replacement: string | null,
	retainedDepth = 0,
): string {
	const removeDepth = checkedRemovedDepth(section, retainedDepth);
	const lines = sourceLines(md);
	checkLineRange(lines, section);
	const start = lines[section.startLine]?.start ?? md.length;
	const end = lines[section.endLine]?.start ?? md.length;
	let insert = replacement === null ? "" : requoteAtDepth(replacement, removeDepth);
	const boundaryEol = section.endLine > section.startLine ? (lines[section.endLine - 1]?.eol ?? "") : "";
	if (insert && boundaryEol && !endsWithEol(insert)) insert += boundaryEol;
	return `${md.slice(0, start)}${insert}${md.slice(end)}`;
}

/** Re-add one quote level to every line (empty lines become `>`). */
export function requoteOnce(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.length ? `> ${line}` : ">"))
		.join("\n");
}

/** Materialize one level, preserving the existing nested-callout API. */
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
