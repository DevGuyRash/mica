import type { App } from "obsidian";

/** One insertable callout type: id (what goes in `[!id]`), icon, and colors. */
export interface CalloutType {
	id: string;
	/** Lucide icon name (matches Obsidian's own callout icons). */
	icon: string;
	/** Aliases that render identically (shown as hints, not separate entries). */
	aliases: string[];
	/** Where the type came from: Obsidian built-in or the Admonition plugin. */
	source: "obsidian" | "admonition";
	/** CSS color for the swatch (Obsidian's --callout-* palette). */
	color: string;
}

/** Obsidian's built-in callout types, their icons, and aliases (help.obsidian.md/callouts). */
const BUILTIN: CalloutType[] = [
	{ id: "note", icon: "pencil", aliases: [], source: "obsidian", color: "var(--color-blue)" },
	{ id: "abstract", icon: "clipboard-list", aliases: ["summary", "tldr"], source: "obsidian", color: "var(--color-cyan)" },
	{ id: "info", icon: "info", aliases: [], source: "obsidian", color: "var(--color-blue)" },
	{ id: "todo", icon: "circle-check", aliases: [], source: "obsidian", color: "var(--color-blue)" },
	{ id: "tip", icon: "flame", aliases: ["hint", "important"], source: "obsidian", color: "var(--color-cyan)" },
	{ id: "success", icon: "check", aliases: ["check", "done"], source: "obsidian", color: "var(--color-green)" },
	{ id: "question", icon: "circle-help", aliases: ["help", "faq"], source: "obsidian", color: "var(--color-orange)" },
	{ id: "warning", icon: "triangle-alert", aliases: ["caution", "attention"], source: "obsidian", color: "var(--color-orange)" },
	{ id: "failure", icon: "x", aliases: ["fail", "missing"], source: "obsidian", color: "var(--color-red)" },
	{ id: "danger", icon: "zap", aliases: ["error"], source: "obsidian", color: "var(--color-red)" },
	{ id: "bug", icon: "bug", aliases: [], source: "obsidian", color: "var(--color-red)" },
	{ id: "example", icon: "list", aliases: [], source: "obsidian", color: "var(--color-purple)" },
	{ id: "quote", icon: "quote", aliases: ["cite"], source: "obsidian", color: "var(--color-base-70, var(--text-muted))" },
];

interface AdmonitionDef {
	icon?: { type?: string; name?: string };
	color?: string;
}

/**
 * The full callout catalog: Obsidian's built-ins plus any custom types the
 * Admonition plugin defines in this vault (read live from its settings, so a
 * type added there shows up in Mica's picker immediately).
 */
export function calloutCatalog(app: App): CalloutType[] {
	const out = [...BUILTIN];
	const seen = new Set(out.flatMap((t) => [t.id, ...t.aliases]));
	try {
		// Peek at Admonition's saved settings; absent or malformed = built-ins only.
		const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
		const adm = plugins?.["obsidian-admonition"] as { data?: { userAdmonitions?: Record<string, AdmonitionDef> } };
		const custom = adm?.data?.userAdmonitions ?? {};
		for (const [id, def] of Object.entries(custom)) {
			if (seen.has(id)) continue;
			seen.add(id);
			const rgb = typeof def.color === "string" && /^[\d, ]+$/.test(def.color) ? `rgb(${def.color})` : "var(--text-accent)";
			out.push({
				id,
				icon: def.icon?.name ?? "shield",
				aliases: [],
				source: "admonition",
				color: rgb,
			});
		}
	} catch {
		// Catalog is a convenience — never let a plugin's data shape break the picker.
	}
	return out;
}

/** Fold behavior for an inserted callout: static, fold-open (+), fold-closed (-). */
export type CalloutFold = "" | "+" | "-";
