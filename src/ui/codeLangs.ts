import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { c, cpp, csharp, java, kotlin, scala } from "@codemirror/legacy-modes/mode/clike";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { go } from "@codemirror/legacy-modes/mode/go";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { properties } from "@codemirror/legacy-modes/mode/properties";

/**
 * Fenced-code languages the embedded editors highlight. Curated instead of
 * @codemirror/language-data: the four Lezer grammars ride the bundle already
 * (lang-markdown pulls html/css/js), and everything else uses legacy STREAM
 * parsers — a few KB each instead of tens. Names/aliases follow the common
 * fence infostrings (the toolbar's language picker draws from the same set).
 */
function stream(name: string, alias: string[], parser: StreamParser<unknown>): LanguageDescription {
	return LanguageDescription.of({
		name,
		alias,
		load: async () => new LanguageSupport(StreamLanguage.define(parser)),
	});
}

const DESCRIPTIONS: LanguageDescription[] = [
	LanguageDescription.of({
		name: "javascript",
		alias: ["js", "jsx", "mjs", "cjs"],
		load: async () => javascript({ jsx: true }),
	}),
	LanguageDescription.of({
		name: "typescript",
		alias: ["ts", "tsx"],
		load: async () => javascript({ jsx: true, typescript: true }),
	}),
	LanguageDescription.of({ name: "json", alias: ["jsonc"], load: async () => json() }),
	LanguageDescription.of({ name: "html", alias: ["htm", "vue", "svelte"], load: async () => html() }),
	LanguageDescription.of({ name: "css", alias: ["scss", "less"], load: async () => css() }),
	LanguageDescription.of({
		name: "markdown",
		alias: ["md"],
		load: async () => markdown({ base: markdownLanguage }),
	}),
	stream("python", ["py"], python),
	stream("rust", ["rs"], rust),
	stream("shell", ["bash", "sh", "zsh", "console", "shellsession"], shell),
	stream("sql", ["mysql", "postgres", "postgresql", "sqlite"], standardSQL),
	stream("yaml", ["yml"], yaml),
	stream("c", ["h"], c),
	stream("cpp", ["c++", "hpp", "cc"], cpp),
	stream("csharp", ["cs", "c#"], csharp),
	stream("java", [], java),
	stream("kotlin", ["kt"], kotlin),
	stream("scala", [], scala),
	stream("go", ["golang"], go),
	stream("diff", ["patch"], diff),
	stream("toml", [], toml),
	stream("lua", [], lua),
	stream("ruby", ["rb"], ruby),
	stream("swift", [], swift),
	stream("xml", ["svg", "xsl", "plist"], xml),
	stream("powershell", ["ps1"], powerShell),
	stream("dockerfile", ["docker"], dockerFile),
	stream("ini", ["properties", "conf"], properties),
];

/** Resolve a fence infostring to a highlightable language (or null). */
export function resolveCodeLanguage(info: string): LanguageDescription | null {
	return LanguageDescription.matchLanguageName(DESCRIPTIONS, info, true);
}
