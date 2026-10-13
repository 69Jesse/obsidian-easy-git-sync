import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitLockstep } from "./lockstep";
import { GitHubClient, GitHubRemote } from "./remote/github";
import type { Http } from "./remote/http";

const token = process.env.EASY_GIT_TOKEN;
const repo = process.env.EASY_GIT_REPO;

const http: Http = async (request) => {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		...(request.body === undefined ? {} : { body: request.body }),
	});
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});
	return { status: response.status, headers, body: await response.arrayBuffer() };
};

describe.skipIf(!token || !repo)("git lockstep, live", () => {
	// the plugin reaches node through Electron's window.require
	(globalThis as unknown as { window: { require: NodeJS.Require } }).window = {
		require: createRequire(import.meta.url),
	};
	const dir = mkdtempSync(join(tmpdir(), "easy-git-sync-lockstep-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: dir,
			encoding: "utf8",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		}).trim();
	const remote = new GitHubRemote(new GitHubClient(http, () => token ?? null), repo ?? "", "main");
	const stateFile = ".obsidian/plugins/easy-git-sync/state.json";

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("pushes commits made outside the plugin, then follows what the plugin synced", {
		timeout: 120_000,
	}, async () => {
		const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
		execFileSync("git", [
			"-c",
			`http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
			"clone",
			"--quiet",
			`https://github.com/${repo}.git`,
			dir,
		]);
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Lockstep test");

		const lockstep = await GitLockstep.detect(
			dir,
			repo ?? "",
			"main",
			() => token ?? null,
			stateFile,
		);
		expect(lockstep).not.toBeNull();
		if (!lockstep) return;
		expect(git("rev-parse", "--git-path", "info/exclude")).toBeTruthy();

		expect(await lockstep.blocker()).toBeNull();
		git("checkout", "--quiet", "-b", "elsewhere");
		expect(await lockstep.blocker()).toBe(
			'the vault\'s git checkout is on branch "elsewhere", and this vault syncs "main".',
		);
		git("checkout", "--quiet", "main");
		writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${git("rev-parse", "HEAD")}\n`);
		expect(await lockstep.blocker()).toBe("a git merge is in progress in this vault.");
		rmSync(join(dir, ".git", "MERGE_HEAD"));
		expect(await lockstep.blocker()).toBeNull();

		const synced = await remote.head();
		const file = `lockstep-${Date.now().toString(36)}.md`;
		writeFileSync(join(dir, file), "from the command line\n");
		git("add", file);
		git("commit", "--quiet", "-m", "made by hand");
		const local = git("rev-parse", "HEAD");
		await lockstep.beforeSync(synced);
		expect(await remote.head()).toBe(local);

		const head = (await remote.head()) ?? "";
		const tree = await remote.readTree(head);
		const result = await remote.commit({
			parent: head,
			baseTree: tree.tree,
			changes: [{ path: file, read: null, mode: "100644" }],
			message: "vault backup: lockstep test\n\nSynced-From: test",
		});
		if (result === "moved") throw new Error("branch moved during the test");
		writeFileSync(join(dir, "untouched.txt"), "working tree file\n");
		await lockstep.afterSync(result.commit);
		expect(git("rev-parse", "HEAD")).toBe(result.commit);
		expect(git("log", "-1", "--format=%s")).toBe("vault backup: lockstep test");
		// still on disk, since reset --mixed leaves the working tree alone
		expect(git("status", "--porcelain")).toContain(file);
		expect(git("show", `HEAD~1:${file}`)).toBe("from the command line");
	});
});
