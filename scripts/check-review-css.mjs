import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Focused source tripwires, not a replacement for the directory's CSS scanner.
const files = ["styles.css"];
const rules = [
	[/!\s*important\b/gi, "Use owned selectors or CSS variables instead of priority overrides."],
	[/:has\s*\(/gi, "Use explicit owned state classes instead of :has()."],
	[
		/\btext-decoration-(?:line|style)\s*:/gi,
		"Use a compatible visible marker instead of the reviewed decoration longhands.",
	],
];

let failures = 0;
for (const file of files) {
	const path = new URL(`../${file}`, import.meta.url);
	const source = await readFile(path, "utf8");
	// Preserve offsets and newlines while ignoring comments and quoted values.
	const css = source.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, (token) =>
		token.replace(/[^\r\n]/g, " "),
	);
	for (const [pattern, message] of rules) {
		for (const match of css.matchAll(pattern)) {
			const line = source.slice(0, match.index).split("\n").length;
			console.error(`${fileURLToPath(path)}:${line}: ${message}`);
			failures++;
		}
	}
}
if (failures) process.exitCode = 1;
else console.log(`Review CSS tripwires passed (${files.length} source files).`);
