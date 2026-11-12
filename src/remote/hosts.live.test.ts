import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ConflictStrategy, sync } from "../sync/engine";
import { MemoryFs } from "../sync/fixtures";
import { emptyState, type Remote, type SyncState } from "../sync/types";
import { nodeHttp } from "./fixtures";
import { type Connection, createHost, type Host } from "./hosts";
import { basicAuth } from "./http";

// runs against real servers, each with a scratch repository it creates and deletes:
//   EASY_GIT_GITLAB_TOKEN (scope api) and EASY_GIT_GITLAB_PLUGIN_TOKEN (read_api, write_repository)
//   EASY_GIT_BITBUCKET_TOKEN (can create and delete repositories) and EASY_GIT_BITBUCKET_PLUGIN_TOKEN
//   EASY_GIT_FORGEJO=<url>|<token>,... for Forgejo and Gitea servers (tools/hosts/start.sh)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const run = Date.now().toString(36);

interface Target {
	label: string;
	connection: Connection;
	token: string;
	create(): Promise<string>;
	remove(fullName: string): Promise<void>;
	email(host: Host): Promise<string>;
}

async function call(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`${init.method} ${url}: ${response.status} ${text}`);
	return text ? JSON.parse(text) : null;
}

const targets: Target[] = [];

const gitlabSetup = process.env.EASY_GIT_GITLAB_TOKEN;
const gitlabPlugin = process.env.EASY_GIT_GITLAB_PLUGIN_TOKEN;
if (gitlabSetup && gitlabPlugin) {
	const headers = { "PRIVATE-TOKEN": gitlabSetup, "Content-Type": "application/json" };
	targets.push({
		label: "GitLab",
		connection: { provider: "gitlab", server: "https://gitlab.com", username: "" },
		token: gitlabPlugin,
		async create() {
			const project = (await call("https://gitlab.com/api/v4/projects", {
				method: "POST",
				headers,
				body: JSON.stringify({ name: `egs-live-${run}`, visibility: "private" }),
			})) as { path_with_namespace: string };
			return project.path_with_namespace;
		},
		async remove(fullName) {
			await call(`https://gitlab.com/api/v4/projects/${encodeURIComponent(fullName)}`, {
				method: "DELETE",
				headers,
			});
		},
		async email(host) {
			const user = (await call("https://gitlab.com/api/v4/user", { headers })) as { id: number };
			return `${user.id}-${(await host.account()).login}@users.noreply.gitlab.com`;
		},
	});
}

const bitbucketSetup = process.env.EASY_GIT_BITBUCKET_TOKEN;
const bitbucketPlugin = process.env.EASY_GIT_BITBUCKET_PLUGIN_TOKEN;
if (bitbucketSetup && bitbucketPlugin) {
	const headers = { Authorization: `Bearer ${bitbucketSetup}`, "Content-Type": "application/json" };
	targets.push({
		label: "Bitbucket",
		connection: { provider: "bitbucket", server: "", username: "" },
		token: bitbucketPlugin,
		async create() {
			const spaces = (await call("https://api.bitbucket.org/2.0/user/workspaces", { headers })) as {
				values: Array<{ workspace: { slug: string } }>;
			};
			const slug = spaces.values[0]?.workspace.slug ?? "";
			const fullName = `${slug}/egs-live-${run}`;
			await call(`https://api.bitbucket.org/2.0/repositories/${fullName}`, {
				method: "POST",
				headers,
				body: JSON.stringify({ scm: "git", is_private: true }),
			});
			return fullName;
		},
		async remove(fullName) {
			await call(`https://api.bitbucket.org/2.0/repositories/${fullName}`, {
				method: "DELETE",
				headers,
			});
		},
		async email(host) {
			return `${(await host.account()).login.toLowerCase()}@easy-git-sync.invalid`;
		},
	});
}

for (const entry of (process.env.EASY_GIT_FORGEJO ?? "").split(",").filter(Boolean)) {
	const [server = "", token = ""] = entry.split("|");
	const headers = { Authorization: `token ${token}`, "Content-Type": "application/json" };
	targets.push({
		label: `Forgejo / Gitea at ${server}`,
		connection: { provider: "forgejo", server, username: "" },
		token,
		async create() {
			const repo = (await call(`${server}/api/v1/user/repos`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: `egs-live-${run}`, private: true }),
			})) as { full_name: string };
			return repo.full_name;
		},
		async remove(fullName) {
			await call(`${server}/api/v1/repos/${fullName}`, { method: "DELETE", headers });
		},
		async email(host) {
			return `${(await host.account()).login.toLowerCase()}@noreply.${new URL(server).host}`;
		},
	});
}

class LiveDevice {
	readonly fs = new MemoryFs();
	state: SyncState = emptyState("live");
	constructor(
		readonly name: string,
		readonly remote: Remote,
		readonly remoteName: string,
	) {}
	async sync(conflicts: ConflictStrategy = "keep-both") {
		const result = await sync(this.state, {
			fs: this.fs,
			remote: this.remote,
			device: this.name,
			stateFile: ".obsidian/plugins/easy-git-sync/state.json",
			configDir: ".obsidian",
			allowMassDelete: true,
			conflicts,
			remoteName: this.remoteName,
			saveState: async (state) => {
				this.state = state;
			},
		});
		this.state = result.state;
		return result.report;
	}
}

describe.each(targets)("$label, live", { timeout: 120_000 }, (target) => {
	const host = createHost(target.connection, {
		http: nodeHttp,
		token: () => target.token,
		sleep,
	});
	let fullName = "";
	const clone = mkdtempSync(join(tmpdir(), "easy-git-live-"));

	beforeAll(async () => {
		fullName = await target.create();
	}, 60_000);
	afterAll(async () => {
		rmSync(clone, { recursive: true, force: true });
		if (fullName) await target.remove(fullName);
	}, 60_000);

	// real git fetches what the plugin pushed and checks every object
	function gitLog(format: string): string[] {
		const login = host.gitLogin();
		const header = login
			? `http.extraHeader=Authorization: ${basicAuth(login.username, login.password)}`
			: "";
		execFileSync("git", ["init", "-q", "--bare", clone]);
		execFileSync("git", [
			"-C",
			clone,
			"-c",
			header,
			"-c",
			"transfer.fsckObjects=true",
			"-c",
			"credential.helper=",
			"fetch",
			"-q",
			host.cloneUrl(fullName),
			"+refs/heads/*:refs/remotes/origin/*",
		]);
		return execFileSync("git", ["-C", clone, "log", `--format=${format}`, "origin/main"])
			.toString()
			.trim()
			.split("\n");
	}

	it("sees the account, the new repository and its write access", async () => {
		const account = await host.account();
		expect(account.login).toBeTruthy();
		const repo = await host.repo(fullName);
		expect(repo.canPush).toBe(true);
		expect(repo.empty).toBe(true);
		const listed = await host.repos();
		expect(listed.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase())?.canPush).toBe(
			true,
		);
		expect(await host.tokenUrl()).toMatch(/^https:\/\/|^http:\/\/localhost/);
		const expiry = await host.tokenExpiry();
		if (target.connection.provider === "gitlab") expect(expiry).toBeInstanceOf(Date);
		else expect(expiry).toBeNull();
	});

	it("syncs two devices, merges, and keeps a losing version as a second parent", async () => {
		const mac = new LiveDevice("MacBook", host.remote(fullName, "main", true, null), host.name);
		const phone = new LiveDevice("iPhone", host.remote(fullName, "main", true, null), host.name);
		mac.fs.set("note.md", "one\ntwo\nthree\nfour\nfive\n");
		mac.fs.set("attachments/pixel.png", new Uint8Array([137, 80, 78, 71, 0, 1, 2]));
		const first = await mac.sync();
		expect(first.initialized).toBe(true);
		await phone.sync();
		expect(phone.fs.get("note.md")).toBe("one\ntwo\nthree\nfour\nfive\n");

		mac.fs.set("note.md", "ONE\ntwo\nthree\nfour\nfive\n");
		phone.fs.set("note.md", "one\ntwo\nthree\nfour\nFIVE\n");
		await mac.sync();
		await phone.sync();
		expect(phone.fs.get("note.md")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");

		mac.fs.set("note.md", "ONE\nmac\nthree\nfour\nFIVE\n", new Date(2026, 9, 1, 10));
		phone.fs.set("note.md", "ONE\nphone\nthree\nfour\nFIVE\n", new Date(2026, 9, 1, 9));
		await mac.sync();
		const report = await phone.sync("newest");
		expect(report.newer.map((n) => n.path)).toEqual(["note.md"]);

		const parents = gitLog("%P")[0]?.split(" ") ?? [];
		expect(parents).toHaveLength(2);
		expect(gitLog("%ae")[0]).toBe(await target.email(host));
		expect((await host.branches(fullName, "main"))[0]).toBe("main");
	});
});
