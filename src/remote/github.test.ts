import { describe, expect, it } from "vitest";
import { GitHubClient } from "./github";
import type { Http, HttpResponse } from "./http";

const API = "https://api.github.com";

function respond(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): HttpResponse {
	return { status, headers, body: new TextEncoder().encode(JSON.stringify(body)).buffer };
}

function rawRepo(fullName: string, extra: Record<string, unknown> = {}) {
	const [owner, name] = fullName.split("/");
	return {
		name,
		full_name: fullName,
		owner: { login: owner },
		private: true,
		default_branch: "main",
		permissions: { push: true },
		size: 10,
		pushed_at: "2026-01-01T00:00:00Z",
		...extra,
	};
}

// GitHub's answer for a repository it has blocked
const blocked = {
	message: "Repository access blocked",
	block: {
		reason: "dmca",
		created_at: "2022-01-01T00:00:00Z",
		html_url: "https://github.com/github/dmca",
	},
};

const writable = () => respond(422, { message: "Reference update failed" });

function account(repos: ReturnType<typeof rawRepo>[], checks: Record<string, () => HttpResponse>) {
	const requested: string[] = [];
	const http: Http = async (request) => {
		const url = request.url.replace(API, "");
		requested.push(`${request.method} ${url}`);
		if (request.method === "GET" && url.startsWith("/user/repos?")) return respond(200, repos);
		const check = /^\/repos\/(.+)\/git\/refs$/.exec(url);
		if (request.method === "POST" && check) {
			const answer = checks[check[1]];
			if (answer) return answer();
		}
		throw new Error(`unexpected ${request.method} ${url}`);
	};
	const client = new GitHubClient(
		http,
		() => "github_pat_test",
		async () => {},
	);
	return { client, requested };
}

describe("GitHubClient.repos", () => {
	it("skips the write check for a disabled repository", async () => {
		const { client, requested } = account(
			[rawRepo("me/notes"), rawRepo("me/taken-down", { disabled: true })],
			{ "me/notes": writable },
		);
		const repos = await client.repos();
		expect(repos.map((repo) => [repo.fullName, repo.canPush])).toEqual([
			["me/notes", true],
			["me/taken-down", false],
		]);
		expect(requested).not.toContain("POST /repos/me/taken-down/git/refs");
	});

	it("lists the rest when one repository's write check is blocked", async () => {
		const { client } = account([rawRepo("me/notes"), rawRepo("me/blocked")], {
			"me/notes": writable,
			"me/blocked": () => respond(451, blocked),
		});
		const repos = await client.repos();
		expect(repos.map((repo) => [repo.fullName, repo.canPush])).toEqual([
			["me/notes", true],
			["me/blocked", false],
		]);
	});

	it("fails when GitHub rejects the token", async () => {
		const { client } = account([rawRepo("me/notes")], {
			"me/notes": () => respond(401, { message: "Bad credentials" }),
		});
		await expect(client.repos()).rejects.toMatchObject({ kind: "auth" });
	});

	it("fails when the rate limit is reached", async () => {
		const reset = String(Math.floor(Date.now() / 1000) + 3600);
		const { client } = account([rawRepo("me/notes")], {
			"me/notes": () =>
				respond(
					403,
					{ message: "API rate limit exceeded" },
					{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
				),
		});
		await expect(client.repos()).rejects.toMatchObject({ kind: "rate-limit" });
	});
});
