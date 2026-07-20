import { newId, setBlockAttr } from "../wasm/bridge";

export interface CreateBlockSourceOptions {
	/** Optional user-authored display name. Blank/whitespace-only means omitted. */
	name?: string;
	/** Exact Markdown/Mica body. A final newline is added only when required. */
	body: string;
}

/**
 * Construct one complete, immediately addressable Mica source block for
 * templates and commands. The core header writer remains the sole serializer
 * for optional attributes, while the outer fence grows above body backticks.
 */
export function createBlockSource(options: CreateBlockSourceOptions): string {
	if (!options || typeof options !== "object" || typeof options.body !== "string") {
		throw new Error("Mica: createBlockSource requires a string body");
	}
	if (options.name !== undefined && typeof options.name !== "string") {
		throw new Error("Mica: createBlockSource name must be a string when provided");
	}

	let longestRun = 0;
	for (const match of options.body.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
	const fence = "`".repeat(Math.max(3, longestRun + 1));
	const id = newId();
	const separator = options.body && !options.body.endsWith("\n") ? "\n" : "";
	let source = `${fence}mica id=${id}\n${options.body}${separator}${fence}\n`;

	const name = options.name;
	if (name === undefined || !name.trim()) return source;
	const named = setBlockAttr(source, id, "name", name);
	if (named === null) {
		throw new Error(
			"Mica: block names cannot contain double quotes, backticks, line breaks, or control characters; choose a different name",
		);
	}
	source = named;
	return source;
}
