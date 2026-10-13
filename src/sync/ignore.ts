import ignore from "ignore";

// only decides for untracked paths: keeping a tracked file that a rule matches is the caller's job
export class GitIgnore {
	private readonly rules = new Map<string, ReturnType<typeof ignore>>();
	private exclude: ReturnType<typeof ignore> | null = null;

	add(dir: string, content: string): void {
		this.rules.set(dir, ignore().add(content));
	}

	addExclude(content: string): void {
		this.exclude = ignore().add(content);
	}

	ignores(path: string, isDir: boolean): boolean {
		// `.git/info/exclude` first, so every `.gitignore`, deeper ones last, can override it
		let ignored = false;
		if (this.exclude) ignored = this.exclude.ignores(path + (isDir ? "/" : ""));
		const parts = path.split("/");
		for (let depth = 0; depth < parts.length; depth++) {
			const dir = parts.slice(0, depth).join("/");
			const rules = this.rules.get(dir);
			if (!rules) continue;
			const rel = parts.slice(depth).join("/") + (isDir ? "/" : "");
			const result = rules.test(rel);
			if (result.ignored) ignored = true;
			else if (result.unignored) ignored = false;
		}
		return ignored;
	}
}

export function isHardExcluded(path: string, stateFile: string): boolean {
	return (
		path === ".git" ||
		path.startsWith(".git/") ||
		path === ".trash" ||
		path.startsWith(".trash/") ||
		path === stateFile ||
		path === `${stateFile}.tmp` ||
		ICLOUD_PLACEHOLDER.test(path)
	);
}

// iCloud Drive's stand-in for a file not downloaded to this device
const ICLOUD_PLACEHOLDER = /(?:^|\/)\.[^/]+\.icloud$/;

export function defaultGitignore(configDir: string): string {
	return [
		"# window layout, per device and changed on every click",
		`${configDir}/workspace.json`,
		`${configDir}/workspace-mobile.json`,
		"",
		"# which plugins are on is per device: a phone turns off desktop-only plugins,",
		"# and synced, that would turn them off on the desktop too",
		`${configDir}/community-plugins.json`,
		"",
		".trash/",
		".DS_Store",
		"Thumbs.db",
		"desktop.ini",
		"",
	].join("\n");
}
