/** A Markdown fenced-code marker supported by CommonMark and Obsidian. */
export type FenceChar = "`" | "~";

/** Source-exact projection of one closed fenced-code section. */
export interface ParsedCodeFence {
	/** Exact input, retained so an untouched build is byte-for-byte identical. */
	original: string;
	/** Whitespace-only bytes before the opening fence line. */
	prefix: string;
	/** Whitespace-only bytes after the closing fence line. */
	suffix: string;
	/** Zero to three spaces before the opening marker. */
	indent: string;
	fenceChar: FenceChar;
	openLen: number;
	/** Exact bytes after the opening marker and before its line ending. */
	infoRaw: string;
	/** First non-whitespace info token, used for syntax-language lookup. */
	language: string;
	openEol: "\n" | "\r\n";
	/** Exact bytes between the opening and closing fence lines. */
	body: string;
	/** Zero to three spaces before the closing marker. */
	closeIndent: string;
	closeLen: number;
	/** Exact spaces/tabs after the closing marker. */
	closeTrailing: string;
	closeEol: "" | "\n" | "\r\n";
}

export interface CodeFenceChanges {
	infoRaw?: string;
	body?: string;
}

interface SourceLine {
	start: number;
	end: number;
	contentEnd: number;
	eol: "" | "\n" | "\r\n";
}

/**
 * Parse a region containing exactly one well-formed closed code fence plus
 * optional whitespace-only boundary bytes. Markdown inside remains opaque.
 */
export function parseCodeFence(source: string): ParsedCodeFence | null {
	const lines = sourceLines(source);
	const openIndex = lines.findIndex((line) => lineText(source, line).trim().length > 0);
	if (openIndex < 0) return null;
	const openLine = lines[openIndex];
	if (!openLine.eol) return null;
	const open = parseOpen(lineText(source, openLine));
	if (!open) return null;

	let closeIndex = -1;
	let close: ReturnType<typeof parseClose> = null;
	for (let index = openIndex + 1; index < lines.length; index++) {
		const candidate = parseClose(lineText(source, lines[index]), open.fenceChar, open.openLen);
		if (!candidate) continue;
		closeIndex = index;
		close = candidate;
		break;
	}
	if (closeIndex < 0 || !close) return null;

	const closeLine = lines[closeIndex];
	const prefix = source.slice(0, openLine.start);
	const suffix = source.slice(closeLine.end);
	if (prefix.trim().length > 0 || suffix.trim().length > 0) return null;

	return {
		original: source,
		prefix,
		suffix,
		indent: open.indent,
		fenceChar: open.fenceChar,
		openLen: open.openLen,
		infoRaw: open.infoRaw,
		language: firstToken(open.infoRaw),
		openEol: openLine.eol,
		body: source.slice(openLine.end, closeLine.start),
		closeIndent: close.indent,
		closeLen: close.closeLen,
		closeTrailing: close.trailing,
		closeEol: closeLine.eol,
	};
}

/** True when `source` is one closed fenced-code section. */
export function isCodeFence(source: string): boolean {
	return parseCodeFence(source) !== null;
}

/**
 * Rebuild a parsed fence after optional info/body edits. Untouched input is
 * returned verbatim; changed input grows same-character fences when necessary
 * and never shrinks either existing run.
 */
export function buildCodeFence(parsed: ParsedCodeFence, changes: CodeFenceChanges = {}): string {
	const infoRaw = changes.infoRaw ?? parsed.infoRaw;
	const body = changes.body ?? parsed.body;
	if (infoRaw === parsed.infoRaw && body === parsed.body) return parsed.original;
	validateInfo(infoRaw, parsed.fenceChar);

	const bodyRun = longestFenceRun(body, parsed.fenceChar);
	const openLen = Math.max(parsed.openLen, bodyRun + 1);
	const closeLen = Math.max(parsed.closeLen, openLen);
	const marker = parsed.fenceChar.repeat(openLen);
	const closeMarker = parsed.fenceChar.repeat(closeLen);
	const terminatedBody = body && !body.endsWith("\n") ? `${body}${parsed.openEol}` : body;

	return (
		parsed.prefix +
		parsed.indent +
		marker +
		infoRaw +
		parsed.openEol +
		terminatedBody +
		parsed.closeIndent +
		closeMarker +
		parsed.closeTrailing +
		parsed.closeEol +
		parsed.suffix
	);
}

function parseOpen(text: string): {
	indent: string;
	fenceChar: FenceChar;
	openLen: number;
	infoRaw: string;
} | null {
	const indentLength = leadingSpaces(text);
	if (indentLength > 3) return null;
	const indent = text.slice(0, indentLength);
	const rest = text.slice(indentLength);
	const first = rest[0];
	if (first !== "`" && first !== "~") return null;
	const fenceChar: FenceChar = first;
	const openLen = sameCharRun(rest, fenceChar);
	if (openLen < 3) return null;
	const infoRaw = rest.slice(openLen);
	if (fenceChar === "`" && infoRaw.includes("`")) return null;
	return { indent, fenceChar, openLen, infoRaw };
}

function parseClose(
	text: string,
	fenceChar: FenceChar,
	minimum: number,
): { indent: string; closeLen: number; trailing: string } | null {
	const indentLength = leadingSpaces(text);
	if (indentLength > 3) return null;
	const indent = text.slice(0, indentLength);
	const rest = text.slice(indentLength);
	const closeLen = sameCharRun(rest, fenceChar);
	if (closeLen < minimum) return null;
	const trailing = rest.slice(closeLen);
	return /^[\t ]*$/.test(trailing) ? { indent, closeLen, trailing } : null;
}

function sourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	while (start < source.length) {
		const newline = source.indexOf("\n", start);
		if (newline < 0) {
			lines.push({ start, end: source.length, contentEnd: source.length, eol: "" });
			break;
		}
		const crlf = newline > start && source[newline - 1] === "\r";
		lines.push({
			start,
			end: newline + 1,
			contentEnd: crlf ? newline - 1 : newline,
			eol: crlf ? "\r\n" : "\n",
		});
		start = newline + 1;
	}
	return lines;
}

function lineText(source: string, line: SourceLine): string {
	return source.slice(line.start, line.contentEnd);
}

function leadingSpaces(text: string): number {
	let length = 0;
	while (text[length] === " ") length++;
	return length;
}

function sameCharRun(text: string, char: FenceChar): number {
	let length = 0;
	while (text[length] === char) length++;
	return length;
}

function firstToken(infoRaw: string): string {
	return infoRaw.match(/\S+/u)?.[0] ?? "";
}

function validateInfo(infoRaw: string, fenceChar: FenceChar): void {
	if (/[\r\n]/.test(infoRaw) || (fenceChar === "`" && infoRaw.includes("`"))) {
		throw new RangeError("invalid fenced-code info string");
	}
}

/** Longest same-character fence run beginning at Markdown fence indentation. */
function longestFenceRun(body: string, fenceChar: FenceChar): number {
	let longest = 0;
	for (const line of sourceLines(body)) {
		const text = lineText(body, line);
		const indent = leadingSpaces(text);
		if (indent <= 3) longest = Math.max(longest, sameCharRun(text.slice(indent), fenceChar));
	}
	return longest;
}
