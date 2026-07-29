const HTML_TAGS = new Set([
	"a",
	"abbr",
	"address",
	"area",
	"article",
	"aside",
	"audio",
	"b",
	"base",
	"bdi",
	"bdo",
	"blockquote",
	"body",
	"br",
	"button",
	"canvas",
	"caption",
	"cite",
	"code",
	"col",
	"colgroup",
	"data",
	"datalist",
	"dd",
	"del",
	"details",
	"dfn",
	"dialog",
	"div",
	"dl",
	"dt",
	"em",
	"embed",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hgroup",
	"hr",
	"html",
	"i",
	"iframe",
	"img",
	"input",
	"ins",
	"kbd",
	"label",
	"legend",
	"li",
	"link",
	"main",
	"map",
	"mark",
	"menu",
	"meta",
	"meter",
	"nav",
	"noscript",
	"object",
	"ol",
	"optgroup",
	"option",
	"output",
	"p",
	"picture",
	"pre",
	"progress",
	"q",
	"rp",
	"rt",
	"ruby",
	"s",
	"samp",
	"script",
	"search",
	"section",
	"select",
	"slot",
	"small",
	"source",
	"span",
	"strong",
	"style",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"template",
	"textarea",
	"tfoot",
	"th",
	"thead",
	"time",
	"title",
	"tr",
	"track",
	"u",
	"ul",
	"var",
	"video",
	"wbr",
]);

/**
 * Preserve prompt-style placeholders such as `<condition>` in rendered
 * Markdown. CommonMark treats those as raw/custom HTML, which can make an
 * unclosed placeholder swallow subsequent text. Real HTML, autolinks,
 * comments, fenced code, and inline code retain their normal semantics.
 */
export function protectLiteralAnglePlaceholders(markdown: string): string {
	let fence: { marker: "`" | "~"; length: number; quoteDepth: number } | null = null;
	const output: string[] = [];
	let lineStart = 0;
	while (lineStart < markdown.length) {
		const newline = markdown.indexOf("\n", lineStart);
		const lineEnd = newline < 0 ? markdown.length : newline;
		const contentEnd = lineEnd > lineStart && markdown[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
		const line = markdown.slice(lineStart, contentEnd);

		let quote = blockquotePrefix(line, fence?.quoteDepth);
		if (fence && fence.quoteDepth > 0 && quote.depth < fence.quoteDepth) {
			fence = null;
			quote = blockquotePrefix(line);
		}
		const content = line.slice(quote.end);
		const fenceRun = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
		if (fenceRun) {
			const marker = fenceRun[1][0] as "`" | "~";
			if (!fence) fence = { marker, length: fenceRun[1].length, quoteDepth: quote.depth };
			else if (marker === fence.marker && fenceRun[1].length >= fence.length && /^\s*$/.test(fenceRun[2]))
				fence = null;
			output.push(line);
		} else if (fence || /^(?: {4}|\t)/.test(content)) {
			output.push(line);
		} else {
			output.push(protectOutsideInlineCode(line));
		}
		if (newline >= 0) output.push(markdown.slice(contentEnd, newline + 1));
		lineStart = newline < 0 ? markdown.length : newline + 1;
	}
	return output.join("");
}

function blockquotePrefix(line: string, maximumDepth = Number.POSITIVE_INFINITY): { depth: number; end: number } {
	let depth = 0;
	let end = 0;
	while (depth < maximumDepth) {
		const before = end;
		let spaces = 0;
		while (spaces < 3 && line[end] === " ") {
			end++;
			spaces++;
		}
		if (line[end] !== ">") {
			end = before;
			break;
		}
		end++;
		if (line[end] === " " || line[end] === "\t") end++;
		depth++;
	}
	return { depth, end };
}

function protectOutsideInlineCode(line: string): string {
	let output = "";
	let plainStart = 0;
	let index = 0;
	while (index < line.length) {
		if (line[index] !== "`") {
			index++;
			continue;
		}
		let end = index + 1;
		while (line[end] === "`") end++;
		const delimiter = line.slice(index, end);
		const close = line.indexOf(delimiter, end);
		if (close < 0) {
			index = end;
			continue;
		}
		output += protectPlain(line.slice(plainStart, index));
		output += line.slice(index, close + delimiter.length);
		index = close + delimiter.length;
		plainStart = index;
	}
	return output + protectPlain(line.slice(plainStart));
}

function protectPlain(text: string): string {
	return text.replace(/<((?:\/)?)([A-Za-z][A-Za-z0-9]*)(\s*\/?)>/g, (whole, slash, name, tail) => {
		if (HTML_TAGS.has(String(name).toLowerCase())) return whole;
		return `&lt;${slash}${name}${tail}&gt;`;
	});
}
