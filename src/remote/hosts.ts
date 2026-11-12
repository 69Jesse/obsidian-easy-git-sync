import { capitalize } from "../lib/format";
import type { Remote } from "../sync/types";
import { type GitAuth, GitHttp } from "./git/smart";
import { type BlobStash, GitRemote, type Identity } from "./git-remote";
import { GitHubClient, GitHubRemote } from "./github";
import { type Http, type HttpResponse, lowerCaseHeaders, OfflineError, RemoteError } from "./http";

export type ProviderId = "github" | "gitlab" | "forgejo" | "bitbucket" | "other";

export const PROVIDERS: Record<ProviderId, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
	forgejo: "Forgejo / Gitea",
	other: "Other git server",
};

export const DEFAULT_SERVERS: Partial<Record<ProviderId, string>> = {
	gitlab: "https://gitlab.com",
	forgejo: "https://codeberg.org",
};

export interface Connection {
	provider: ProviderId;
	// the server for GitLab and Forgejo; for another git server, the repository's URL
	server: string;
	// another git server only: the login that goes with the password
	username: string;
}

export interface Account {
	login: string;
	name: string;
}

export interface RepoInfo {
	fullName: string;
	private: boolean;
	defaultBranch: string;
	canPush: boolean;
	empty: boolean;
}

export interface Host {
	readonly id: ProviderId;
	// how texts name it: GitLab, Codeberg, or "the server" when it has no name of its own
	readonly name: string;
	// whether commits can show on the account, through an address only that account owns
	readonly linksAccounts: boolean;
	account(): Promise<Account>;
	repos(): Promise<RepoInfo[]>;
	repo(fullName: string): Promise<RepoInfo>;
	branches(fullName: string, defaultBranch: string): Promise<string[]>;
	tokenExpiry(): Promise<Date | null>;
	tokenUrl(): Promise<string | null>;
	remote(fullName: string, branch: string, asAccount: boolean, stash: BlobStash | null): Remote;
	cloneUrl(fullName: string): string;
	gitLogin(): GitAuth | null;
	fileUrl(fullName: string, branch: string, path: string): string | null;
}

export interface HostDeps {
	http: Http;
	token: () => string | null;
	sleep: (ms: number) => Promise<void>;
}

const TOKEN_NAME = "Obsidian Easy Git Sync";
const TOKEN_DESCRIPTION = "Lets Obsidian sync this vault with its repository.";

export function normalizeServer(server: string): string {
	const trimmed = server.trim().replace(/\/+$/, "");
	return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

export function createHost(connection: Connection, deps: HostDeps): Host {
	switch (connection.provider) {
		case "github":
			return new GitHubHost(deps);
		case "gitlab":
			return new GitLabHost(connection, deps);
		case "forgejo":
			return new ForgejoHost(connection, deps);
		case "bitbucket":
			return new BitbucketHost(deps);
		case "other":
			return new OtherHost(connection, deps);
	}
}

// what all hosts but GitHub share: an account behind a JSON API and git over HTTPS for the rest
abstract class GitHost implements Host {
	abstract readonly id: ProviderId;
	abstract readonly name: string;
	abstract readonly linksAccounts: boolean;
	private cached: { token: string | null; account: Promise<Account> } | null = null;

	constructor(protected readonly deps: HostDeps) {}

	protected abstract fetchAccount(): Promise<Account>;
	abstract repos(): Promise<RepoInfo[]>;
	abstract repo(fullName: string): Promise<RepoInfo>;
	abstract cloneUrl(fullName: string): string;
	abstract gitLogin(): GitAuth | null;
	abstract fileUrl(fullName: string, branch: string, path: string): string | null;
	abstract tokenUrl(): Promise<string | null>;

	// for an address on commits when they are linked to the account
	protected linkedEmail(_account: Account): string | null {
		return null;
	}

	async tokenExpiry(): Promise<Date | null> {
		return null;
	}

	account(): Promise<Account> {
		const token = this.deps.token();
		if (this.cached?.token === token) return this.cached.account;
		const account = this.fetchAccount();
		this.cached = { token, account };
		account.catch(() => {
			if (this.cached?.account === account) this.cached = null;
		});
		return account;
	}

	protected git(fullName: string): GitHttp {
		return new GitHttp(
			this.deps.http,
			this.cloneUrl(fullName),
			() => this.gitLogin(),
			this.name,
			this.deps.sleep,
		);
	}

	async branches(fullName: string, defaultBranch: string): Promise<string[]> {
		const refs = await this.git(fullName).refs();
		const names = [...refs.heads.keys()];
		const first = refs.head ?? defaultBranch;
		return [first, ...names.filter((name) => name !== first).sort()];
	}

	protected async check(
		fullName: string,
	): Promise<{ canPush: boolean; defaultBranch: string | null; empty: boolean }> {
		const git = this.git(fullName);
		const refs = await git.refs();
		return {
			canPush: await git.canPush(),
			defaultBranch: refs.head,
			empty: refs.heads.size === 0,
		};
	}

	remote(fullName: string, branch: string, asAccount: boolean, stash: BlobStash | null): Remote {
		const identity = async (): Promise<Identity> => {
			const account = await this.account();
			const linked = asAccount && this.linksAccounts ? this.linkedEmail(account) : null;
			// .invalid is reserved (RFC 2606), so no account can ever verify the address
			return {
				name: account.name || account.login,
				email: linked ?? `${account.login.toLowerCase()}@easy-git-sync.invalid`,
			};
		};
		return new GitRemote(this.git(fullName), branch, identity, stash);
	}

	protected async api<T>(
		url: string,
		headers: Record<string, string>,
		allow: number[] = [],
	): Promise<{ status: number; body: T | null; headers: Record<string, string> }> {
		for (let attempt = 0; ; attempt++) {
			let response: HttpResponse;
			try {
				response = await this.deps.http({
					url,
					method: "GET",
					headers: { Accept: "application/json", "Cache-Control": "no-cache", ...headers },
				});
			} catch (error) {
				throw new OfflineError(error, this.name);
			}
			response = { ...response, headers: lowerCaseHeaders(response.headers) };
			const { status } = response;
			if (status < 400 || allow.includes(status)) {
				const text = new TextDecoder().decode(response.body);
				return {
					status,
					body: status < 400 && text ? (JSON.parse(text) as T) : null,
					headers: response.headers,
				};
			}
			if (status >= 500 && attempt < 3) {
				await this.deps.sleep(1000 * 2 ** attempt);
				continue;
			}
			if (status === 401)
				throw new RemoteError(status, `${capitalize(this.name)} did not accept the token.`, "auth");
			if (status === 403)
				throw new RemoteError(
					status,
					`${capitalize(this.name)} refused: the token lacks a permission.`,
					"forbidden",
				);
			if (status === 404) throw new RemoteError(status, `Not found on ${this.name}.`, "not-found");
			if (status === 429)
				throw new RemoteError(
					status,
					`${capitalize(this.name)}'s rate limit was reached.`,
					"rate-limit",
				);
			throw new RemoteError(status, `${capitalize(this.name)} answered ${status}.`, "other");
		}
	}
}

class GitHubHost implements Host {
	readonly id = "github";
	readonly name = "GitHub";
	readonly linksAccounts = true;
	readonly client: GitHubClient;

	constructor(private readonly deps: HostDeps) {
		this.client = new GitHubClient(deps.http, deps.token, deps.sleep);
	}

	async account(): Promise<Account> {
		const user = await this.client.cachedUser();
		return { login: user.login, name: user.name ?? user.login };
	}

	repos(): Promise<RepoInfo[]> {
		return this.client.repos();
	}

	repo(fullName: string): Promise<RepoInfo> {
		return this.client.repo(fullName);
	}

	branches(fullName: string, defaultBranch: string): Promise<string[]> {
		return this.client.branches(fullName, defaultBranch);
	}

	tokenExpiry(): Promise<Date | null> {
		return this.client.tokenExpiry();
	}

	async tokenUrl(): Promise<string> {
		return `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
			name: TOKEN_NAME,
			description: TOKEN_DESCRIPTION,
			contents: "write",
			expires_in: "none",
		}).toString()}`;
	}

	remote(fullName: string, branch: string, asAccount: boolean): Remote {
		return new GitHubRemote(this.client, fullName, branch, asAccount);
	}

	cloneUrl(fullName: string): string {
		return `https://github.com/${fullName}.git`;
	}

	gitLogin(): GitAuth | null {
		const token = this.deps.token();
		return token ? { username: "x-access-token", password: token } : null;
	}

	fileUrl(fullName: string, branch: string, path: string): string {
		return `https://github.com/${fullName}/blob/${encodeURIComponent(branch)}/${encodePath(path)}`;
	}
}

interface GitLabProject {
	path_with_namespace: string;
	default_branch: string | null;
	visibility: string;
	empty_repo?: boolean;
}

class GitLabHost extends GitHost {
	readonly id = "gitlab";
	readonly name = "GitLab";
	readonly linksAccounts = true;
	private readonly server: string;
	private userId = 0;

	constructor(connection: Connection, deps: HostDeps) {
		super(deps);
		this.server = normalizeServer(connection.server || DEFAULT_SERVERS.gitlab || "");
	}

	private get headers(): Record<string, string> {
		const token = this.deps.token();
		if (!token) throw new RemoteError(401, "No GitLab token set.", "auth");
		return { "PRIVATE-TOKEN": token };
	}

	private async get<T>(path: string): Promise<T> {
		const { body } = await this.api<T>(`${this.server}/api/v4${path}`, this.headers);
		return body as T;
	}

	protected async fetchAccount(): Promise<Account> {
		const user = await this.get<{ id: number; username: string; name: string }>("/user");
		this.userId = user.id;
		return { login: user.username, name: user.name };
	}

	// the private commit address GitLab gives every account, linked to it alone
	protected override linkedEmail(account: Account): string {
		return `${this.userId}-${account.login}@users.noreply.gitlab.com`;
	}

	private async scopes(): Promise<string[] | null> {
		try {
			return (await this.get<{ scopes?: string[] }>("/personal_access_tokens/self")).scopes ?? null;
		} catch {
			return null;
		}
	}

	private toRepo(project: GitLabProject, canPush: boolean): RepoInfo {
		return {
			fullName: project.path_with_namespace,
			private: project.visibility !== "public",
			defaultBranch: project.default_branch ?? "main",
			canPush,
			// an empty project already names its default branch
			empty: project.empty_repo ?? project.default_branch === null,
		};
	}

	async repos(): Promise<RepoInfo[]> {
		const scopes = await this.scopes();
		const writes = scopes === null || scopes.includes("write_repository") || scopes.includes("api");
		const out: RepoInfo[] = [];
		for (let page = 1; page <= 5; page++) {
			// developer and up: the roles that can push
			const batch = await this.get<GitLabProject[]>(
				`/projects?membership=true&min_access_level=30&order_by=last_activity_at&per_page=100&page=${page}`,
			);
			out.push(...batch.map((project) => this.toRepo(project, writes)));
			if (batch.length < 100) break;
		}
		return out;
	}

	async repo(fullName: string): Promise<RepoInfo> {
		const project = await this.get<GitLabProject>(`/projects/${encodeURIComponent(fullName)}`);
		const { canPush } = await this.check(fullName);
		return this.toRepo(project, canPush);
	}

	override async tokenExpiry(): Promise<Date | null> {
		const self = await this.get<{ expires_at: string | null }>("/personal_access_tokens/self");
		return self.expires_at ? new Date(`${self.expires_at}T00:00:00Z`) : null;
	}

	// only the classic form takes values from the address; read_api lists the projects
	async tokenUrl(): Promise<string> {
		return `${this.server}/-/user_settings/personal_access_tokens?${new URLSearchParams({
			name: TOKEN_NAME,
			description: TOKEN_DESCRIPTION,
			scopes: "read_api,write_repository",
		}).toString()}`;
	}

	cloneUrl(fullName: string): string {
		return `${this.server}/${fullName}.git`;
	}

	gitLogin(): GitAuth | null {
		const token = this.deps.token();
		return token ? { username: "oauth2", password: token } : null;
	}

	fileUrl(fullName: string, branch: string, path: string): string {
		return `${this.server}/${fullName}/-/blob/${encodeURIComponent(branch)}/${encodePath(path)}`;
	}
}

interface ForgejoRepo {
	full_name: string;
	private: boolean;
	default_branch: string;
	empty: boolean;
	permissions?: { push?: boolean };
}

class ForgejoHost extends GitHost {
	readonly id = "forgejo";
	readonly name: string;
	readonly linksAccounts = true;
	private readonly server: string;
	private login: string | null = null;

	constructor(connection: Connection, deps: HostDeps) {
		super(deps);
		this.server = normalizeServer(connection.server || DEFAULT_SERVERS.forgejo || "");
		this.name = hostOf(this.server) === "codeberg.org" ? "Codeberg" : "the server";
	}

	private get headers(): Record<string, string> {
		const token = this.deps.token();
		if (!token) throw new RemoteError(401, `No token set for ${this.name}.`, "auth");
		return { Authorization: `token ${token}` };
	}

	private async get<T>(path: string): Promise<T> {
		const { body } = await this.api<T>(`${this.server}/api/v1${path}`, this.headers);
		return body as T;
	}

	protected async fetchAccount(): Promise<Account> {
		const user = await this.get<{ login: string; full_name: string }>("/user");
		this.login = user.login;
		return { login: user.login, name: user.full_name || user.login };
	}

	// the placeholder address Forgejo and Gitea give an account that hides its own
	protected override linkedEmail(account: Account): string {
		// the domain without a port, as Forgejo and Gitea form it
		return `${account.login.toLowerCase()}@noreply.${hostnameOf(this.server)}`;
	}

	private toRepo(repo: ForgejoRepo): RepoInfo {
		return {
			fullName: repo.full_name,
			private: repo.private,
			defaultBranch: repo.default_branch || "main",
			canPush: repo.permissions?.push ?? false,
			empty: repo.empty,
		};
	}

	async repos(): Promise<RepoInfo[]> {
		const out: RepoInfo[] = [];
		for (let page = 1; page <= 10; page++) {
			const batch = await this.get<ForgejoRepo[]>(`/user/repos?limit=50&page=${page}`);
			out.push(...batch.map((repo) => this.toRepo(repo)));
			if (batch.length < 50) break;
		}
		return out;
	}

	async repo(fullName: string): Promise<RepoInfo> {
		const repo = this.toRepo(await this.get<ForgejoRepo>(`/repos/${fullName}`));
		// a token limited to some repositories reads the user's role here, not its own
		return { ...repo, canPush: repo.canPush && (await this.check(fullName)).canPush };
	}

	// Forgejo from 15 on fills its token form from the address; Gitea and older Forgejo do not
	async tokenUrl(): Promise<string> {
		const plain = `${this.server}/user/settings/applications`;
		try {
			const { body } = await this.api<{ version?: string }>(`${this.server}/api/v1/version`, {});
			const version = body?.version ?? "";
			const major = Number.parseInt(version, 10);
			if (!version.includes("+gitea-") || !(major >= 15)) return plain;
		} catch {
			return plain;
		}
		const params = new URLSearchParams({ name: TOKEN_NAME, resource: "all" });
		params.append("scope", "write:repository");
		params.append("scope", "read:user");
		return `${this.server}/user/settings/applications/tokens/new?${params.toString()}`;
	}

	cloneUrl(fullName: string): string {
		return `${this.server}/${fullName}.git`;
	}

	gitLogin(): GitAuth | null {
		const token = this.deps.token();
		return token ? { username: this.login ?? "oauth2", password: token } : null;
	}

	fileUrl(fullName: string, branch: string, path: string): string {
		return `${this.server}/${fullName}/src/branch/${encodeURIComponent(branch)}/${encodePath(path)}`;
	}
}

class BitbucketHost extends GitHost {
	readonly id = "bitbucket";
	readonly name = "Bitbucket";
	readonly linksAccounts = false;

	private get headers(): Record<string, string> {
		const token = this.deps.token();
		if (!token) throw new RemoteError(401, "No Bitbucket token set.", "auth");
		return { Authorization: `Bearer ${token}` };
	}

	private get<T>(path: string) {
		return this.api<T>(`https://api.bitbucket.org/2.0${path}`, this.headers);
	}

	protected async fetchAccount(): Promise<Account> {
		const { body } = await this.get<{ username: string; display_name: string }>("/user");
		return { login: body?.username ?? "", name: body?.display_name ?? "" };
	}

	// listed per workspace: Bitbucket dropped the lists across all of them
	async repos(): Promise<RepoInfo[]> {
		const { body: spaces, headers } = await this.get<{
			values: Array<{ workspace: { slug: string } }>;
		}>("/user/workspaces?pagelen=100");
		const writes = (headers["x-oauth-scopes"] ?? "write:repository").includes("write:repository");
		const out: RepoInfo[] = [];
		for (const { workspace } of spaces?.values ?? []) {
			const slug = encodeURIComponent(workspace.slug);
			const { body: repos } = await this.get<{
				values: Array<{
					full_name: string;
					is_private: boolean;
					mainbranch: { name: string } | null;
				}>;
			}>(`/repositories/${slug}?role=member&pagelen=100&sort=-updated_on`);
			const { body: roles } = await this.get<{
				values: Array<{ permission: string; repository: { full_name: string } }>;
			}>(`/user/workspaces/${slug}/permissions/repositories?pagelen=100`);
			const role = new Map(roles?.values.map((v) => [v.repository.full_name, v.permission]) ?? []);
			for (const repo of repos?.values ?? []) {
				const permission = role.get(repo.full_name) ?? "read";
				out.push({
					fullName: repo.full_name,
					private: repo.is_private,
					defaultBranch: repo.mainbranch?.name ?? "main",
					canPush: writes && permission !== "read",
					empty: false,
				});
			}
		}
		return out;
	}

	async repo(fullName: string): Promise<RepoInfo> {
		const { body } = await this.get<{
			full_name: string;
			is_private: boolean;
			mainbranch: { name: string } | null;
		}>(`/repositories/${fullName}`);
		const checked = await this.check(fullName);
		return {
			fullName: body?.full_name ?? fullName,
			private: body?.is_private ?? true,
			defaultBranch: checked.defaultBranch ?? body?.mainbranch?.name ?? "main",
			canPush: checked.canPush,
			empty: checked.empty,
		};
	}

	// the API token page cannot be filled in from the address
	async tokenUrl(): Promise<string> {
		return "https://id.atlassian.com/manage-profile/security/api-tokens";
	}

	cloneUrl(fullName: string): string {
		return `https://bitbucket.org/${fullName}.git`;
	}

	gitLogin(): GitAuth | null {
		const token = this.deps.token();
		return token ? { username: "x-bitbucket-api-token-auth", password: token } : null;
	}

	fileUrl(fullName: string, branch: string, path: string): string {
		return `https://bitbucket.org/${fullName}/src/${encodeURIComponent(branch)}/${encodePath(path)}`;
	}
}

// a repository known only by its URL: no account API, so no list and no links
class OtherHost extends GitHost {
	readonly id = "other";
	readonly name = "the server";
	readonly linksAccounts = false;

	constructor(
		private readonly connection: Connection,
		deps: HostDeps,
	) {
		super(deps);
	}

	protected async fetchAccount(): Promise<Account> {
		const login = this.connection.username || "vault";
		return { login, name: login };
	}

	async repos(): Promise<RepoInfo[]> {
		return [];
	}

	async repo(url: string): Promise<RepoInfo> {
		const checked = await this.check(url);
		return {
			fullName: url,
			private: true,
			defaultBranch: checked.defaultBranch ?? "main",
			canPush: checked.canPush,
			empty: checked.empty,
		};
	}

	async tokenUrl(): Promise<null> {
		return null;
	}

	cloneUrl(url: string): string {
		return url.replace(/\/+$/, "");
	}

	gitLogin(): GitAuth | null {
		const password = this.deps.token();
		return password !== null || this.connection.username
			? { username: this.connection.username, password: password ?? "" }
			: null;
	}

	fileUrl(): null {
		return null;
	}
}
