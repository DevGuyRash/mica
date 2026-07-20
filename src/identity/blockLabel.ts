const UNTITLED_BLOCK = "Untitled block";

/** Presentation context for one block whose persisted `name=` may be absent. */
export interface BlockNamePresentation {
	noteBasename: string;
	/** One-based position among unnamed blocks in document order. */
	unnamedOrdinal: number;
}

/** Return one display label without ever turning the inherited value into source. */
export function displayBlockName(
	explicitName: string | null | undefined,
	{ noteBasename, unnamedOrdinal }: BlockNamePresentation,
): string {
	const explicit = explicitName?.trim();
	if (explicit) return explicit;
	const inherited = noteBasename.trim() || UNTITLED_BLOCK;
	return unnamedOrdinal > 1 ? `${inherited} · ${unnamedOrdinal}` : inherited;
}

/** Derive a basename when the host cannot provide Obsidian's `TFile.basename`. */
export function noteBasenameFromPath(sourcePath: string): string {
	const leaf = sourcePath.replace(/\\/g, "/").split("/").pop() ?? "";
	return leaf.replace(/\.md$/i, "");
}

/** Compute each block's one-based position among unnamed blocks in one pass.
 * Explicitly named blocks receive zero because they never use the ordinal. */
export function unnamedBlockOrdinals(explicitNames: readonly (string | null | undefined)[]): number[] {
	let unnamed = 0;
	return explicitNames.map((name) => (name?.trim() ? 0 : ++unnamed));
}

/** Match the Rust fence-attribute writer's value restrictions. */
export function blockNameValidationError(value: string): string | null {
	if (value.includes('"')) return 'Block names cannot contain double quotation marks (").';
	if (value.includes("`")) return "Block names cannot contain backticks (`).";
	if (/\p{Cc}/u.test(value)) return "Block names cannot contain control characters or line breaks.";
	return null;
}
