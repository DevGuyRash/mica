import type { MicaNode } from "../wasm/bridge";

export interface CopyOptions {
	includeMicaSyntax: boolean;
	includeOuterContainer: boolean;
	includeLineNumbers?: boolean;
	lineNumberScope?: "content" | "output";
}

/** The settings subset that controls every Mica clipboard projection. Keeping
 * this structural avoids coupling the pure serializer to the full plugin
 * settings object while giving every copy surface one canonical adapter. */
export interface CopyPreferences {
	copyIncludeMicaSyntax: boolean;
	copyIncludeOuterContainer: boolean;
	copyIncludeLineNumbers: boolean;
	copyLineNumberScope: "content" | "output";
}

export type CopyTarget = { nodes: readonly MicaNode[] } | { text: string };

export const DEFAULT_COPY_OPTIONS: Readonly<CopyOptions> = {
	includeMicaSyntax: false,
	includeOuterContainer: false,
	includeLineNumbers: false,
	lineNumberScope: "content",
};

/** Read preferences at activation time so open widgets and docks always honor
 * an on-the-fly settings change without being rebuilt. */
export function copyOptionsFromSettings(settings: CopyPreferences): CopyOptions {
	return {
		includeMicaSyntax: settings.copyIncludeMicaSyntax,
		includeOuterContainer: settings.copyIncludeOuterContainer,
		includeLineNumbers: settings.copyIncludeLineNumbers,
		lineNumberScope: settings.copyLineNumberScope,
	};
}

export function clipboardText(target: CopyTarget, options: CopyOptions): string {
	return "nodes" in target ? copyNodes(target.nodes, options) : copyText(target.text, options);
}

interface ProjectionSegment {
	text: string;
	content: boolean;
}

/** Build clipboard text for structural selections without normalizing authored
 * bytes. Every pass is O(input + output), and line origin stays explicit. */
export function copyNodes(nodes: readonly MicaNode[], options: CopyOptions): string {
	let segments = options.includeMicaSyntax ? structuralSegments(nodes) : flattenedSegments(nodes);
	if (options.includeLineNumbers && (options.lineNumberScope ?? "content") === "content") {
		segments = numberSegments(segments, false);
	}
	if (options.includeOuterContainer) segments = wrapSegments(segments);
	if (options.includeLineNumbers && options.lineNumberScope === "output") {
		segments = numberSegments(segments, true);
	}
	return segments.map((segment) => segment.text).join("");
}

/** Build clipboard text for an already-leaf selection such as prose or a callout. */
export function copyText(text: string, options: CopyOptions): string {
	let segments: ProjectionSegment[] = [{ text, content: true }];
	if (options.includeLineNumbers && (options.lineNumberScope ?? "content") === "content") {
		segments = numberSegments(segments, false);
	}
	if (options.includeOuterContainer) segments = wrapSegments(segments);
	if (options.includeLineNumbers && options.lineNumberScope === "output") {
		segments = numberSegments(segments, true);
	}
	return segments.map((segment) => segment.text).join("");
}

function structuralSegments(nodes: readonly MicaNode[]): ProjectionSegment[] {
	const segments: ProjectionSegment[] = [];
	collectStructural(nodes, segments);
	return segments;
}

function collectStructural(nodes: readonly MicaNode[], segments: ProjectionSegment[]): void {
	for (const node of nodes) {
		if (node.kind === "leaf") {
			segments.push({ text: node.text, content: true });
			continue;
		}
		segments.push({ text: node.open_line, content: false });
		collectStructural(node.children, segments);
		segments.push({ text: node.close_line, content: false });
	}
}

function flattenedSegments(nodes: readonly MicaNode[]): ProjectionSegment[] {
	const fragments: string[] = [];
	collectFlattenedLeaves(nodes, fragments);
	if (fragments.length === 0) return [{ text: "", content: true }];
	const eol = detectFragmentsEol(fragments);
	const parts = [fragments[0]];
	for (const fragment of fragments.slice(1)) {
		const previous = parts[parts.length - 1];
		parts.push(endsWithEol(previous) || startsWithEol(fragment) ? "" : eol + eol, fragment);
	}
	return [{ text: parts.join(""), content: true }];
}

function collectFlattenedLeaves(nodes: readonly MicaNode[], fragments: string[]): void {
	for (const node of nodes) {
		if (node.kind === "container") {
			collectFlattenedLeaves(node.children, fragments);
			continue;
		}
		if (node.text) fragments.push(node.text);
	}
}

function wrapSegments(segments: readonly ProjectionSegment[]): ProjectionSegment[] {
	let longestRun = 0;
	let run = 0;
	let length = 0;
	for (const segment of segments) {
		length += segment.text.length;
		for (const char of segment.text) {
			if (char === "`") {
				run++;
				longestRun = Math.max(longestRun, run);
			} else {
				run = 0;
			}
		}
	}
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	const eol = detectSegmentsEol(segments);
	const separator = length > 0 && !segmentsEndWithEol(segments) ? eol : "";
	return [
		{ text: `${fence}mica${eol}`, content: false },
		...segments,
		...(separator ? [{ text: separator, content: false }] : []),
		{ text: fence, content: false },
	];
}

function numberSegments(segments: readonly ProjectionSegment[], all: boolean): ProjectionSegment[] {
	const lines = linesWithOrigin(segments);
	const count = lines.reduce((total, line) => total + (all || line.content ? 1 : 0), 0);
	if (!count) return [...segments];
	const width = String(count).length;
	let number = 0;
	return lines.map((line) => {
		if (!all && !line.content) return { text: line.text, content: line.content };
		number++;
		return { text: `${String(number).padStart(width)} │ ${line.text}`, content: line.content };
	});
}

function linesWithOrigin(segments: readonly ProjectionSegment[]): ProjectionSegment[] {
	const lines: ProjectionSegment[] = [];
	let current = "";
	let content = false;
	for (const segment of segments) {
		for (const line of physicalLines(segment.text)) {
			current += line.text;
			content ||= segment.content;
			if (line.hasEol) {
				lines.push({ text: current, content });
				current = "";
				content = false;
			}
		}
	}
	if (current) lines.push({ text: current, content });
	return lines;
}

function physicalLines(text: string): { text: string; hasEol: boolean }[] {
	const lines: { text: string; hasEol: boolean }[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "\n" && text[i] !== "\r") continue;
		const end = text[i] === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
		lines.push({ text: text.slice(start, end), hasEol: true });
		start = end;
		if (end === i + 2) i++;
	}
	if (start < text.length) lines.push({ text: text.slice(start), hasEol: false });
	return lines;
}

function detectFragmentsEol(fragments: readonly string[]): "\n" | "\r\n" | "\r" {
	return detectTextPartsEol(fragments);
}

function detectSegmentsEol(segments: readonly ProjectionSegment[]): "\n" | "\r\n" | "\r" {
	return detectTextPartsEol(segments);
}

/** Find the first physical EOL across adjacent parts, including a CR/LF pair
 * split at a structural segment boundary, without joining the full payload. */
function detectTextPartsEol(parts: readonly (string | ProjectionSegment)[]): "\n" | "\r\n" | "\r" {
	let trailingCr = false;
	for (const part of parts) {
		const text = typeof part === "string" ? part : part.text;
		if (trailingCr) {
			if (!text) continue;
			return text.startsWith("\n") ? "\r\n" : "\r";
		}
		const match = /\r\n|\r|\n/.exec(text);
		if (!match) continue;
		if (match[0] === "\r" && match.index === text.length - 1) {
			trailingCr = true;
			continue;
		}
		return match[0] as "\n" | "\r\n" | "\r";
	}
	return trailingCr ? "\r" : "\n";
}

function segmentsEndWithEol(segments: readonly ProjectionSegment[]): boolean {
	for (let index = segments.length - 1; index >= 0; index--) {
		if (segments[index].text) return endsWithEol(segments[index].text);
	}
	return false;
}

const endsWithEol = (text: string): boolean => text.endsWith("\n") || text.endsWith("\r");
const startsWithEol = (text: string): boolean => text.startsWith("\n") || text.startsWith("\r");
