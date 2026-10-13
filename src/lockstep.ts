type ExecFile = (
	file: string,
	args: string[],
	options: {
		cwd: string;
		env: Record<string, string | undefined>;
		timeout: number;
		encoding: "utf8";
		maxBuffer: number;
	},
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

interface NodeModules {
	execFile: ExecFile;
	existsSync: (path: string) => boolean;
	readFileSync: (path: string, encoding: "utf8") => string;
	appendFileSync: (path: string, data: string) => void;
	mkdirSync: (path: string, options: { recursive: true }) => void;
	join: (...parts: string[]) => string;
	dirname: (path: string) => string;
	delimiter: string;
}

function nodeModules(): NodeModules | null {
	const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
	if (!nodeRequire) return null;
	try {
		const cp = nodeRequire("child_process") as { execFile: ExecFile };
		const fs = nodeRequire("fs") as Pick<
			NodeModules,
			"existsSync" | "readFileSync" | "appendFileSync" | "mkdirSync"
		>;
		const path = nodeRequire("path") as Pick<NodeModules, "join" | "dirname" | "delimiter">;
		return {
			execFile: cp.execFile,
			existsSync: fs.existsSync,
			readFileSync: fs.readFileSync,
			appendFileSync: fs.appendFileSync,
			mkdirSync: fs.mkdirSync,
			join: path.join,
			dirname: path.dirname,
			delimiter: path.delimiter,
		};
	} catch {
		return null;
	}
}

export class GitLockstep {
	private constructor(
		private readonly node: NodeModules,
		private readonly cwd: string,
		private readonly fullName: string,
		private readonly branch: string,
		private readonly token: () => string | null,
	) {}

	// another branch checked out is not a reason for null: blocker() has to pause syncing then
	static async detect(
		basePath: string,
		fullName: string,
		branch: string,
		token: () => string | null,
		stateFile: string,
	): Promise<GitLockstep | null> {
		const node = nodeModules();
		if (!node?.existsSync(node.join(basePath, ".git"))) return null;
		const lockstep = new GitLockstep(node, basePath, fullName, branch, token);
		try {
			const url = (
				await lockstep.git(["config", "--get", "remote.origin.url"]).catch(() => "")
			).trim();
			if (url && !sameRepo(url, fullName)) return null;
			await lockstep.excludeLocally(stateFile).catch(() => undefined);
			return lockstep;
		} catch {
			return null;
		}
	}

	async beforeSync(synced: string | null): Promise<void> {
		if (!(await this.safe())) return;
		if ((await this.head()) === synced) return;
		await this.fetch();
		const ahead = Number((await this.git(["rev-list", "--count", "FETCH_HEAD..HEAD"])).trim());
		if (!(ahead > 0)) return;
		const ancestor = await this.git(["merge-base", "--is-ancestor", "FETCH_HEAD", "HEAD"]).then(
			() => true,
			() => false,
		);
		// diverged: the content is in the working tree and goes up with the sync
		if (!ancestor) return;
		await this.git(["push", this.url(), `HEAD:refs/heads/${this.branch}`]);
	}

	async afterSync(commit: string): Promise<void> {
		if (!(await this.safe()) || (await this.head()) === commit) return;
		// reset --mixed rebuilds the index, so anything staged wins and the branch catches up later
		const staged = await this.git(["diff", "--cached", "--quiet"]).then(
			() => false,
			() => true,
		);
		if (staged) return;
		await this.fetch();
		const fetched = (await this.git(["rev-parse", "FETCH_HEAD"])).trim();
		if (fetched !== commit) return;
		await this.git(["reset", "--mixed", "-q", "FETCH_HEAD"]);
		await this.git(["update-ref", `refs/remotes/origin/${this.branch}`, "FETCH_HEAD"]).catch(
			() => "",
		);
	}

	private async head(): Promise<string> {
		return (await this.git(["rev-parse", "HEAD"])).trim();
	}

	private fetch(): Promise<string> {
		return this.git(["fetch", "--quiet", "--no-tags", this.url(), `refs/heads/${this.branch}`]);
	}

	async blocker(): Promise<string | null> {
		const branch = await this.git(["symbolic-ref", "--short", "-q", "HEAD"]).then(
			(out) => out.trim(),
			() => null,
		);
		if (branch === null) return "the vault's git checkout is not on a branch.";
		if (branch !== this.branch) {
			return `the vault's git checkout is on branch "${branch}", and this vault syncs "${this.branch}".`;
		}
		const operations: Array<[string, string]> = [
			["MERGE_HEAD", "a git merge"],
			["rebase-merge", "a git rebase"],
			["rebase-apply", "a git rebase"],
			["CHERRY_PICK_HEAD", "a git cherry-pick"],
			["REVERT_HEAD", "a git revert"],
		];
		for (const [marker, what] of operations) {
			if (await this.gitPathExists(marker)) return `${what} is in progress in this vault.`;
		}
		return null;
	}

	private async gitPathExists(name: string): Promise<boolean> {
		const relative = (await this.git(["rev-parse", "--git-path", name])).trim();
		return this.node.existsSync(
			relative.startsWith("/") ? relative : this.node.join(this.cwd, relative),
		);
	}

	private async safe(): Promise<boolean> {
		try {
			if ((await this.blocker()) !== null) return false;
			return !(await this.gitPathExists("index.lock"));
		} catch {
			return false;
		}
	}

	private url(): string {
		return `https://github.com/${this.fullName}.git`;
	}

	private async excludeLocally(stateFile: string): Promise<void> {
		// --git-path resolves worktrees and a .git file pointing elsewhere
		const relative = (await this.git(["rev-parse", "--git-path", "info/exclude"])).trim();
		const exclude = relative.startsWith("/") ? relative : this.node.join(this.cwd, relative);
		// a clone made without git's templates has no info/ folder
		this.node.mkdirSync(this.node.dirname(exclude), { recursive: true });
		const current = this.node.existsSync(exclude) ? this.node.readFileSync(exclude, "utf8") : "";
		const pattern = `${stateFile}*`;
		if (current.split("\n").includes(pattern)) return;
		this.node.appendFileSync(
			exclude,
			`${current === "" || current.endsWith("\n") ? "" : "\n"}${pattern}\n`,
		);
	}

	private git(args: string[]): Promise<string> {
		const token = this.token();
		const env: Record<string, string | undefined> = {
			...process.env,
			// macOS apps launched from the Dock do not get the shell's PATH
			PATH: [
				process.env.PATH,
				...(process.platform === "darwin"
					? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
					: []),
			]
				.filter(Boolean)
				.join(this.node.delimiter),
			GIT_TERMINAL_PROMPT: "0",
		};
		if (token) {
			const basic = btoa(`x-access-token:${token}`);
			env.GIT_CONFIG_COUNT = "1";
			env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
			env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
		}
		return new Promise((resolve, reject) => {
			this.node.execFile(
				"git",
				args,
				{ cwd: this.cwd, env, timeout: 60_000, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
				(error, stdout, stderr) => {
					if (error) reject(new Error(stderr.trim() || error.message));
					else resolve(stdout);
				},
			);
		});
	}
}

function sameRepo(url: string, fullName: string): boolean {
	const normalized = url
		.toLowerCase()
		.replace(/\.git$/, "")
		.replace(/^git@github\.com:/, "https://github.com/");
	return normalized.endsWith(`github.com/${fullName.toLowerCase()}`);
}
