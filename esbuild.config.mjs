import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// set in .env to build straight into a vault, e.g. <vault>/.obsidian/plugins/easy-git-sync
const pluginDir = process.env.OBSIDIAN_PLUGIN_DIR;
const outDir = pluginDir ?? ".";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	outfile: join(outDir, "main.js"),
	bundle: true,
	format: "cjs",
	target: "es2018",
	platform: "browser",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
	],
	plugins: [
		{
			name: "copy-to-vault",
			setup(build) {
				build.onEnd((result) => {
					if (!pluginDir || result.errors.length > 0) return;
					mkdirSync(pluginDir, { recursive: true });
					copyFileSync("manifest.json", join(pluginDir, "manifest.json"));
					copyFileSync("styles.css", join(pluginDir, "styles.css"));
					// picked up by the Hot Reload plugin
					writeFileSync(join(pluginDir, ".hotreload"), "");
				});
			},
		},
	],
});

if (watch) {
	await context.watch();
} else {
	await context.rebuild();
	await context.dispose();
}
