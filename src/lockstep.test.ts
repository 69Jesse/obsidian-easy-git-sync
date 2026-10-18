import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitLockstep } from "./lockstep";

// a bare repository stands in for GitHub: `url.insteadOf` sends the plugin's github.com URL to it
const fullName = "someone/vault";
const stateFile = ".obsidian/plugins/easy-git-sync/state.json";

describe("git lockstep", () => {
	// the plugin reaches node through Electron's window.require
	(globalThis as unknown as { window: { require: NodeJS.Require } }).window = {
		require: createRequire(import.meta.url),
	};
	let root: string;
	let remote: string;
	let vault: string;
	let device: string;

	const run = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
			},
		}).trim();
	const git = (...args: string[]) => run(vault, ...args);
	const write = (dir: string, file: string, content: string) =>
		writeFileSync(join(dir, file), content);
	// what another device, or the plugin's own upload, puts on the branch
	const commitElsewhere = (file: string, content: string, message: string) => {
		run(device, "pull", "--quiet", "--ff-only");
		write(device, file, content);
		run(device, "add", file);
		run(device, "commit", "--quiet", "-m", message);
		run(device, "push", "--quiet");
		return run(device, "rev-parse", "HEAD");
	};
	const remoteHead = () => run(remote, "rev-parse", "main");

	const clone = (dir: string) => {
		run(root, "clone", "--quiet", remote, dir);
		run(dir, "config", "user.email", "test@example.com");
		run(dir, "config", "user.name", "Lockstep test");
		run(dir, "config", `url.${remote}.insteadOf`, `https://github.com/${fullName}.git`);
	};

	const detect = async () => {
		const lockstep = await GitLockstep.detect(vault, fullName, "main", () => null, stateFile);
		if (!lockstep) throw new Error("no lockstep");
		return lockstep;
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "easy-git-sync-lockstep-"));
		remote = join(root, "remote.git");
		vault = join(root, "vault");
		device = join(root, "device");
		run(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
		clone(device);
		write(device, "a.md", "one\ntwo\nthree\n");
		run(device, "add", "a.md");
		run(device, "commit", "--quiet", "-m", "start");
		run(device, "push", "--quiet", "origin", "main");
		clone(vault);
		git("remote", "set-url", "origin", `https://github.com/${fullName}.git`);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("replays a commit made on a stale HEAD onto the branch, keeping its message and author", async () => {
		const start = git("rev-parse", "HEAD");
		const other = commitElsewhere("b.md", "from the phone\n", "Phone: b.md");
		write(vault, "c.md", "by hand\n");
		git("add", "c.md");
		git("-c", "user.name=Jesse", "commit", "--quiet", "-m", "made by hand\n\nwith a body");
		const local = git("rev-parse", "HEAD");

		const lockstep = await detect();
		expect(await lockstep.beforeSync(start)).toBe(local);

		const pushed = remoteHead();
		expect(pushed).not.toBe(local);
		expect(run(remote, "rev-parse", `${pushed}^`)).toBe(other);
		expect(run(remote, "log", "-1", "--format=%an%n%B", pushed)).toBe(
			"Jesse\nmade by hand\n\nwith a body",
		);
		expect(run(remote, "show", `${pushed}:c.md`)).toBe("by hand");

		// the plugin's upload lands on top, and the clone follows it
		const synced = commitElsewhere("d.md", "uploaded\n", "Macbook: d.md");
		await lockstep.afterSync(synced, local);
		expect(git("rev-parse", "HEAD")).toBe(synced);
		expect(git("log", "--format=%s", "-3")).toBe("Macbook: d.md\nmade by hand\nPhone: b.md");
	});

	it("drops a commit whose change the sync already uploaded", async () => {
		const start = git("rev-parse", "HEAD");
		const uploaded = commitElsewhere("c.md", "same\n", "Macbook: c.md");
		write(vault, "c.md", "same\n");
		git("add", "c.md");
		git("commit", "--quiet", "-m", "by hand");
		const local = git("rev-parse", "HEAD");

		const lockstep = await detect();
		expect(await lockstep.beforeSync(start)).toBe(local);
		expect(remoteHead()).toBe(uploaded);

		await lockstep.afterSync(uploaded, local);
		expect(git("rev-parse", "HEAD")).toBe(uploaded);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("pushes nothing on a conflict, leaving the content to the sync", async () => {
		const start = git("rev-parse", "HEAD");
		const other = commitElsewhere("a.md", "one\nTWO\nthree\n", "Phone: a.md");
		write(vault, "a.md", "one\n2\nthree\n");
		git("commit", "--quiet", "-am", "edit two");
		const local = git("rev-parse", "HEAD");

		const lockstep = await detect();
		expect(await lockstep.beforeSync(start)).toBe(local);
		expect(remoteHead()).toBe(other);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("follows the sync while changes are staged, without touching the working tree", async () => {
		const lockstep = await detect();
		const head = git("rev-parse", "HEAD");
		git("mv", "a.md", "renamed.md");
		expect(await lockstep.beforeSync(head)).toBe(head);

		// the upload has the rename, read off disk
		run(device, "pull", "--quiet", "--ff-only");
		run(device, "mv", "a.md", "renamed.md");
		run(device, "commit", "--quiet", "-m", "Macbook: renamed.md");
		run(device, "push", "--quiet");
		const synced = run(device, "rev-parse", "HEAD");

		await lockstep.afterSync(synced, head);
		expect(git("rev-parse", "HEAD")).toBe(synced);
		expect(git("status", "--porcelain")).toBe("");
		expect(readFileSync(join(vault, "renamed.md"), "utf8")).toBe("one\ntwo\nthree\n");
	});

	it("leaves HEAD alone when a commit was made while the sync ran", async () => {
		const lockstep = await detect();
		const head = git("rev-parse", "HEAD");
		expect(await lockstep.beforeSync(head)).toBe(head);
		const synced = commitElsewhere("b.md", "uploaded\n", "Macbook: b.md");
		write(vault, "c.md", "by hand\n");
		git("add", "c.md");
		git("commit", "--quiet", "-m", "mid-sync");
		const local = git("rev-parse", "HEAD");

		await lockstep.afterSync(synced, head);
		expect(git("rev-parse", "HEAD")).toBe(local);

		// the next sync replays it
		expect(await lockstep.beforeSync(synced)).toBe(local);
		expect(run(remote, "log", "-1", "--format=%s", "main")).toBe("mid-sync");
		expect(run(remote, "rev-parse", "main^")).toBe(synced);
	});
});
