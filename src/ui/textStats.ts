export interface TextStats {
	words: number;
	characters: number;
	lines: number;
	sourceUnits: number;
	utf8Bytes: number;
	rawLines: number;
	lineEndings: number;
}

export type VisibleTextStats = Pick<TextStats, "words" | "characters" | "lines">;
export type SourceTextDetails = Pick<TextStats, "sourceUnits" | "utf8Bytes" | "rawLines" | "lineEndings">;

type Segment = { segment: string; isWordLike?: boolean };
type Segmenter = { segment(input: string): Iterable<Segment> };
type SegmenterCtor = new (locales?: string | string[], options?: { granularity: "grapheme" | "word" }) => Segmenter;

const segmenterCtor = (Intl as typeof Intl & { Segmenter?: SegmenterCtor }).Segmenter;
const graphemes = segmenterCtor ? new segmenterCtor(undefined, { granularity: "grapheme" }) : null;
const words = segmenterCtor ? new segmenterCtor(undefined, { granularity: "word" }) : null;
const encoder = new TextEncoder();

/** O(text) statistics. Visible counts model what a person edits; source counts
 * preserve the exact UTF-16/EOL view for diagnostics. */
export function textStats(text: string): TextStats {
	return { ...visibleTextStats(text), ...sourceTextDetails(text) };
}

/** Counts used in the always-visible footer. This deliberately avoids the
 * UTF-8 allocation and source-detail work reserved for the details popover. */
export function visibleTextStats(text: string): VisibleTextStats {
	const lineEndings = countLineEndings(text);
	return {
		words: countWords(text),
		characters: countVisibleGraphemes(text),
		lines: visibleLines(text, lineEndings),
	};
}

/** Exact source metrics are computed lazily when the user asks for them. */
export function sourceTextDetails(text: string): SourceTextDetails {
	const lineEndings = countLineEndings(text);
	return {
		sourceUnits: text.length,
		utf8Bytes: encoder.encode(text).byteLength,
		rawLines: text.length ? lineEndings + 1 : 0,
		lineEndings,
	};
}

function countWords(text: string): number {
	if (words) {
		let count = 0;
		for (const part of words.segment(text)) if (part.isWordLike) count++;
		return count;
	}
	let count = 0;
	const fallback = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;
	while (fallback.exec(text)) count++;
	return count;
}

function countVisibleGraphemes(text: string): number {
	if (!text) return 0;
	if (graphemes) {
		let count = 0;
		for (const part of graphemes.segment(text)) {
			let lineEnding = true;
			for (let i = 0; i < part.segment.length; i++) {
				const code = part.segment.charCodeAt(i);
				if (code !== 10 && code !== 13) {
					lineEnding = false;
					break;
				}
			}
			if (!lineEnding) count++;
		}
		return count;
	}
	let count = 0;
	for (const point of text) if (point !== "\r" && point !== "\n") count++;
	return count;
}

function countLineEndings(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") count++;
		else if (text[i] === "\r") {
			count++;
			if (text[i + 1] === "\n") i++;
		}
	}
	return count;
}

function visibleLines(text: string, lineEndings: number): number {
	if (!text) return 0;
	const endsWithEol = text.endsWith("\n") || text.endsWith("\r");
	return Math.max(0, lineEndings + (endsWithEol ? 0 : 1));
}
