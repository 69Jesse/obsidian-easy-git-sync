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

	// the HEAD afterSync may move on from; null leaves HEAD alone
	async beforeSync(synced: string | null): Promise<string | null> {
		if (!(await this.safe())) return null;
		const head = await this.head();
		if (head === synced) return head;
		await this.fetch();
		const fetched = (await this.git(["rev-parse", "FETCH_HEAD"])).trim();
		const ahead = Number((await this.git(["rev-list", "--count", `${fetched}..${head}`])).trim());
		if (!(ahead > 0)) return head;
		const ancestor = await this.git(["merge-base", "--is-ancestor", fetched, head]).then(
			() => true,
			() => false,
		);
		const tip = ancestor ? head : await this.replay(fetched, head);
		// a failed push throws, so afterSync is skipped and HEAD keeps the commits for the next sync
		if (tip !== fetched) await this.git(["push", this.url(), `${tip}:refs/heads/${this.branch}`]);
		return head;
	}

	// merge-tree and commit-tree rather than a rebase, which would rewrite the working tree
	private async replay(onto: string, head: string): Promise<string> {
		const commits = (await this.git(["rev-list", "--reverse", "--topo-order", `${onto}..${head}`]))
			.split("\n")
			.filter(Boolean);
		let tip = onto;
		for (const commit of commits) {
			const [, parent, ...more] = (await this.git(["rev-list", "--parents", "-n", "1", commit]))
				.trim()
				.split(" ");
			// a merge or a root commit has no one parent to replay from: the sync uploads it from disk
			if (parent === undefined || more.length > 0) return onto;
			// exits 1 on a conflict: the sync merges the same content from disk instead
			const merged = await this.git([
				"merge-tree",
				"--write-tree",
				"--no-messages",
				`--merge-base=${parent}`,
				tip,
				commit,
			]).catch(() => null);
			if (merged === null) return onto;
			const tree = merged.split("\n")[0]?.trim() ?? "";
			// an earlier sync already uploaded this change from disk: dropped, as a rebase would
			if (tree === (await this.git(["rev-parse", `${tip}^{tree}`])).trim()) continue;
			const [name, email, date, ...message] = (
				await this.git(["log", "-1", "--format=%an%n%ae%n%ad%n%B", "--date=raw", commit])
			).split("\n");
			tip = (
				await this.git(["commit-tree", tree, "-p", tip, "-m", message.join("\n").trim()], {
					GIT_AUTHOR_NAME: name,
					GIT_AUTHOR_EMAIL: email,
					GIT_AUTHOR_DATE: date,
				})
			).trim();
		}
		return tip;
	}

	async afterSync(commit: string, before: string): Promise<void> {
		if (!(await this.safe())) return;
		const head = await this.head();
		// a commit made while the sync ran would be dropped by the reset; the next sync replays it
		if (head === commit || head !== before) return;
		await this.fetch();
		const fetched = (await this.git(["rev-parse", "FETCH_HEAD"])).trim();
		if (fetched !== commit) return;
		// unstages anything staged, which the sync already uploaded from disk
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

	private git(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
		const token = this.token();
		const env: Record<string, string | undefined> = {
			...process.env,
			...extraEnv,
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
