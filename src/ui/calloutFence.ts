/** Fold marker carried by an Obsidian callout header. */
export type CalloutFold = "" | "+" | "-";

/** Source-exact projection of one complete callout section. */
export interface ParsedCallout {
	/** Exact input, retained so an untouched build is byte-for-byte identical. */
	original: string;
	/** Whitespace-only bytes before the callout header. */
	prefix: string;
	/** Zero to three spaces before the header's blockquote marker. */
	indent: string;
	/** Exact spaces/tabs between `>` and `[!type]`. */
	markerGap: string;
	type: string;
	fold: CalloutFold;
	/** Trimmed title exposed to the structured editor. */
	title: string;
	/** Exact bytes after the fold marker and before the header line ending. */
	titleRaw: string;
	headerEol: "" | "\n" | "\r\n";
	/** Body with one quote level removed and its final line ending excluded. */
	body: string;
	/** Final line ending of the last quoted body line, when present. */
	bodyEndEol: "" | "\n" | "\r\n";
	/** Dequoted body including its original final line ending. */
	bodySource: string;
	/** Exact quoted body bytes; reused when only header fields change. */
	quotedBodyRaw: string;
	/** Whitespace-only bytes following the quoted run. */
	suffix: string;
}

export interface CalloutChanges {
	type?: string;
	fold?: CalloutFold;
	title?: string;
	body?: string;
}

interface SourceLine {
	start: number;
	end: number;
	contentEnd: number;
	eol: "" | "\n" | "\r\n";
}

const HEADER_RE = /^([ ]{0,3})>([\t ]*)\[!([A-Za-z0-9-]+)\]([+-]?)(.*)$/u;
const QUOTE_RE = /^([ ]{0,3})>([\t ]?)(.*)$/u;

/** Parse a region containing exactly one callout plus boundary whitespace. */
export function parseCallout(source: string): ParsedCallout | null {
	const lines = sourceLines(source);
	const headerIndex = lines.findIndex((line) => lineText(source, line).trim().length > 0);
	if (headerIndex < 0) return null;
	const headerLine = lines[headerIndex];
	const header = lineText(source, headerLine).match(HEADER_RE);
	if (!header) return null;

	const bodyLines: Array<{ line: SourceLine; content: string }> = [];
	let nextIndex = headerIndex + 1;
	for (; nextIndex < lines.length; nextIndex++) {
		const line = lines[nextIndex];
		const quote = lineText(source, line).match(QUOTE_RE);
		if (!quote) break;
		bodyLines.push({ line, content: quote[3] });
	}

	const prefix = source.slice(0, headerLine.start);
	const suffixStart = bodyLines.at(-1)?.line.end ?? headerLine.end;
	const suffix = source.slice(suffixStart);
	if (prefix.trim().length > 0 || suffix.trim().length > 0) return null;

	let bodySource = "";
	for (const bodyLine of bodyLines) bodySource += bodyLine.content + bodyLine.line.eol;
	const bodyEndEol = bodyLines.at(-1)?.line.eol ?? "";
	const body = bodyEndEol ? bodySource.slice(0, -bodyEndEol.length) : bodySource;

	return {
		original: source,
		prefix,
		indent: header[1],
		markerGap: header[2],
		type: header[3],
		fold: header[4] as CalloutFold,
		title: header[5].trim(),
		titleRaw: header[5],
		headerEol: headerLine.eol,
		body,
		bodyEndEol,
		bodySource,
		quotedBodyRaw: source.slice(headerLine.end, suffixStart),
		suffix,
	};
}

/**
 * Rebuild a parsed callout after optional structured edits. Unchanged source
 * is returned verbatim; changed bodies retain the source indentation/EOL and
 * receive exactly one quote level.
 */
export function buildCallout(parsed: ParsedCallout, changes: CalloutChanges = {}): string {
	const type = changes.type ?? parsed.type;
	const fold = changes.fold ?? parsed.fold;
	const title = changes.title ?? parsed.title;
	const body = changes.body ?? parsed.body;
	if (type === parsed.type && fold === parsed.fold && title === parsed.title && body === parsed.body) {
		return parsed.original;
	}
	if (!/^[A-Za-z0-9-]+$/u.test(type)) throw new RangeError("invalid callout type");
	if (fold !== "" && fold !== "+" && fold !== "-") throw new RangeError("invalid callout fold marker");
	if (/[\r\n]/u.test(title)) throw new RangeError("invalid callout title");

	const bodyChanged = body !== parsed.body;
	const fallbackEol = firstEol(body) ?? firstEol(parsed.original) ?? "\n";
	const headerEol = body && !parsed.headerEol ? fallbackEol : parsed.headerEol;
	const titleRaw = title === parsed.title ? parsed.titleRaw : title ? ` ${title}` : "";
	const quotedBody = bodyChanged
		? quoteBody(body, parsed.indent, parsed.bodyEndEol || headerEol || fallbackEol)
		: parsed.quotedBodyRaw;

	return (
		parsed.prefix +
		parsed.indent +
		">" +
		parsed.markerGap +
		`[!${type}]${fold}${titleRaw}` +
		headerEol +
		quotedBody +
		parsed.suffix
	);
}

function quoteBody(body: string, indent: string, finalEol: "" | "\n" | "\r\n"): string {
	if (!body) return "";
	const lines = sourceLines(body);
	// A trailing EOL represents a final blank body line in the editor, matching
	// the previous split/join builder's behavior.
	if (body.endsWith("\n")) {
		lines.push({ start: body.length, end: body.length, contentEnd: body.length, eol: "" });
	}
	let quoted = "";
	for (const line of lines) {
		const content = lineText(body, line);
		quoted += `${indent}>${content ? ` ${content}` : ""}${line.eol}`;
	}
	if (!lines.at(-1)?.eol) quoted += finalEol;
	return quoted;
}

function firstEol(source: string): "\n" | "\r\n" | null {
	const newline = source.indexOf("\n");
	if (newline < 0) return null;
	return newline > 0 && source[newline - 1] === "\r" ? "\r\n" : "\n";
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
