import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Http, HttpRequest } from "./http";

export interface GitServerOptions {
	// passes the client's Git-Protocol header on, as a server set up for protocol v2 does
	v2: boolean;
	// lets a fetch leave files out and ask for any object, as GitHub, GitLab and Forgejo do
	partial: boolean;
	login?: { username: string; password: string };
}

// a real `git http-backend` behind a local HTTP server, so the git client is tested against
// git itself without a network
export class GitServer {
	readonly root = mkdtempSync(join(tmpdir(), "easy-git-server-"));
	private server: Server | null = null;
	private port = 0;
	readonly requests: Array<{ method: string; path: string; body: string }> = [];

	constructor(private readonly options: GitServerOptions) {}

	async start(): Promise<void> {
		const server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const body = Buffer.concat(chunks);
				const url = new URL(req.url ?? "/", "http://localhost");
				this.requests.push({
					method: req.method ?? "GET",
					path: url.pathname + url.search,
					body: body.toString("latin1"),
				});
				const login = this.options.login;
				if (login) {
					const expected = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString("base64")}`;
					if (req.headers.authorization !== expected) {
						res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
						res.end("Unauthorized");
						return;
					}
				}
				const protocol = req.headers["git-protocol"];
				const child = spawn("git", ["http-backend"], {
					env: {
						...process.env,
						GIT_PROJECT_ROOT: this.root,
						GIT_HTTP_EXPORT_ALL: "1",
						REQUEST_METHOD: req.method ?? "GET",
						PATH_INFO: url.pathname,
						QUERY_STRING: url.search.slice(1),
						CONTENT_TYPE: req.headers["content-type"] ?? "",
						CONTENT_LENGTH: String(body.length),
						REMOTE_USER: "tester",
						REMOTE_ADDR: "127.0.0.1",
						...(this.options.v2 && typeof protocol === "string" ? { GIT_PROTOCOL: protocol } : {}),
					},
				});
				const out: Buffer[] = [];
				child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
				child.stdin.end(body);
				child.on("close", () => {
					const all = Buffer.concat(out);
					let split = all.indexOf("\r\n\r\n");
					let skip = 4;
					if (split < 0) {
						split = all.indexOf("\n\n");
						skip = 2;
					}
					const headers: Record<string, string> = {};
					let status = 200;
					for (const line of all.subarray(0, split).toString().split(/\r?\n/)) {
						const colon = line.indexOf(":");
						const key = line.slice(0, colon).trim();
						const value = line.slice(colon + 1).trim();
						if (key.toLowerCase() === "status") status = Number.parseInt(value, 10);
						else if (key) headers[key] = value;
					}
					res.writeHead(status, headers);
					res.end(all.subarray(split + skip));
				});
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		this.server = server;
		this.port = (server.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server?.close(() => resolve()));
		rmSync(this.root, { recursive: true, force: true });
	}

	url(repo: string): string {
		return `http://127.0.0.1:${this.port}/${repo}.git`;
	}

	create(repo: string): void {
		const dir = join(this.root, `${repo}.git`);
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
		this.git(repo, ["config", "http.receivepack", "true"]);
		if (this.options.partial) {
			this.git(repo, ["config", "uploadpack.allowFilter", "true"]);
			this.git(repo, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
		}
	}

	git(repo: string, args: string[]): string {
		return execFileSync("git", ["--git-dir", join(this.root, `${repo}.git`), ...args], {
			maxBuffer: 64 * 1024 * 1024,
		}).toString();
	}
}

export const nodeHttp: Http = async (request: HttpRequest) => {
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
