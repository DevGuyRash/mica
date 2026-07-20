import type { MicaNode } from "../wasm/bridge";

export interface CopyOptions {
	includeMicaSyntax: boolean;
	includeOuterContainer: boolean;
}

/** Build clipboard text for structural selections without normalizing authored bytes. */
export function copyNodes(nodes: readonly MicaNode[], options: CopyOptions): string {
	const text = options.includeMicaSyntax ? serializeNodes(nodes) : flattenNodes(nodes);
	return maybeWrap(text, options.includeOuterContainer);
}

/** Build clipboard text for an already-leaf selection such as prose or a callout. */
export function copyText(text: string, options: CopyOptions): string {
	return maybeWrap(stripBoundaryBlankLines(text), options.includeOuterContainer);
}

function serializeNodes(nodes: readonly MicaNode[]): string {
	const parts: string[] = [];
	collectExact(nodes, parts);
	return parts.join("");
}

function collectExact(nodes: readonly MicaNode[], parts: string[]): void {
	for (const node of nodes) {
		if (node.kind === "leaf") {
			parts.push(node.text);
			continue;
		}
		parts.push(node.open_line);
		collectExact(node.children, parts);
		parts.push(node.close_line);
	}
}

function flattenNodes(nodes: readonly MicaNode[]): string {
	const fragments: string[] = [];
	collectFlattenedLeaves(nodes, fragments);
	if (fragments.length === 0) return "";
	const eol = fragments.map((fragment) => fragment.match(/\r\n|\r|\n/)?.[0]).find(Boolean) ?? "\n";
	const parts = [fragments[0]];
	for (const fragment of fragments.slice(1)) {
		parts.push(endsWithEol(parts[parts.length - 1]) ? eol : eol + eol, fragment);
	}
	return parts.join("");
}

function collectFlattenedLeaves(nodes: readonly MicaNode[], fragments: string[]): void {
	for (const node of nodes) {
		if (node.kind === "container") {
			collectFlattenedLeaves(node.children, fragments);
			continue;
		}
		const text = stripBoundaryBlankLines(node.text);
		if (text) fragments.push(text);
	}
}

function stripBoundaryBlankLines(text: string): string {
	if (!text || !text.trim()) return "";
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "\n" && text[i] !== "\r") continue;
		const end = text[i] === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
		lines.push(text.slice(start, end));
		start = end;
		if (end === i + 2) i++;
	}
	if (start < text.length) lines.push(text.slice(start));
	const blank = (line: string): boolean => line.replace(/(?:\r\n|\r|\n)$/, "").trim().length === 0;
	let first = 0;
	let last = lines.length;
	while (first < last && blank(lines[first])) first++;
	while (last > first && blank(lines[last - 1])) last--;
	return lines.slice(first, last).join("");
}

const endsWithEol = (text: string): boolean => text.endsWith("\n") || text.endsWith("\r");

function maybeWrap(text: string, includeOuterContainer: boolean): string {
	if (!includeOuterContainer) return text;
	let longestRun = 0;
	let run = 0;
	for (const char of text) {
		if (char === "`") {
			run++;
			longestRun = Math.max(longestRun, run);
		} else {
			run = 0;
		}
	}
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
	return `${fence}mica\n${text}${separator}${fence}`;
}
