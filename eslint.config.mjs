import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "src/wasm/pkg/**", "node_modules/**", "crates/**", "*.mjs"],
	},
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
		},
	},
);
