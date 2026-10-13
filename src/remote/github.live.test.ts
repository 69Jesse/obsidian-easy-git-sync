import { describe, expect, it } from "vitest";
import { findConflicts } from "../merge/conflict";
import { type ConflictStrategy, sync } from "../sync/engine";
import { MemoryFs } from "../sync/fixtures";
import { emptyState, type SyncState } from "../sync/types";
import { GitHubClient, GitHubRemote } from "./github";
import type { Http } from "./http";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const token = process.env.EASY_GIT_TOKEN;
const repo = process.env.EASY_GIT_REPO;

const requested: string[] = [];

const http: Http = async (request) => {
	requested.push(`${request.method} ${request.url}`);
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

class LiveDevice {
	readonly fs = new MemoryFs();
	state: SyncState;
	constructor(
		readonly name: string,
		readonly remote: GitHubRemote,
	) {
		this.state = emptyState(repo ?? "");
	}
	async sync(options: { conflicts?: ConflictStrategy } = {}) {
		const result = await sync(this.state, {
			fs: this.fs,
			remote: this.remote,
			device: this.name,
			stateFile: ".obsidian/plugins/easy-git-sync/state.json",
			configDir: ".obsidian",
			allowMassDelete: true,
			...options,
			saveState: async (state) => {
				this.state = state;
			},
		});
		this.state = result.state;
		return result.report;
	}
}

describe.skipIf(!token || !repo)("GitHub, live", () => {
	const client = new GitHubClient(http, () => token ?? null, sleep);
	const remote = new GitHubRemote(client, repo ?? "", "main");
	const run = Date.now().toString(36);
	const dir = `live-${run}`;

	it("lists the token's user and repositories", async () => {
		const user = await client.user();
		expect(user.login).toBeTruthy();
		const info = await client.repo(repo ?? "");
		expect(info.canPush).toBe(true);
		const branches = await client.branches(repo ?? "", info.defaultBranch);
		expect(branches[0]).toBe(info.defaultBranch);
	});

	it.skipIf(!process.env.EASY_GIT_READONLY_REPO)(
		"tells a token's read-only repositories apart",
		async () => {
			const readOnly = process.env.EASY_GIT_READONLY_REPO ?? "";
			expect((await client.repo(readOnly)).canPush).toBe(false);
			const listed = await client.repos();
			expect(listed.find((r) => r.fullName === readOnly)?.canPush).toBe(false);
			expect(listed.find((r) => r.fullName === repo)?.canPush).toBe(true);
		},
	);

	it("commits off the account under an address GitHub cannot link", async () => {
		const anonymous = new GitHubRemote(client, repo ?? "", "main", false);
		const head = await anonymous.head();
		if (head === null) return;
		const { tree } = await anonymous.readTree(head);
		const path = `${dir}-author.md`;
		const made = await anonymous.commit({
			parent: head,
			baseTree: tree,
			changes: [{ path, mode: "100644", read: async () => new TextEncoder().encode("hi\n") }],
			message: "Live test: commit off the account",
		});
		if (made === "moved") throw new Error("the branch moved during the test");
		const commit = await client.json<{
			author: { email: string };
			committer: { email: string };
		}>("GET", `/repos/${repo}/git/commits/${made.commit}`);
		expect(commit.author.email).toMatch(/@easy-git-sync\.invalid$/);
		expect(commit.committer.email).toBe(commit.author.email);
		await anonymous.commit({
			parent: made.commit,
			baseTree: made.tree,
			changes: [{ path, mode: "100644", read: null }],
			message: "Live test: clean up",
		});
	});

	it("syncs two devices through GitHub, merging and conflicting", {
		timeout: 120_000,
	}, async () => {
		const mac = new LiveDevice("MacBook", remote);
		const phone = new LiveDevice("iPhone", remote);

		mac.fs.set(`${dir}/note.md`, "---\nstatus: draft\n---\none\ntwo\nthree\n");
		mac.fs.set(`${dir}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
		mac.fs.set(`${dir}/ünïcode name.md`, "héllo\n");
		for (let i = 0; i < 45; i++) mac.fs.set(`${dir}/bulk/n${i}.md`, `note ${i}\n`);
		await mac.sync();

		// over ARCHIVE_THRESHOLD files, so the first download takes the tarball
		requested.length = 0;
		await phone.sync();
		expect(requested.filter((r) => r.includes("/tarball/"))).toHaveLength(1);
		expect(requested.filter((r) => r.includes("/git/blobs/")).length).toBeLessThan(5);
		for (const [path, text] of Object.entries(mac.fs.text())) {
			if (path.startsWith(dir)) expect(phone.fs.get(path)).toBe(text);
		}
		expect(phone.fs.files.get(`${dir}/image.png`)?.data).toEqual(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
		);

		mac.fs.set(`${dir}/note.md`, "---\nstatus: done\n---\nONE\ntwo\nthree mac\n");
		phone.fs.set(`${dir}/note.md`, "---\nstatus: waiting\n---\none\ntwo\nthree phone\n");
		phone.fs.delete(`${dir}/bulk/n0.md`);
		await mac.sync();
		const report = await phone.sync();
		expect(report.conflicts).toEqual([{ path: `${dir}/note.md`, count: 2 }]);
		await mac.sync();
		expect(mac.fs.get(`${dir}/note.md`)).toBe(phone.fs.get(`${dir}/note.md`));
		const conflicts = findConflicts((phone.fs.get(`${dir}/note.md`) ?? "").split("\n"));
		expect(conflicts.map((c) => c.property)).toEqual(["status", null]);
		expect(conflicts[1]?.sides[0]?.label).toMatch(/^MacBook, /);
		expect(mac.fs.get(`${dir}/bulk/n0.md`)).toBeUndefined();

		for (const path of Object.keys(mac.fs.text())) if (path.startsWith(dir)) mac.fs.delete(path);
		await mac.sync();
	});

	it("keeps the newer version, the older one as a merged-in commit, dated by the edits", {
		timeout: 120_000,
	}, async () => {
		const mac = new LiveDevice("MacBook", remote);
		const phone = new LiveDevice("iPhone", remote);
		const path = `${dir}-newer/n.md`;
		await mac.sync();
		await phone.sync();
		mac.fs.set(path, "one\ntwo\nthree\n");
		await mac.sync();
		await phone.sync();

		const macEdit = new Date(Date.now() - 60 * 60_000);
		const phoneEdit = new Date(Date.now() - 2 * 60 * 60_000);
		mac.fs.set(path, "ONE mac\ntwo\nTHREE\n", macEdit);
		phone.fs.set(path, "ONE phone\ntwo\nthree\n", phoneEdit);
		await mac.sync();

		const macCommit = await remote.lastChange(path, (await remote.head()) ?? "");
		expect(macCommit?.authored?.getTime()).toBe(Math.floor(macEdit.getTime() / 1000) * 1000);
		const user = await client.user();
		const linked = await client.json<{ author: { login: string } | null }>(
			"GET",
			`/repos/${repo}/commits/${macCommit?.sha}`,
		);
		expect(linked.author?.login).toBe(user.login);

		const report = await phone.sync({ conflicts: "newest" });
		expect(report.newer).toEqual([{ path, from: "MacBook", places: 1 }]);
		expect(phone.fs.get(path)).toBe("ONE mac\ntwo\nTHREE\n");

		const head = (await remote.head()) ?? "";
		const merge = await client.json<{ parents: Array<{ sha: string }> }>(
			"GET",
			`/repos/${repo}/git/commits/${head}`,
		);
		expect(merge.parents).toHaveLength(2);
		const side = merge.parents[1]?.sha ?? "";
		const kept = await remote.readTree(side);
		const blobs = await remote.readBlobs([{ sha: kept.files.get(path)?.sha ?? "", path }], side);
		expect(new TextDecoder().decode([...blobs.values()][0])).toBe("ONE phone\ntwo\nthree\n");
		expect((await remote.lastChange(path, head))?.sha).not.toBe(side);

		const history = await remote.fileHistory(path, head, 10);
		expect(history.length).toBeGreaterThanOrEqual(2);

		mac.fs.delete(path);
		await mac.sync();
	});
});
