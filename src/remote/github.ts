import { decodeText, toBase64 } from "../lib/bytes";
import { isSuperseded } from "../lib/format";
import { gitBlobSha } from "../lib/githash";
import type {
	Change,
	KeptCommit,
	Remote,
	RemoteCommit,
	RemoteFile,
	RemoteTree,
} from "../sync/types";
import { type Http, type HttpResponse, lowerCaseHeaders, OfflineError } from "./http";
import { gunzip, untar } from "./tar";

const API = "https://api.github.com";

export type GitHubErrorKind = "auth" | "forbidden" | "not-found" | "rate-limit" | "other";

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly kind: GitHubErrorKind,
	) {
		super(message);
	}
}

export interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
}

export interface GitHubRepo {
	owner: string;
	name: string;
	fullName: string;
	private: boolean;
	defaultBranch: string;
	canPush: boolean;
	empty: boolean;
}

interface RequestOptions {
	body?: unknown;
	accept?: string;
	allow?: number[];
}

export class GitHubClient {
	constructor(
		private readonly http: Http,
		private readonly token: () => string | null,
		private readonly sleep: (ms: number) => Promise<void>,
	) {}

	async request(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse> {
		const token = this.token();
		if (!token) throw new GitHubError(401, "No GitHub token set.", "auth");
		const headers: Record<string, string> = {
			Accept: options.accept ?? "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			// GET responses are cacheable for 60 s, and a cached branch head means a stale parent
			"Cache-Control": "no-cache",
		};
		let body: string | undefined;
		if (options.body !== undefined) {
			body = JSON.stringify(options.body);
			headers["Content-Type"] = "application/json";
		}
		const url = path.startsWith("https://") ? path : `${API}${path}`;

		for (let attempt = 0; ; attempt++) {
			let response: HttpResponse;
			try {
				response = await this.http({
					url,
					method,
					headers,
					...(body === undefined ? {} : { body }),
				});
			} catch (error) {
				throw new OfflineError(error);
			}
			response = { ...response, headers: lowerCaseHeaders(response.headers) };
			const { status } = response;
			if (status < 400 || options.allow?.includes(status)) return response;

			const wait = retryDelay(response, attempt);
			if (wait !== null && attempt < 3) {
				await this.sleep(wait);
				continue;
			}
			throw toError(response);
		}
	}

	async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.request(method, path, body === undefined ? {} : { body });
		return parseJson<T>(response);
	}

	async user(): Promise<GitHubUser> {
		const user = await this.json<{ id: number; login: string; name: string | null }>(
			"GET",
			"/user",
		);
		return { id: user.id, login: user.login, name: user.name };
	}

	private account: { token: string | null; user: Promise<GitHubUser> } | null = null;

	cachedUser(): Promise<GitHubUser> {
		const token = this.token();
		if (this.account?.token === token) return this.account.user;
		const user = this.user();
		this.account = { token, user };
		user.catch(() => {
			if (this.account?.user === user) this.account = null;
		});
		return user;
	}

	async repos(): Promise<GitHubRepo[]> {
		const out: GitHubRepo[] = [];
		for (let page = 1; page <= 5; page++) {
			const batch = await this.json<RawRepo[]>(
				"GET",
				`/user/repos?per_page=100&sort=pushed&page=${page}`,
			);
			out.push(...batch.map(toRepo));
			if (batch.length < 100) break;
		}
		await pool(out, CONCURRENCY, async (repo) => {
			repo.canPush = await this.tokenCanPush(repo);
		});
		return out;
	}

	async repo(fullName: string): Promise<GitHubRepo> {
		const repo = toRepo(await this.json<RawRepo>("GET", `/repos/${fullName}`));
		repo.canPush = await this.tokenCanPush(repo);
		return repo;
	}

	private async tokenCanPush(repo: GitHubRepo): Promise<boolean> {
		if (!repo.canPush || !this.token()?.startsWith("github_pat_")) return repo.canPush;
		// permissions.push is the user's role, not the token's, so try a ref to the zero sha:
		// 403 without write access, 422 (or 409 on an empty repository) with it
		const response = await this.request("POST", `/repos/${repo.fullName}/git/refs`, {
			body: { ref: "refs/heads/easy-git-sync-write-check", sha: "0".repeat(40) },
			allow: [403, 404, 409, 422],
		});
		// a rate-limited 403 must not read as read-only
		if (response.status === 403 && toError(response).kind === "rate-limit") throw toError(response);
		return response.status === 409 || response.status === 422;
	}

	async branches(fullName: string, defaultBranch: string): Promise<string[]> {
		const names: string[] = [];
		for (let page = 1; page <= 3; page++) {
			const batch = await this.json<Array<{ name: string }>>(
				"GET",
				`/repos/${fullName}/branches?per_page=100&page=${page}`,
			);
			names.push(...batch.map((branch) => branch.name));
			if (batch.length < 100) break;
		}
		return [defaultBranch, ...names.filter((name) => name !== defaultBranch).sort()];
	}
}

interface RawRepo {
	name: string;
	full_name: string;
	owner: { login: string };
	private: boolean;
	default_branch: string | null;
	permissions?: { push?: boolean };
	size: number;
	pushed_at: string | null;
}

function toRepo(raw: RawRepo): GitHubRepo {
	return {
		owner: raw.owner.login,
		name: raw.name,
		fullName: raw.full_name,
		private: raw.private,
		defaultBranch: raw.default_branch || "main",
		canPush: raw.permissions?.push ?? false,
		empty: raw.size === 0 && raw.pushed_at === null,
	};
}

function parseJson<T>(response: HttpResponse): T {
	return JSON.parse(new TextDecoder().decode(response.body)) as T;
}

function retryDelay(response: HttpResponse, attempt: number): number | null {
	const { status, headers } = response;
	if (status >= 500) return 1000 * 2 ** attempt;
	if (status !== 403 && status !== 429) return null;
	const retryAfter = Number(headers["retry-after"]);
	if (Number.isFinite(retryAfter) && retryAfter > 0)
		return retryAfter <= 60 ? retryAfter * 1000 : null;
	if (headers["x-ratelimit-remaining"] === "0") {
		const reset = Number(headers["x-ratelimit-reset"]) * 1000 - Date.now();
		return reset > 0 && reset <= 60_000 ? reset + 1000 : null;
	}
	// a secondary rate limit can come without either header, and GitHub asks for a minute then
	if (/secondary rate limit/i.test(messageOf(response))) return 60_000;
	return null;
}

function messageOf(response: HttpResponse): string {
	try {
		return parseJson<{ message?: string }>(response).message ?? "";
	} catch {
		return "";
	}
}

function toError(response: HttpResponse): GitHubError {
	const { status, headers } = response;
	const message = messageOf(response) || `GitHub answered ${status}.`;
	if (status === 401) return new GitHubError(status, "GitHub did not accept the token.", "auth");
	if (
		(status === 403 || status === 429) &&
		(headers["x-ratelimit-remaining"] === "0" || /rate limit/i.test(message))
	) {
		return new GitHubError(
			status,
			"GitHub's rate limit was reached. Syncing resumes when it resets.",
			"rate-limit",
		);
	}
	if (status === 403) return new GitHubError(status, message, "forbidden");
	if (status === 404) return new GitHubError(status, message, "not-found");
	return new GitHubError(status, message, "other");
}

const ARCHIVE_THRESHOLD = 40;
// the archive is unpacked in memory, so about twice this is held at once
const ARCHIVE_MAX_BYTES = 100 * 1024 * 1024;
const CONCURRENCY = 6;
const TREE_BATCH = 200;

export class GitHubRemote implements Remote {
	private readonly treeSizes = new Map<string, { files: number; bytes: number }>();

	constructor(
		private readonly client: GitHubClient,
		readonly fullName: string,
		readonly branch: string,
		private readonly asAccount = true,
	) {}

	private get repoPath(): string {
		return `/repos/${this.fullName}`;
	}

	private async author(
		authored: Date | null = null,
	): Promise<{ author?: Identity; committer?: Identity }> {
		if (this.asAccount && authored === null) return {};
		const user = await this.client.cachedUser();
		const name = user.name || user.login;
		// .invalid is reserved (RFC 2606), so no account can ever verify the address
		const email = this.asAccount
			? `${user.id}+${user.login}@users.noreply.github.com`
			: `${user.login.toLowerCase()}@easy-git-sync.invalid`;
		// both fields, or the contents API fills the committer in as the account
		if (authored === null) return { author: { name, email }, committer: { name, email } };
		return {
			author: { name, email, date: isoDate(authored) },
			committer: { name, email, date: isoDate(new Date()) },
		};
	}

	async head(): Promise<string | null> {
		const response = await this.client.request(
			"GET",
			`${this.repoPath}/git/ref/heads/${encodePath(this.branch)}`,
			{ allow: [404, 409] },
		);
		if (response.status === 200) return parseJson<{ object: { sha: string } }>(response).object.sha;
		// 409 is an empty repository, and so is 404 on some, unless the branch is missing
		if (response.status === 409) return null;
		const branches = await this.client.json<unknown[]>(
			"GET",
			`${this.repoPath}/branches?per_page=1`,
		);
		if (branches.length === 0) return null;
		throw new GitHubError(
			404,
			`The branch "${this.branch}" does not exist on GitHub.`,
			"not-found",
		);
	}

	async readTree(commit: string): Promise<RemoteTree> {
		const root = await this.client.json<RawTree>(
			"GET",
			`${this.repoPath}/git/trees/${commit}?recursive=1`,
		);
		const files = new Map<string, RemoteFile>();
		if (!root.truncated) {
			addBlobs(files, root.tree, "");
			this.treeSizes.set(commit, measure(files));
			return { tree: root.sha, files };
		}
		// truncated past 100,000 entries or 7 MB
		const queue: Array<{ sha: string; prefix: string }> = [{ sha: root.sha, prefix: "" }];
		while (queue.length > 0) {
			const next = queue.shift();
			if (!next) break;
			const tree = await this.client.json<RawTree>("GET", `${this.repoPath}/git/trees/${next.sha}`);
			addBlobs(files, tree.tree, next.prefix);
			for (const entry of tree.tree) {
				if (entry.type === "tree")
					queue.push({ sha: entry.sha, prefix: `${next.prefix}${entry.path}/` });
			}
		}
		this.treeSizes.set(commit, measure(files));
		return { tree: root.sha, files };
	}

	async readBlobs(
		wanted: Array<{ sha: string; path: string }>,
		commit: string,
		progress?: (done: number, total: number) => void,
		each?: (sha: string, bytes: Uint8Array) => Promise<void>,
	): Promise<Map<string, Uint8Array>> {
		const out = new Map<string, Uint8Array>();
		const deliver = async (sha: string, bytes: Uint8Array) => {
			if (each) await each(sha, bytes);
			else out.set(sha, bytes);
		};
		const shas = new Map<string, string>();
		for (const { sha, path } of wanted) if (!shas.has(sha)) shas.set(sha, path);
		const delivered = new Set<string>();

		const size = this.treeSizes.get(commit);
		if (
			shas.size > ARCHIVE_THRESHOLD &&
			(size === undefined || (shas.size * 2 >= size.files && size.bytes <= ARCHIVE_MAX_BYTES))
		) {
			let archive: Map<string, Uint8Array> | null = null;
			try {
				const paths = new Set(shas.values());
				archive = await this.archive(commit, (path) => paths.has(path));
			} catch (error) {
				if (error instanceof GitHubError && error.kind === "auth") throw error;
			}
			// outside the try: a failed write must fail the sync, not restart the download per file
			for (const [sha, path] of archive ? shas : []) {
				const data = archive?.get(path);
				if (!data || (await gitBlobSha(data)) !== sha) continue;
				await deliver(sha, data);
				delivered.add(sha);
				progress?.(delivered.size, shas.size);
			}
		}

		const missing = [...shas.keys()].filter((sha) => !delivered.has(sha));
		let done = shas.size - missing.length;
		progress?.(done, shas.size);
		await pool(missing, CONCURRENCY, async (sha) => {
			const response = await this.client.request("GET", `${this.repoPath}/git/blobs/${sha}`, {
				accept: "application/vnd.github.raw+json",
				allow: [404],
			});
			if (response.status === 200) await deliver(sha, new Uint8Array(response.body));
			progress?.(++done, shas.size);
		});
		return out;
	}

	private async archive(
		commit: string,
		keep: (path: string) => boolean,
	): Promise<Map<string, Uint8Array>> {
		let response = await this.client.request("GET", `${this.repoPath}/tarball/${commit}`, {
			accept: "application/vnd.github+json",
			allow: [302],
		});
		// not every HTTP stack follows a redirect across hosts, and the target URL carries its own token
		const location = response.headers.location;
		if (response.status === 302 && location) {
			response = await this.client.request("GET", location, { accept: "*/*" });
		}
		return untar(await gunzip(new Uint8Array(response.body)), true, keep);
	}

	async commit(input: {
		parent: string;
		baseTree: string;
		changes: Change[];
		message: string;
		authored?: Date | null;
		kept?: KeptCommit | null;
	}): Promise<{ commit: string; tree: string } | "moved"> {
		const entries: RawTreeEntryInput[] = [];
		await pool(input.changes, CONCURRENCY, async (change) => {
			entries.push(await this.treeEntry(change));
		});
		entries.sort((a, b) => (a.path < b.path ? -1 : 1));

		// baseTree can be a commit sha (git/trees/<commit> answers with it), which base_tree
		// accepts but a commit's tree does not
		const tree =
			entries.length > 0
				? await this.buildTree(input.baseTree, entries)
				: await this.treeOf(input.parent);
		const parents = [input.parent];
		if (input.kept && input.kept.files.length > 0) parents.push(await this.keptCommit(input.kept));
		const commit = await this.client.json<{ sha: string }>("POST", `${this.repoPath}/git/commits`, {
			message: input.message,
			tree,
			parents,
			...(await this.author(input.authored ?? null)),
		});
		const updated = await this.client.request(
			"PATCH",
			`${this.repoPath}/git/refs/heads/${encodePath(this.branch)}`,
			{ body: { sha: commit.sha, force: false }, allow: [409, 422] },
		);
		if (updated.status !== 200) return "moved";
		return { commit: commit.sha, tree };
	}

	private async buildTree(baseTree: string | null, entries: RawTreeEntryInput[]): Promise<string> {
		let tree = baseTree;
		for (let i = 0; i < entries.length || tree === null; i += TREE_BATCH) {
			const created = await this.client.json<{ sha: string }>(
				"POST",
				`${this.repoPath}/git/trees`,
				{
					...(tree === null ? {} : { base_tree: tree }),
					tree: entries.slice(i, i + TREE_BATCH),
				},
			);
			tree = created.sha;
		}
		return tree;
	}

	private async keptCommit(kept: KeptCommit): Promise<string> {
		const entries = kept.files.map(({ path, mode, sha }) => ({
			path,
			mode,
			type: "blob" as const,
			sha,
		}));
		let parent = kept.parent;
		// a rewritten branch can have lost the parent, then the versions get a root commit
		const baseTree = parent === null ? null : await this.treeOf(parent, true);
		if (baseTree === null) parent = null;
		const tree = await this.buildTree(baseTree, entries);
		const commit = await this.client.json<{ sha: string }>("POST", `${this.repoPath}/git/commits`, {
			message: kept.message,
			tree,
			parents: parent === null ? [] : [parent],
			...(await this.author(kept.authored)),
		});
		return commit.sha;
	}

	private async treeOf(commit: string): Promise<string>;
	private async treeOf(commit: string, missingOk: true): Promise<string | null>;
	private async treeOf(commit: string, missingOk = false): Promise<string | null> {
		const response = await this.client.request("GET", `${this.repoPath}/git/commits/${commit}`, {
			allow: missingOk ? [404, 422] : [],
		});
		if (response.status !== 200) return null;
		return parseJson<{ tree: { sha: string } }>(response).tree.sha;
	}

	async storeBlob(content: Uint8Array): Promise<string> {
		const blob = await this.client.json<{ sha: string }>("POST", `${this.repoPath}/git/blobs`, {
			content: toBase64(content),
			encoding: "base64",
		});
		return blob.sha;
	}

	private async treeEntry(change: Change): Promise<RawTreeEntryInput> {
		const base = { path: change.path, mode: change.mode, type: "blob" as const };
		if (change.read === null) return { ...base, sha: null };
		const content = await change.read();
		// inline text keeps clear of the 80/min content-creation limit; decodeText is null
		// unless re-encoding gives back the exact bytes
		const text = decodeText(content);
		if (text !== null) return { ...base, content: text };
		const blob = await this.client.json<{ sha: string }>("POST", `${this.repoPath}/git/blobs`, {
			content: toBase64(content),
			encoding: "base64",
		});
		return { ...base, sha: blob.sha };
	}

	async initialize(path: string, content: Uint8Array, message: string): Promise<void> {
		await this.client.json("PUT", `${this.repoPath}/contents/${encodePath(path)}`, {
			message,
			content: toBase64(content),
			branch: this.branch,
			...(await this.author()),
		});
	}

	async commitsSince(base: string | null, head: string): Promise<RemoteCommit[]> {
		if (base === null || base === head) {
			const list = await this.client.json<RawCommit[]>(
				"GET",
				`${this.repoPath}/commits?sha=${head}&per_page=1`,
			);
			return list.map(toCommit);
		}
		const compare = await this.client.json<{ commits: RawCommit[] }>(
			"GET",
			`${this.repoPath}/compare/${base}...${head}`,
		);
		return compare.commits.map(toCommit).reverse();
	}

	async lastChange(path: string, head: string): Promise<RemoteCommit | null> {
		const list = await this.client.json<RawCommit[]>(
			"GET",
			`${this.repoPath}/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=5`,
		);
		return list.map(toCommit).find((commit) => !isSuperseded(commit.message)) ?? null;
	}

	async fileHistory(path: string, head: string, max: number): Promise<string[]> {
		const commits = await this.client.json<RawCommit[]>(
			"GET",
			`${this.repoPath}/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=${max}`,
		);
		const shas: string[] = [];
		for (const commit of commits) {
			const response = await this.client.request(
				"GET",
				`${this.repoPath}/contents/${encodePath(path)}?ref=${commit.sha}`,
				{ allow: [404] },
			);
			if (response.status !== 200) continue;
			const file = parseJson<{ type?: string; sha?: string }>(response);
			if (file.type === "file" && file.sha && !shas.includes(file.sha)) shas.push(file.sha);
		}
		return shas;
	}
}

interface Identity {
	name: string;
	email: string;
	date?: string;
}

function isoDate(date: Date): string {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface RawTree {
	sha: string;
	truncated: boolean;
	tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>;
}

type RawTreeEntryInput =
	| { path: string; mode: string; type: "blob"; sha: string | null }
	| { path: string; mode: string; type: "blob"; content: string };

interface RawCommit {
	sha: string;
	parents?: Array<{ sha: string }>;
	commit: { message: string; committer: { date: string } | null; author: { date: string } | null };
}

function toCommit(raw: RawCommit): RemoteCommit {
	const date = raw.commit.committer?.date ?? raw.commit.author?.date;
	const authored = raw.commit.author?.date;
	return {
		sha: raw.sha,
		message: raw.commit.message,
		date: date ? new Date(date) : null,
		authored: authored ? new Date(authored) : null,
		parent: raw.parents?.[0]?.sha ?? null,
	};
}

// symlinks (120000) and submodules (160000) have no place in a vault
function addBlobs(files: Map<string, RemoteFile>, entries: RawTree["tree"], prefix: string): void {
	for (const entry of entries) {
		if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
			files.set(prefix + entry.path, {
				sha: entry.sha,
				mode: entry.mode,
				...(entry.size === undefined ? {} : { size: entry.size }),
			});
		}
	}
}

function measure(files: Map<string, RemoteFile>): { files: number; bytes: number } {
	let bytes = 0;
	for (const file of files.values()) bytes += file.size ?? 0;
	return { files: files.size, bytes };
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			await run(items[next++]);
		}
	});
	await Promise.all(workers);
}
