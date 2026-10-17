import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["**/node_modules/**", ".local/**", "src/wasm/pkg/**", "main.js", "dist/**"] },
	{
		files: ["src/**/*.{ts,tsx,mts,cts}"],
		extends: obsidianmd.configs.recommended,
		rules: { "obsidianmd/prefer-create-el": "error" },
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
			},
		},
	},
]);
