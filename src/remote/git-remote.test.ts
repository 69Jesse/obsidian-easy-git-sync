import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeUtf8 } from "../lib/bytes";
import { findConflicts } from "../merge/conflict";
import { type ConflictStrategy, type FirstSync, type SyncReport, sync } from "../sync/engine";
import { MemoryFs } from "../sync/fixtures";
import { emptyState, type SyncState } from "../sync/types";
import { GitServer, nodeHttp } from "./fixtures";
import { GitHttp } from "./git/smart";
import { type BlobStash, GitRemote } from "./git-remote";
import { RemoteError } from "./http";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const STATE = ".obsidian/plugins/easy-git-sync/state.json";

class MemoryStash implements BlobStash {
	readonly blobs = new Map<string, Uint8Array>();
	async get(sha: string) {
		return this.blobs.get(sha) ?? null;
	}
	async put(sha: string, bytes: Uint8Array) {
		this.blobs.set(sha, bytes);
	}
	async delete(sha: string) {
		this.blobs.delete(sha);
	}
}

class Device {
	readonly fs = new MemoryFs();
	state: SyncState = emptyState("server");
	remote: GitRemote;
	readonly stash = new MemoryStash();

	constructor(
		readonly name: string,
		private readonly url: string,
		private readonly login: { username: string; password: string } | null = null,
	) {
		this.remote = this.connect();
	}

	connect(): GitRemote {
		const git = new GitHttp(nodeHttp, this.url, () => this.login, "the server", sleep);
		return new GitRemote(
			git,
			"main",
			async () => ({ name: "Jesse", email: "jesse@easy-git-sync.invalid" }),
			this.stash,
		);
	}

	// a fresh remote, as after the app was closed: nothing cached but the saved state
	restart(): void {
		this.remote = this.connect();
	}

	async sync(
		options: { conflicts?: ConflictStrategy; firstSync?: FirstSync } = {},
	): Promise<SyncReport> {
		const result = await sync(this.state, {
			fs: this.fs,
			remote: this.remote,
			device: this.name,
			stateFile: STATE,
			configDir: ".obsidian",
			allowMassDelete: true,
			remoteName: "the server",
			...options,
			saveState: async (state) => {
				this.state = state;
			},
		});
		this.state = result.state;
		return result.report;
	}
}

const setups = [
	{ label: "protocol v2, partial fetches", v2: true, partial: true },
	{ label: "protocol v2, whole fetches", v2: true, partial: false },
	{ label: "protocol v0, partial fetches", v2: false, partial: true },
	{ label: "protocol v0, whole fetches", v2: false, partial: false },
];

// each request starts a git process, so a sync takes a moment
describe.each(setups)("git over HTTP, $label", { timeout: 30_000 }, ({ v2, partial }) => {
	const server = new GitServer({ v2, partial });
	let count = 0;
	const fresh = () => {
		const repo = `vault${++count}`;
		server.create(repo);
		return { repo, url: server.url(repo) };
	};

	beforeAll(() => server.start());
	afterAll(() => server.stop());

	it("starts an empty repository and brings a second device level", async () => {
		const { repo, url } = fresh();
		const mac = new Device("MacBook", url);
		mac.fs.set("a.md", "hello\n");
		mac.fs.set("notes/deep/b.md", "deep\n");
		mac.fs.set("img.png", new Uint8Array([0, 1, 2, 255, 0, 7]));
		const report = await mac.sync();
		expect(report.initialized).toBe(true);
		expect(server.git(repo, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n")).toEqual([
			".gitignore",
			"a.md",
			"img.png",
			"notes/deep/b.md",
		]);
		server.git(repo, ["fsck", "--strict"]);
		expect(server.git(repo, ["log", "-1", "--format=%an <%ae>"]).trim()).toBe(
			"Jesse <jesse@easy-git-sync.invalid>",
		);

		const phone = new Device("iPhone", url);
		await phone.sync();
		expect(phone.fs.get("notes/deep/b.md")).toBe("deep\n");
		expect([...(phone.fs.files.get("img.png")?.data ?? [])]).toEqual([0, 1, 2, 255, 0, 7]);
	});

	it("merges edits in different places and marks a clash", async () => {
		const { url } = fresh();
		const mac = new Device("MacBook", url);
		const phone = new Device("iPhone", url);
		mac.fs.set("n.md", "one\ntwo\nthree\nfour\nfive\n");
		await mac.sync();
		await phone.sync();
		mac.fs.set("n.md", "ONE\ntwo\nthree\nfour\nfive\n");
		phone.fs.set("n.md", "one\ntwo\nthree\nfour\nFIVE\n");
		await mac.sync();
		await phone.sync();
		expect(phone.fs.get("n.md")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
		await mac.sync();
		expect(mac.fs.get("n.md")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");

		mac.fs.set("n.md", "ONE\nmac\nthree\nfour\nFIVE\n");
		phone.fs.set("n.md", "ONE\nphone\nthree\nfour\nFIVE\n");
		await mac.sync();
		const report = await phone.sync();
		expect(report.conflicts.map((c) => c.path)).toEqual(["n.md"]);
		const blocks = findConflicts((phone.fs.get("n.md") ?? "").split("\n"));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.sides.map((side) => side.label).join(" ")).toContain("MacBook");
	});

	it("keeps the losing version in the history as a second parent", async () => {
		const { repo, url } = fresh();
		const mac = new Device("MacBook", url);
		const phone = new Device("iPhone", url);
		mac.fs.set("n.md", "a\nb\nc\n");
		await mac.sync();
		await phone.sync();
		mac.fs.set("n.md", "a\nmac\nc\n", new Date(2026, 9, 1, 10));
		phone.fs.set("n.md", "a\nphone\nc\n", new Date(2026, 9, 1, 9));
		await mac.sync();
		const report = await phone.sync({ conflicts: "newest" });
		expect(report.newer.map((n) => n.path)).toEqual(["n.md"]);
		expect(phone.fs.get("n.md")).toBe("a\nmac\nc\n");
		const parents = server.git(repo, ["log", "-1", "--format=%P", "main"]).trim().split(" ");
		expect(parents).toHaveLength(2);
		expect(server.git(repo, ["show", `${parents[1]}:n.md`])).toBe("a\nphone\nc\n");
		expect(server.git(repo, ["log", "-1", "--format=%B", parents[1] ?? ""])).toContain(
			"Superseded-By:",
		);
		expect(phone.stash.blobs.size).toBe(0);
	});

	it("deletes, renames and keeps an executable file executable", async () => {
		const { repo, url } = fresh();
		const mac = new Device("MacBook", url);
		const phone = new Device("iPhone", url);
		mac.fs.set("old/name.md", "content that moves\n");
		mac.fs.set("gone.md", "bye\n");
		await mac.sync();
		await phone.sync();
		server.git(repo, ["update-ref", "refs/heads/keep", "main"]);
		phone.fs.delete("old/name.md");
		phone.fs.set("new/name.md", "content that moves\n");
		phone.fs.delete("gone.md");
		await phone.sync();
		expect(server.git(repo, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n")).toEqual([
			".gitignore",
			"new/name.md",
		]);
		await mac.sync();
		expect(mac.fs.get("new/name.md")).toBe("content that moves\n");
		expect(mac.fs.get("old/name.md")).toBeUndefined();
	});

	it("uploads a file that takes the place of a folder", async () => {
		const { repo, url } = fresh();
		const mac = new Device("MacBook", url);
		mac.fs.set("notes/a.md", "in a folder\n");
		await mac.sync();
		mac.fs.delete("notes/a.md");
		mac.fs.set("notes", "now a file\n");
		await mac.sync();
		expect(server.git(repo, ["show", "main:notes"])).toBe("now a file\n");
		await mac.sync();
		expect(mac.fs.get("notes")).toBe("now a file\n");
	});

	it("reruns when another device pushed during the upload", async () => {
		const { url } = fresh();
		const mac = new Device("MacBook", url);
		const phone = new Device("iPhone", url);
		mac.fs.set("a.md", "a\n");
		await mac.sync();
		await phone.sync();
		const parent = phone.state.commit ?? "";
		mac.fs.set("b.md", "b\n");
		await mac.sync();
		const result = await phone.remote.commit({
			parent,
			baseTree: phone.state.tree ?? "",
			changes: [{ path: "c.md", mode: "100644", read: async () => encodeUtf8("c\n") }],
			message: "iPhone: c.md",
		});
		expect(result).toBe("moved");
		phone.fs.set("c.md", "c\n");
		await phone.sync();
		expect(phone.fs.get("b.md")).toBe("b\n");
		await mac.sync();
		expect(mac.fs.get("c.md")).toBe("c\n");
	});

	it("uploads after a restart without downloading the vault again", async () => {
		const { url } = fresh();
		const mac = new Device("MacBook", url);
		for (let i = 0; i < 30; i++) mac.fs.set(`notes/${i % 4}/n${i}.md`, `note ${i}\n`);
		await mac.sync();
		mac.restart();
		const before = server.requests.length;
		mac.fs.set("notes/1/n1.md", "edited\n");
		await mac.sync();
		const fetches = server.requests.slice(before).filter((r) => /want [0-9a-f]{40}/.test(r.body));
		expect(fetches).toEqual([]);
		const phone = new Device("iPhone", url);
		await phone.sync();
		expect(phone.fs.get("notes/1/n1.md")).toBe("edited\n");

		// after a restart with news from elsewhere, only what changed comes down
		phone.restart();
		mac.fs.set("notes/2/n2.md", "edited too\n");
		await mac.sync();
		await phone.sync();
		expect(phone.fs.get("notes/2/n2.md")).toBe("edited too\n");
	});

	it.runIf(partial)("updates a stale copy from the history on a first sync", async () => {
		const { url } = fresh();
		const mac = new Device("MacBook", url);
		mac.fs.set("n.md", "version one\n");
		await mac.sync();
		mac.fs.set("n.md", "version one\nand two\n");
		await mac.sync();
		const phone = new Device("iPhone", url);
		phone.fs.set("n.md", "version one\n");
		phone.fs.set("other.md", "only here\n");
		const report = await phone.sync({ firstSync: "merge" });
		expect(report.conflicts).toEqual([]);
		expect(phone.fs.get("n.md")).toBe("version one\nand two\n");
	});
});

describe("git over HTTP with a login", () => {
	const login = { username: "jesse", password: "s3cret" };
	const server = new GitServer({ v2: true, partial: true, login });
	beforeAll(() => server.start());
	afterAll(() => server.stop());

	it("syncs with the right password and says so plainly with a wrong one", async () => {
		server.create("vault");
		const mac = new Device("MacBook", server.url("vault"), login);
		mac.fs.set("a.md", "a\n");
		await mac.sync();
		const intruder = new Device("Laptop", server.url("vault"), { ...login, password: "wrong" });
		const error = await intruder.sync().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RemoteError);
		expect((error as RemoteError).kind).toBe("auth");
		const git = new GitHttp(nodeHttp, server.url("vault"), () => login, "the server", sleep);
		expect(await git.canPush()).toBe(true);
		expect((await git.refs()).head).toBe("main");
	});

	it("tells a missing branch from an empty repository", async () => {
		server.create("empty");
		const remote = new GitRemote(
			new GitHttp(nodeHttp, server.url("empty"), () => login, "the server", sleep),
			"main",
			async () => ({ name: "Jesse", email: "jesse@easy-git-sync.invalid" }),
		);
		expect(await remote.head()).toBeNull();
		const other = new GitRemote(
			new GitHttp(nodeHttp, server.url("vault"), () => login, "the server", sleep),
			"nope",
			async () => ({ name: "Jesse", email: "jesse@easy-git-sync.invalid" }),
		);
		await expect(other.head()).rejects.toThrow('The branch "nope" does not exist on the server.');
	});
});
