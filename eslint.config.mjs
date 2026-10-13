import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["*.mjs"],
				},
			},
		},
		rules: {
			// typescript already checks this, and knows about node's globals
			"no-undef": "off",
		},
	},
	{
		// run by node, never bundled into the plugin
		files: ["*.mjs", "src/**/*.test.ts", "src/sync/fixtures.ts"],
		rules: {
			"no-restricted-globals": "off",
			"obsidianmd/hardcoded-config-path": "off",
			"obsidianmd/no-global-this": "off",
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/prefer-window-timers": "off",
		},
	},
]);
