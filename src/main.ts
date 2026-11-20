import {
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Plugin,
	requestUrl,
	setIcon,
	type TAbstractFile,
	TFile,
} from "obsidian";
import { conflictEditorExtension } from "./editor";
import { toArrayBuffer } from "./lib/bytes";
import { capitalize } from "./lib/format";
import { ObsidianFs } from "./local-fs";
import { GitLockstep } from "./lockstep";
import { hasConflictMarker, resolveAllNewer } from "./merge/conflict";
import { ConflictsModal, chooseFirstSync, confirm, pickBranch } from "./modals";
import { conflictPostProcessor } from "./reading";
import type { BlobStash } from "./remote/git-remote";
import {
	type Account,
	type Connection,
	createHost,
	type Host,
	type ProviderId,
	type RepoInfo,
} from "./remote/hosts";
import { type Http, OfflineError, RemoteError } from "./remote/http";
import {
	type DeviceSettings,
	type Draft,
	defaultDeviceName,
	type EasyGitSyncSettings,
	EasyGitSyncSettingTab,
	parseSettings,
} from "./settings";
import {
	type FirstSync,
	MassDeleteError,
	preview,
	type SyncOptions,
	type SyncReport,
	sync,
} from "./sync/engine";
import { emptyState, type SyncState } from "./sync/types";

const TOKEN_SECRET = "easy-git-sync-token";
const DEVICE_KEY = "easy-git-sync-device";
// a full scan even when the remote has nothing new, to catch edits in the config folder
const FULL_SYNC_EVERY = 10 * 60_000;
const OWN_WRITE_ECHO = 5_000;
const EXPIRY_WARNING = 14 * 24 * 60 * 60_000;
const EXPIRY_CHECK_EVERY = 24 * 60 * 60_000;
const LOOKUP_FRESH = 5 * 60_000;

export interface Lookup {
	account: Account;
	repos: RepoInfo[];
	expiry: Date | null;
}

type Status =
	| { kind: "setup"; text: string }
	| { kind: "paused"; text: string }
	| { kind: "syncing"; text: string }
	| { kind: "idle" }
	| { kind: "offline" }
	| { kind: "error"; text: string };

const REQUEST_TIMEOUT = 120_000;

// requestUrl has no timeout, and a request iOS suspended may never settle and
// would hold the single-flight sync forever
const obsidianHttp: Http = async (request) => {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new Error("the request timed out")), REQUEST_TIMEOUT);
	});
	try {
		const response = await Promise.race([
			requestUrl({
				url: request.url,
				method: request.method,
				headers: request.headers,
				...(request.body === undefined ? {} : { body: request.body }),
				...(request.headers["Content-Type"]
					? { contentType: request.headers["Content-Type"] }
					: {}),
				throw: false,
			}),
			timeout,
		]);
		return { status: response.status, headers: response.headers, body: response.arrayBuffer };
	} finally {
		window.clearTimeout(timer);
	}
};

export default class EasyGitSync extends Plugin {
	override settings!: EasyGitSyncSettings;
	device!: DeviceSettings;
	private hostCache: { key: string; host: Host } | null = null;
	draft: Draft | null = null;
	private draftHostCache: { key: string; host: Host } | null = null;
	private committing = false;
	private lookups = new Map<
		string,
		{ at: number; pending: Promise<Lookup>; value: Lookup | null; loading: boolean }
	>();
	private settingTab: EasyGitSyncSettingTab | null = null;
	private fs!: ObsidianFs;
	private expiryChecked = 0;
	private state: SyncState | null = null;

	private running: Promise<void> | null = null;
	private again = false;
	private dirty = false;
	private lastFullSync = 0;
	private lastSynced: Date | null = null;
	private blocked: string | null = null;
	private lastErrorShown: string | null = null;
	private status: Status = { kind: "idle" };
	private shownStatus: Status = { kind: "idle" };
	private statusTimer: number | null = null;
	private lockstep: GitLockstep | null | undefined;
	private savedState: string | null = null;

	private pendingMassDelete: MassDeleteError | null = null;
	private progressNotice: Notice | null = null;
	private progressTimer: number | null = null;
	private unloaded = false;

	private editTimer: number | null = null;
	private pollTimer: number | null = null;
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.loadDevice();
		this.fs = new ObsidianFs(this.app);

		this.settingTab = new EasyGitSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registerEditorExtension(conflictEditorExtension());
		this.registerMarkdownPostProcessor(conflictPostProcessor(this.app));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("easy-git-sync-status", "mod-clickable");
		this.registerDomEvent(this.statusEl, "click", (event) => this.showMenu(event));
		this.ribbonEl = this.addRibbonIcon(
			"refresh-cw",
			this.connectionLabel(),
			() => void this.syncNow("manual"),
		);
		this.ribbonEl.addClass("easy-git-sync-ribbon");

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.syncNow("manual"),
		});
		this.addCommand({
			id: "show-conflicts",
			name: "Show notes with sync conflicts",
			callback: () => this.showConflicts(),
		});
		this.addCommand({
			id: "resolve-conflicts-newer",
			name: "Resolve all sync conflicts with the newer version",
			callback: () => void this.resolveAllNewer(),
		});
		// the id dates from when GitHub was the only host, and hotkeys are bound to it
		this.addCommand({
			id: "open-on-github",
			name: "Open this note on the web",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.device.repo) return false;
				const url = this.host.fileUrl(this.device.repo, this.device.branch, file.path);
				if (!url) return false;
				if (!checking) window.open(url);
				return true;
			},
		});

		this.app.workspace.onLayoutReady(() => {
			// not before: while the vault loads, every file fires `create`
			this.registerEvent(this.app.vault.on("modify", (file) => this.onLocalChange(file)));
			this.registerEvent(this.app.vault.on("create", (file) => this.onLocalChange(file)));
			this.registerEvent(this.app.vault.on("delete", (file) => this.onLocalChange(file)));
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					this.followRename(oldPath, file.path);
					this.onLocalChange(file);
				}),
			);
			this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());
			this.reschedule();
			this.render();
			if (this.ready()) void this.syncNow("startup");
		});
	}

	override onunload(): void {
		this.unloaded = true;
		if (this.editTimer !== null) window.clearTimeout(this.editTimer);
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
	}

	async loadSettings(): Promise<void> {
		this.settings = parseSettings((await this.loadData()) as Partial<EasyGitSyncSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private loadDevice(): void {
		const saved = this.app.loadLocalStorage(DEVICE_KEY) as Partial<DeviceSettings> | null;
		this.device = {
			provider: "github",
			server: "",
			username: "",
			repo: null,
			branch: "main",
			deviceName: defaultDeviceName(),
			started: false,
			...(saved ?? {}),
		};
	}

	get connection(): Connection {
		return {
			provider: this.device.provider,
			server: this.device.server,
			username: this.device.username,
		};
	}

	get host(): Host {
		const key = JSON.stringify(this.connection);
		if (this.hostCache?.key !== key) {
			this.hostCache = {
				key,
				host: createHost(this.connection, {
					http: obsidianHttp,
					token: () => this.token(),
					sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
				}),
			};
		}
		return this.hostCache.host;
	}

	get hostName(): string {
		return capitalize(this.host.name);
	}

	// "the GitLab token", but "the token for the server"
	get tokenName(): string {
		const name = this.host.name;
		return name.startsWith("the ") ? `the token for ${name}` : `the ${name} token`;
	}

	beginDraft(): Draft {
		if (!this.draft) {
			const { provider, server, username, repo, branch } = this.device;
			this.draft = {
				provider,
				server,
				username,
				token: null,
				repo,
				branch,
				checked: repo !== null,
			};
		}
		return this.draft;
	}

	cancelDraft(): void {
		this.draft = null;
	}

	setDraftConnection(change: Partial<Connection>): void {
		const draft = this.beginDraft();
		const before = connectionOf(draft);
		const next = { ...before, ...change };
		if (JSON.stringify(next) === JSON.stringify(before)) return;
		const sameHost = next.provider === before.provider && next.server === before.server;
		const live = this.connection;
		// back on the live host, so its repository need not be picked again
		const home =
			this.device.started && next.provider === live.provider && next.server === live.server;
		const repo = sameHost
			? {}
			: home
				? { repo: this.device.repo, branch: this.device.branch, checked: true }
				: { repo: null, branch: "main", checked: false };
		this.draft = { ...draft, ...next, token: null, ...repo };
	}

	draftHost(): Host | null {
		const draft = this.draft;
		if (!draft) return null;
		const connection = connectionOf(draft);
		const key = JSON.stringify(connection);
		if (this.draftHostCache?.key !== key) {
			this.draftHostCache = {
				key,
				host: createHost(connection, {
					http: obsidianHttp,
					token: () => this.draftToken(),
					sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
				}),
			};
		}
		return this.draftHostCache.host;
	}

	draftToken(): string | null {
		const draft = this.draft;
		if (!draft) return null;
		return draft.token ?? this.savedToken(connectionOf(draft));
	}

	draftSavedToken(): boolean {
		return this.draft !== null && this.savedToken(connectionOf(this.draft)) !== null;
	}

	draftHasLogin(): boolean {
		const draft = this.draft;
		if (!draft) return false;
		return this.draftToken() !== null || (draft.provider === "other" && draft.username !== "");
	}

	draftChange(): "none" | "login" | "target" {
		const draft = this.draft;
		if (!draft) return "none";
		if (!this.device.started) return "target";
		const live = this.device;
		const sameTarget =
			draft.provider === live.provider &&
			draft.server === live.server &&
			draft.repo === live.repo &&
			draft.branch === live.branch;
		if (!sameTarget) return "target";
		return draft.token !== null || draft.username !== live.username ? "login" : "none";
	}

	// quiet: no notices and no branch picker, so it only fills in what leaves nothing to choose
	async pickDraftRepo(fullName: string, quiet = false): Promise<boolean> {
		const draft = this.draft;
		const host = this.draftHost();
		if (!draft || !host) return false;
		let repo: Awaited<ReturnType<Host["repo"]>>;
		try {
			repo = await host.repo(fullName);
		} catch (error) {
			if (!quiet) new Notice(`Easy Git Sync: could not open ${fullName}. ${describe(error)}`);
			return false;
		}
		if (!repo.canPush) {
			if (!quiet) new Notice(`Easy Git Sync: ${readOnly(host.id, repo.fullName)}`, 10_000);
			return false;
		}
		let branch = repo.defaultBranch;
		if (!repo.empty) {
			const branches = await host
				.branches(repo.fullName, repo.defaultBranch)
				.catch((): string[] => []);
			// a failed listing falls back to the default branch, but is not a choice made for anyone
			if (quiet && branches.length !== 1) return false;
			if (branches.length > 1) {
				const picked = await pickBranch(this.app, repo.fullName, branches, repo.defaultBranch);
				if (picked === null) return false;
				branch = picked;
			}
		}
		if (this.draft !== draft || (quiet && draft.repo !== null)) return false;
		draft.repo = repo.fullName;
		draft.branch = branch;
		draft.checked = true;
		return true;
	}

	// true once the draft is the live connection; false leaves both as they were
	async commitDraft(): Promise<boolean> {
		const draft = this.draft;
		const host = this.draftHost();
		if (!draft?.repo || !host || this.committing || this.unloaded) return false;
		if (this.otherGitPluginEnabled()) {
			new Notice("Easy Git Sync: turn off the Git plugin on this device first.");
			return false;
		}
		this.committing = true;
		try {
			if (!draft.checked && !(await this.pickDraftRepo(draft.repo))) return false;
			const repo = draft.repo;
			const change = this.draftChange();
			if (change === "none") return false;
			if (change === "login") {
				try {
					const info = await host.repo(repo);
					if (!info.canPush) {
						new Notice(`Easy Git Sync: ${readOnly(host.id, repo)}`, 10_000);
						return false;
					}
				} catch (error) {
					new Notice(`Easy Git Sync: ${describe(error)}`);
					return false;
				}
				const account = await host.account().catch(() => null);
				await this.applyDraft(draft, null, account?.login);
				void this.syncNow("manual");
				return true;
			}
			const start = await this.confirmStart(draft, host);
			if (start === null || this.draft !== draft) return false;
			const account = await host.account().catch(() => null);
			await this.applyDraft(draft, start, account?.login);
			void this.syncNow("manual");
			return true;
		} finally {
			this.committing = false;
		}
	}

	// the preview and the first-sync choice, against the draft and without touching the live sync;
	// "resume" when this device synced with that target before and kept the history
	private async confirmStart(draft: Draft, host: Host): Promise<FirstSync | "resume" | null> {
		const repo = draft.repo ?? "";
		const label = repoLabelOf(draft.provider, repo);
		const target = targetOf(draft);
		const remote = host.remote(repo, draft.branch, this.settings.commitAsAccount, null);
		const compare = (state: SyncState) =>
			preview(state, {
				fs: this.fs,
				remote,
				device: this.device.deviceName,
				stateFile: this.stateFile,
				configDir: this.app.vault.configDir,
				conflicts: this.settings.conflicts,
				remoteName: host.name,
				saveState: async () => {},
			});
		const notice = new Notice(`Easy Git Sync: comparing with ${host.name}...`, 0);
		let kept = (await this.readState(target))?.state ?? null;
		let summary: Awaited<ReturnType<typeof preview>>;
		try {
			summary = await compare(kept ?? emptyState(target));
			// emptied since: the kept history would read as everything deleted there, so start over
			if (kept && summary.emptyRemote) {
				kept = null;
				summary = await compare(emptyState(target));
			}
		} catch (error) {
			notice.hide();
			new Notice(`Easy Git Sync: ${describe(error)}`);
			return null;
		}
		notice.hide();
		const leaving = this.device.started
			? `This device stops syncing with ${this.repoLabel} on ${this.host.name}.`
			: null;
		if (kept?.commit) {
			const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
			const changes = [
				summary.upload > 0 ? `${files(summary.upload)} to upload` : null,
				summary.download > 0 ? `${files(summary.download)} to download` : null,
				summary.merge > 0 ? `${files(summary.merge)} to merge` : null,
				summary.deleteThere > 0 ? `${files(summary.deleteThere)} to delete on ${host.name}` : null,
				summary.deleteHere > 0 ? `${files(summary.deleteHere)} to delete here` : null,
			].filter((part) => part !== null);
			const lines = [
				"This device synced with it before, so it picks up where it left off.",
				changes.length > 0
					? `Changed since: ${changes.join(", ")}.`
					: "Nothing changed on either side since.",
			];
			if (leaving) lines.push(leaving);
			const ok = await confirm(this.app, `Start syncing with ${label}?`, lines, "Start syncing");
			return ok ? "resume" : null;
		}
		const { notes } = summary;
		// asked only when both sides have notes that differ: a fresh phone never offers to wipe the remote
		if (!summary.emptyRemote && notes.here > 0 && notes.there > 0 && notes.differ > 0) {
			return chooseFirstSync(this.app, {
				repo: label,
				remote: host.name,
				same: summary.same,
				upload: summary.upload,
				download: summary.download,
				merge: summary.merge,
				newest: this.settings.conflicts === "newest",
				leaving,
			});
		}
		const lines = summary.emptyRemote
			? [`${label} is empty. This vault becomes its first commit: ${summary.upload} files.`]
			: [
					`Already the same on both sides: ${summary.same} files.`,
					`Only in this vault, to upload: ${summary.upload}.`,
					`Only on ${host.name}, to download: ${summary.download}.`,
				];
		if (leaving) lines.push(leaving);
		const ok = await confirm(this.app, `Start syncing with ${label}?`, lines, "Start syncing");
		return ok ? "merge" : null;
	}

	// a new target starts a fresh sync history, a resume reads the kept one, a new login keeps it
	private async applyDraft(
		draft: Draft,
		start: FirstSync | "resume" | null,
		account: string | undefined,
	): Promise<void> {
		// a sync that started meanwhile must finish against the target it read
		while (this.running) await this.running.catch(() => {});
		if (this.unloaded) return;
		const connection = connectionOf(draft);
		if (draft.token !== null) {
			this.app.secretStorage.setSecret(this.tokenIdFor(connection), draft.token);
		}
		const { firstSync: pending, account: before, ...device } = this.device;
		// a new login for the same sync keeps the name it had if the lookup failed
		const login = account ?? (start === null ? before : undefined);
		this.device = {
			...device,
			...connection,
			repo: draft.repo,
			branch: draft.branch,
			started: true,
			...(login ? { account: login } : {}),
		};
		if (start === "resume") {
			this.state = null;
			this.savedState = null;
			await this.loadState();
			this.lockstep = undefined;
			this.lastSynced = null;
		} else if (start !== null) {
			this.device.firstSync = start;
			this.state = emptyState(this.target);
			await this.saveState();
			this.lockstep = undefined;
			this.lastSynced = null;
		} else if (pending) {
			this.device.firstSync = pending;
		}
		this.saveDevice();
		this.draft = null;
		this.blocked = null;
		this.lastErrorShown = null;
		this.expiryChecked = 0;
		this.setStatus({ kind: "idle" });
		this.reschedule();
	}

	// also the prefetch that lets "Change connection" show the token check at once
	async refreshAccount(): Promise<void> {
		if (!this.device.started || !this.hasToken() || this.device.provider === "other") return;
		const found = await this.lookup(this.host, this.connection, this.token()).catch(() => null);
		const login = found?.account.login;
		if (!login || login === this.device.account || !this.device.started) return;
		this.device.account = login;
		this.saveDevice();
		this.render();
	}

	// shared for a few minutes: listing costs a request per page, and on GitHub one per repository
	lookup(
		host: Host,
		connection: Connection,
		token: string | null,
		maxAge = LOOKUP_FRESH,
	): Promise<Lookup> {
		const key = lookupKey(connection, token);
		const old = this.lookups.get(key);
		// one still loading is as fresh as a new one would be
		if (old && (old.loading || Date.now() - old.at < maxAge)) return old.pending;
		const pending = Promise.all([
			host.account(),
			host.repos(),
			host.tokenExpiry().catch(() => null),
		]).then(([account, repos, expiry]) => ({ account, repos, expiry }));
		// the last answer stays readable while a newer one loads
		const entry = { at: Date.now(), pending, value: old?.value ?? null, loading: true };
		this.lookups.set(key, entry);
		pending.then(
			(value) => {
				entry.value = value;
				entry.loading = false;
			},
			() => {
				if (this.lookups.get(key) !== entry) return;
				if (old) this.lookups.set(key, old);
				else this.lookups.delete(key);
			},
		);
		return pending;
	}

	peekLookup(connection: Connection, token: string | null): Lookup | null {
		return this.lookups.get(lookupKey(connection, token))?.value ?? null;
	}

	draftLookup(maxAge?: number): Promise<Lookup> | null {
		const draft = this.draft;
		const host = this.draftHost();
		if (!draft || !host) return null;
		return this.lookup(host, connectionOf(draft), this.draftToken(), maxAge);
	}

	peekDraftLookup(): Lookup | null {
		return this.draft ? this.peekLookup(connectionOf(this.draft), this.draftToken()) : null;
	}

	// an instance Hot Reload or a disable replaced still finishes its awaits, with an outdated device
	saveDevice(): void {
		if (this.unloaded) return;
		this.app.saveLocalStorage(DEVICE_KEY, this.device);
	}

	// per vault, in case the keychain is shared: two vaults must not overwrite each other's token;
	// and per provider and server, so switching back finds the token that was there
	private tokenIdFor(connection: Connection): string {
		const appId = (this.app as unknown as { appId?: string }).appId;
		const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
		const suffix = slug(appId ?? "");
		const base = suffix ? `${TOKEN_SECRET}-${suffix}` : TOKEN_SECRET;
		const { provider, server, username } = connection;
		if (provider === "github") return base;
		const where = provider === "other" ? `${server}${username}` : server;
		return `${base}-${provider}${where ? `-${slug(where)}` : ""}`;
	}

	private get tokenId(): string {
		return this.tokenIdFor(this.connection);
	}

	private savedToken(connection: Connection): string | null {
		return this.app.secretStorage.getSecret(this.tokenIdFor(connection)) || null;
	}

	token(): string | null {
		return this.savedToken(this.connection);
	}

	// another git server may take a login without a password
	hasToken(): boolean {
		return (
			this.token() !== null || (this.device.provider === "other" && this.device.username !== "")
		);
	}

	otherGitPluginEnabled(): boolean {
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
		return plugins?.enabledPlugins?.has("obsidian-git") ?? false;
	}

	remote() {
		return this.device.repo
			? this.host.remote(
					this.device.repo,
					this.device.branch,
					this.settings.commitAsAccount,
					this.keptStash(),
				)
			: null;
	}

	private get target(): string {
		return targetOf(this.device);
	}

	private get pluginDir(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	// this device's losing versions, kept on disk until a commit has taken them up
	private keptStash(): BlobStash {
		const adapter = this.app.vault.adapter;
		const dir = `${this.pluginDir}/kept`;
		return {
			get: async (sha) => {
				const path = `${dir}/${sha}`;
				return (await adapter.exists(path)) ? new Uint8Array(await adapter.readBinary(path)) : null;
			},
			put: async (sha, bytes) => {
				if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
				await adapter.writeBinary(`${dir}/${sha}`, toArrayBuffer(bytes));
			},
			delete: async (sha) => {
				const path = `${dir}/${sha}`;
				if (await adapter.exists(path)) await adapter.remove(path);
			},
		};
	}

	private get stateFile(): string {
		return `${this.pluginDir}/state.json`;
	}

	private ready(): boolean {
		return (
			this.device.started &&
			this.device.repo !== null &&
			this.hasToken() &&
			!this.otherGitPluginEnabled() &&
			this.blocked === null
		);
	}

	get repoLabel(): string {
		return repoLabelOf(this.device.provider, this.device.repo ?? "");
	}

	// "Syncing with me/notes on GitLab", for the settings, the status bar menu and the ribbon
	connectionLabel(): string {
		return this.device.started
			? `Syncing with ${this.repoLabel} on ${this.host.name}`
			: "Not connected";
	}

	// the status dot in the settings: the same reading as the ribbon's colour
	health(): "off" | "ok" | "warning" | "error" {
		if (!this.device.started) return "off";
		if (this.status.kind === "error" || this.blocked !== null) return "error";
		if (
			!this.ready() ||
			this.status.kind === "paused" ||
			this.status.kind === "offline" ||
			this.conflictCount() > 0
		)
			return "warning";
		return "ok";
	}

	// the sync history stays on disk, so reconnecting to the same target picks up where it left off;
	// connecting anywhere else replaces it
	async disconnect(): Promise<void> {
		while (this.running) await this.running.catch(() => {});
		if (this.unloaded) return;
		this.draft = null;
		this.app.secretStorage.setSecret(this.tokenId, "");
		this.device = {
			provider: this.device.provider,
			server: this.device.server,
			username: this.device.username,
			repo: null,
			branch: "main",
			deviceName: this.device.deviceName,
			started: false,
		};
		this.saveDevice();
		this.state = null;
		this.savedState = null;
		this.lockstep = undefined;
		this.lastSynced = null;
		this.blocked = null;
		this.reschedule();
		this.render();
	}

	reschedule(): void {
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		this.pollTimer = null;
		const seconds = this.settings.checkInterval;
		if (seconds > 0) this.pollTimer = window.setInterval(() => void this.poll(), seconds * 1000);
	}

	private onLocalChange(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		void this.fs.isOwnEcho(file.path, OWN_WRITE_ECHO).then((echo) => {
			if (!echo) this.markDirty(file);
		});
	}

	private followRename(from: string, to: string): void {
		if (!this.state?.conflicts.includes(from)) return;
		this.state = {
			...this.state,
			conflicts: this.state.conflicts.map((path) => (path === from ? to : path)),
		};
		void this.saveState();
	}

	private markDirty(file: TFile): void {
		if (file instanceof TFile && this.state?.conflicts.includes(file.path))
			void this.recheckConflict(file);
		this.dirty = true;
		if (this.editTimer !== null) window.clearTimeout(this.editTimer);
		this.editTimer = null;
		const seconds = this.settings.syncAfterEdit;
		if (seconds > 0 && this.ready()) {
			this.editTimer = window.setTimeout(() => {
				this.editTimer = null;
				void this.syncNow("edit");
			}, seconds * 1000);
		}
	}

	// leaving the app is the last chance a phone gives: iOS suspends it within seconds
	private onVisibilityChange(): void {
		if (!this.ready()) return;
		if (document.visibilityState === "hidden") {
			if (this.dirty) void this.syncNow("background");
		} else if (Date.now() - this.lastFullSync > 30_000) {
			void this.syncNow("resume");
		}
	}

	private async poll(): Promise<void> {
		if (!this.ready() || this.running || document.visibilityState === "hidden") return;
		if (this.dirty || Date.now() - this.lastFullSync > FULL_SYNC_EVERY) {
			await this.syncNow("poll");
			return;
		}
		try {
			const head = await this.remote()?.head();
			if (head !== (this.state?.commit ?? null)) await this.syncNow("poll");
		} catch (error) {
			this.handleError(error, false);
		}
	}

	async syncNow(
		reason: "manual" | "startup" | "edit" | "poll" | "resume" | "background",
		allowMassDelete = false,
	): Promise<void> {
		if (this.unloaded) return;
		if (reason === "manual") this.blocked = null;
		if (!this.ready()) {
			if (reason === "manual") new Notice(`Easy Git Sync: ${this.notReadyReason()}`);
			this.render();
			return;
		}
		// opened even while a sync is running: that one reports into it when it ends
		if (reason === "manual" && !this.progressNotice) {
			this.progressNotice = new Notice("Easy Git Sync: syncing...", 0);
		}
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = this.run(reason, allowMassDelete).finally(() => {
			this.running = null;
			const massDelete = this.pendingMassDelete;
			this.pendingMassDelete = null;
			if (massDelete) {
				// not awaited inside run(): confirming starts a sync, which would deadlock on `running`
				void this.confirmMassDelete(massDelete);
			} else if (this.again) {
				this.again = false;
				void this.syncNow("edit");
			}
		});
		return this.running;
	}

	private syncOptions(allowMassDelete: boolean): SyncOptions {
		const remote = this.remote();
		if (!remote) throw new Error("No repository chosen.");
		return {
			fs: this.fs,
			remote,
			device: this.device.deviceName,
			stateFile: this.stateFile,
			configDir: this.app.vault.configDir,
			allowMassDelete,
			conflicts: this.settings.conflicts,
			remoteName: this.host.name,
			...(this.device.firstSync ? { firstSync: this.device.firstSync } : {}),
			saveState: async (state) => {
				this.state = state;
				await this.saveState();
			},
			progress: (text) => {
				this.setStatus({ kind: "syncing", text });
				this.showProgress(text);
			},
		};
	}

	private async run(reason: string, allowMassDelete: boolean): Promise<void> {
		this.setStatus({ kind: "syncing", text: "Syncing" });
		try {
			await this.flushEditors();
			this.dirty = false;
			const state = await this.loadState();
			const lockstep = await this.getLockstep();
			const blocker = await lockstep?.blocker().catch(() => null);
			if (blocker) {
				this.dirty = true;
				this.setStatus({ kind: "paused", text: `Waiting: ${blocker}` });
				if (reason === "manual" || this.progressNotice) {
					this.tell(
						`paused, because ${blocker} Syncing resumes once git is back to normal.`,
						8_000,
					);
				}
				return;
			}
			const before = lockstep
				? await lockstep.beforeSync(state.commit).catch((e: unknown) => {
						warn("git push", e);
						return null;
					})
				: null;

			const first = state.commit === null;
			const result = await sync(state, this.syncOptions(allowMassDelete));
			this.state = result.state;
			await this.saveState();
			if (this.device.firstSync && result.state.commit !== null) {
				const { firstSync: _, ...device } = this.device;
				this.device = device;
				this.saveDevice();
			}

			const commit = result.state.commit;
			if (lockstep && commit && before)
				await lockstep.afterSync(commit, before).catch((e: unknown) => warn("git reset", e));

			this.lastFullSync = Date.now();
			this.lastSynced = new Date();
			this.lastErrorShown = null;
			await this.recheckConflicts();
			this.setStatus({ kind: "idle" });
			this.announce(result.report, reason === "manual" || this.progressNotice !== null, first);
			void this.warnOfExpiry();
		} catch (error) {
			this.dirty = true;
			this.handleError(error, reason === "manual");
			if (error instanceof MassDeleteError) this.pendingMassDelete = error;
		}
	}

	// saving an unchanged editor touches its mtime, and a touched note looks edited
	private async flushEditors(): Promise<void> {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file) continue;
			const disk = await this.app.vault.cachedRead(view.file);
			if (disk.replace(/\r\n/g, "\n") !== view.editor.getValue()) await view.save();
		}
	}

	private async getLockstep(): Promise<GitLockstep | null> {
		if (!Platform.isDesktopApp || !this.device.repo) return null;
		// not found is not remembered: the vault may get a `.git`, or go back to the branch
		if (!this.lockstep) {
			const adapter = this.app.vault.adapter as unknown as { getBasePath?: () => string };
			const base = adapter.getBasePath?.();
			this.lockstep = base
				? await GitLockstep.detect(
						base,
						this.host.cloneUrl(this.device.repo),
						this.device.branch,
						() => this.host.gitLogin(),
						this.stateFile,
					)
				: null;
		}
		return this.lockstep;
	}

	private async confirmMassDelete(error: MassDeleteError): Promise<void> {
		const where = [
			error.here > 0 ? `${error.here} files in this vault` : null,
			error.there > 0 ? `${error.there} files on ${this.host.name}` : null,
		]
			.filter(Boolean)
			.join(" and ");
		const ok = await confirm(
			this.app,
			"Delete most of the vault?",
			[
				`This sync would delete ${where}. That is usually a vault that did not finish loading, a moved folder, or an emptied repository, not something done on purpose.`,
				`Nothing is deleted until you confirm. Deleted files stay in ${this.host.name}'s history either way.`,
			],
			"Delete them",
			true,
		);
		if (ok) {
			this.blocked = null;
			await this.syncNow("manual", true);
		}
	}

	private handleError(error: unknown, manual: boolean): void {
		if (error instanceof OfflineError) {
			this.setStatus({ kind: "offline" });
			if (manual || this.progressNotice) {
				this.tell(`${this.hostName} cannot be reached. Changes sync once it can.`, 6_000);
			}
			return;
		}
		if (error instanceof MassDeleteError) {
			this.blocked = "Waiting for you to confirm a large deletion.";
			this.setStatus({ kind: "paused", text: this.blocked });
			if (this.progressNotice) this.tell("waiting for you to confirm a large deletion.", 4_000);
			return;
		}
		const message = describe(error);
		if (
			error instanceof RemoteError &&
			(error.kind === "auth" || error.kind === "not-found" || error.kind === "forbidden")
		) {
			const login = this.device.provider === "other" ? "login" : "token";
			this.blocked =
				error.kind === "auth"
					? `${this.hostName} did not accept the ${login}. It may have expired or been revoked: ${login === "token" ? "create a new one" : "check it"} in the settings.`
					: `${this.repoLabel}: ${message} Check that the ${login} still has access to it.`;
			this.setStatus({ kind: "paused", text: this.blocked });
			if (manual || this.progressNotice || this.lastErrorShown !== this.blocked)
				this.tell(this.blocked, 15_000);
			this.lastErrorShown = this.blocked;
			return;
		}
		console.error("Easy Git Sync:", error);
		this.setStatus({ kind: "error", text: message });
		if (manual || this.progressNotice || this.lastErrorShown !== message)
			this.tell(message, 10_000);
		this.lastErrorShown = message;
	}

	// shown only once a step lasts a moment: a sync with nothing to do would flash unreadable text
	private showProgress(text: string): void {
		if (!this.progressNotice) return;
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		const message = `Easy Git Sync: ${text.charAt(0).toLowerCase()}${text.slice(1)}...`;
		this.progressTimer = window.setTimeout(() => {
			this.progressTimer = null;
			this.progressNotice?.setMessage(message);
		}, 400);
	}

	private tell(message: string | ((f: DocumentFragment) => void), duration: number): void {
		const content =
			typeof message === "string"
				? `Easy Git Sync: ${message}`
				: createFragment((f) => {
						f.appendText("Easy Git Sync: ");
						message(f);
					});
		const notice = this.progressNotice;
		this.progressNotice = null;
		if (this.progressTimer !== null) window.clearTimeout(this.progressTimer);
		this.progressTimer = null;
		if (!notice) {
			new Notice(content, duration);
			return;
		}
		notice.setMessage(content);
		window.setTimeout(() => notice.hide(), duration);
	}

	private announce(report: SyncReport, manual: boolean, first: boolean): void {
		const lines: Array<(f: DocumentFragment) => void> = [];
		let duration = 4_000;

		if (report.conflicts.length > 0) {
			duration = 15_000;
			lines.push((f) => {
				f.appendText(
					report.conflicts.length === 1
						? "a note changed on two devices in the same place: "
						: `${report.conflicts.length} notes changed on two devices in the same places: `,
				);
				report.conflicts.forEach((c, i) => {
					if (i > 0) f.appendText(", ");
					const link = f.createEl("a", { text: c.path, href: "#" });
					link.addEventListener("click", (event) => {
						event.preventDefault();
						void this.openConflict(c.path);
					});
				});
				f.appendText(". Both versions are in the note, marked. Keep one, keep both, or edit it.");
			});
		}
		if (report.newer.length > 0) {
			duration = Math.max(duration, 10_000);
			lines.push((f) => {
				f.appendText("changed in the same place on two devices, kept the newer version: ");
				report.newer.forEach((n, i) => {
					if (i > 0) f.appendText(", ");
					f.appendText(
						n.places === 0
							? `${n.path} (from ${n.from})`
							: `${n.path} (from ${n.from}, in ${n.places} ${n.places === 1 ? "place" : "places"})`,
					);
				});
				f.appendText(`. The other version is in ${this.host.name}'s history.`);
			});
		}
		for (const kept of report.keptBoth) {
			duration = 15_000;
			lines.push((f) =>
				f.appendText(
					`${kept.path} changed on two devices. Both are kept: the other version is ${kept.copy}.`,
				),
			);
		}
		if (report.restored.length > 0) {
			duration = Math.max(duration, 10_000);
			lines.push((f) =>
				f.appendText(
					`kept ${report.restored.join(", ")}: deleted on one device, but edited on another.`,
				),
			);
		}
		if (report.skipped.length > 0) {
			duration = 15_000;
			lines.push((f) =>
				f.appendText(
					`not synced: ${report.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}.`,
				),
			);
		}

		const changed =
			report.pulled.length +
			report.pushed.length +
			report.deletedHere.length +
			report.deletedThere.length +
			report.merged.length;
		let summary: string | null = null;
		if (first) {
			const deleted = [
				report.deletedHere.length > 0 ? `${report.deletedHere.length} deleted here` : null,
				report.deletedThere.length > 0
					? `${report.deletedThere.length} deleted on ${this.host.name}`
					: null,
			].filter(Boolean);
			summary = `in sync with ${this.repoLabel}: ${report.pulled.length} files downloaded, ${report.pushed.length} uploaded, ${report.merged.length} merged${deleted.length > 0 ? `, ${deleted.join(", ")}` : ""}.`;
		} else if (manual) {
			summary =
				changed === 0 ? "up to date." : `synced ${changed} ${changed === 1 ? "file" : "files"}.`;
		}
		if (summary !== null) {
			const text = summary;
			lines.unshift((f) => f.appendText(text));
		}

		if (lines.length === 0) return;
		this.tell((f) => {
			lines.forEach((line, i) => {
				if (i > 0) f.createEl("br");
				line(f);
			});
		}, duration);
	}

	// once a day at most, and once per expiry date: a token that runs out stops every sync
	private async warnOfExpiry(): Promise<void> {
		if (Date.now() - this.expiryChecked < EXPIRY_CHECK_EVERY) return;
		this.expiryChecked = Date.now();
		const expiry = await this.host.tokenExpiry().catch(() => null);
		if (!expiry || expiry.getTime() - Date.now() > EXPIRY_WARNING) return;
		const day = expiry.toISOString().slice(0, 10);
		if (this.device.expiryWarned === day) return;
		this.device.expiryWarned = day;
		this.saveDevice();
		const when = expiry.getTime() < Date.now() ? "expired on" : "expires on";
		new Notice(
			`Easy Git Sync: ${this.tokenName} ${when} ${expiry.toLocaleDateString()}. Create a new one in the settings to keep syncing.`,
			15_000,
		);
	}

	private async recheckConflicts(): Promise<void> {
		if (!this.state) return;
		const still: string[] = [];
		for (const path of this.state.conflicts) {
			const file = this.app.vault.getFileByPath(path);
			if (file && hasConflictMarker(await this.app.vault.cachedRead(file))) still.push(path);
		}
		if (still.length !== this.state.conflicts.length) {
			this.state = { ...this.state, conflicts: still };
			await this.saveState();
		}
		this.render();
	}

	private async recheckConflict(file: TFile): Promise<void> {
		if (!this.state) return;
		const text = await this.app.vault.read(file);
		if (hasConflictMarker(text)) return;
		this.state = { ...this.state, conflicts: this.state.conflicts.filter((p) => p !== file.path) };
		await this.saveState();
		this.render();
	}

	conflictCount(): number {
		return this.state?.conflicts.length ?? 0;
	}

	async resolveAllNewer(): Promise<void> {
		const plan: Array<{ file: TFile; resolved: number }> = [];
		let resolvable = 0;
		let undecided = 0;
		for (const path of this.state?.conflicts ?? []) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) continue;
			const result = resolveAllNewer(await this.app.vault.read(file));
			resolvable += result.resolved;
			undecided += result.skipped;
			if (result.resolved > 0) plan.push({ file, resolved: result.resolved });
		}
		if (resolvable === 0) {
			new Notice(
				undecided > 0
					? "Easy Git Sync: none of the conflicts says which version is newer. Resolve them in the notes."
					: "Easy Git Sync: no conflicts to resolve.",
			);
			return;
		}
		const notes = `${plan.length} ${plan.length === 1 ? "note" : "notes"}`;
		const body = [
			`${resolvable} ${resolvable === 1 ? "conflict" : "conflicts"} in ${notes} will keep the version that was edited last. Both versions are already in ${this.host.name}'s history.`,
		];
		if (undecided > 0) {
			body.push(
				`${undecided} ${undecided === 1 ? "conflict does" : "conflicts do"} not say which version is newer, and ${undecided === 1 ? "stays" : "stay"} as ${undecided === 1 ? "it is" : "they are"}.`,
			);
		}
		const ok = await confirm(this.app, "Keep the newer version everywhere?", body, "Keep newer");
		if (!ok) return;
		await this.flushEditors();
		let done = 0;
		for (const { file } of plan) {
			await this.app.vault.process(file, (text) => {
				const result = resolveAllNewer(text);
				done += result.resolved;
				return result.text;
			});
		}
		await this.recheckConflicts();
		new Notice(
			`Easy Git Sync: kept the newer version in ${done} ${done === 1 ? "place" : "places"}.`,
		);
	}

	private showConflicts(): void {
		new ConflictsModal(
			this.app,
			this.state?.conflicts ?? [],
			(path) => void this.openConflict(path),
		).open();
	}

	private async openConflict(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		const line = view.editor
			.getValue()
			.split("\n")
			.findIndex((l) => /^<{7}(?: |$)/.test(l));
		if (line >= 0) {
			view.editor.setCursor({ line, ch: 0 });
			view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
		}
	}

	private async loadState(): Promise<SyncState> {
		if (this.state?.target === this.target) return this.state;
		const saved = await this.readState(this.target);
		this.savedState = saved?.json ?? null;
		this.state = saved?.state ?? emptyState(this.target);
		return this.state;
	}

	// the state on disk if it belongs to the target; the copy is read only when the file is unreadable
	private async readState(
		target: string,
	): Promise<{ state: SyncState; json: string | null } | null> {
		const adapter = this.app.vault.adapter;
		for (const path of [this.stateFile, `${this.stateFile}.tmp`]) {
			try {
				if (!(await adapter.exists(path))) continue;
				const text = await adapter.read(path);
				const saved = JSON.parse(text) as SyncState;
				if (saved.version !== 1 || saved.target !== target) return null;
				return { state: saved, json: path === this.stateFile ? text : null };
			} catch (error) {
				warn(`reading ${path}`, error);
			}
		}
		return null;
	}

	// copy first: iOS can kill the app mid-write, and loading falls back to the copy
	private async saveState(): Promise<void> {
		if (!this.state) return;
		const json = JSON.stringify(this.state);
		if (json === this.savedState) return;
		await this.app.vault.adapter.write(`${this.stateFile}.tmp`, json);
		await this.app.vault.adapter.write(this.stateFile, json);
		this.savedState = json;
	}

	private setStatus(status: Status): void {
		this.status = status;
		if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
		this.statusTimer = null;
		if (status.kind === "syncing") {
			this.statusTimer = window.setTimeout(() => {
				this.statusTimer = null;
				this.shownStatus = this.status;
				this.render();
			}, 400);
			return;
		}
		this.shownStatus = status;
		this.render();
	}

	private notReadyReason(): string {
		if (this.otherGitPluginEnabled())
			return "paused while the Git plugin is turned on in this vault.";
		if (this.device.provider === "other") {
			if (!this.device.repo) return "enter the repository's address in the settings to start.";
			if (!this.hasToken()) return "enter the login for the repository in the settings to start.";
		}
		if (!this.hasToken())
			return `add ${this.tokenName.replace(/^the /, "a ")} in the settings to start.`;
		if (!this.device.repo) return "choose a repository in the settings to start.";
		if (!this.device.started) return 'press "Start syncing" in the settings.';
		return this.blocked ?? "not ready.";
	}

	statusDescription(): string {
		const s = this.status;
		const conflicts = this.state?.conflicts.length ?? 0;
		const suffix =
			conflicts > 0
				? ` ${conflicts} ${conflicts === 1 ? "note has" : "notes have"} a conflict to look at.`
				: "";
		if (!this.ready() && s.kind !== "syncing")
			return `Not syncing: ${this.notReadyReason()}${suffix}`;
		switch (s.kind) {
			case "syncing":
				return `${s.text}...`;
			case "offline":
				return `${this.hostName} cannot be reached. Changes sync once it can.${suffix}`;
			case "error":
			case "paused":
			case "setup":
				return `${s.text}${suffix}`;
			case "idle":
				return this.lastSynced
					? `Last synced at ${this.lastSynced.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.${suffix}`
					: `Not synced yet this session.${suffix}`;
		}
	}

	private render(): void {
		const conflicts = this.state?.conflicts.length ?? 0;
		const s = this.shownStatus;
		let icon = "check";
		let text = "Synced";
		if (!this.ready() && s.kind !== "syncing") {
			icon = "pause";
			text = this.device.started ? "Sync paused" : "Sync not set up";
		} else if (s.kind === "syncing") {
			icon = "refresh-cw";
			text = s.text;
		} else if (s.kind === "paused") {
			icon = "pause";
			text = "Sync waiting";
		} else if (s.kind === "offline") {
			icon = "wifi-off";
			text = "Offline";
		} else if (s.kind === "error") {
			icon = "alert-triangle";
			text = "Sync error";
		}
		if (conflicts > 0 && s.kind !== "syncing") {
			icon = "git-merge";
			text = `${conflicts} ${conflicts === 1 ? "conflict" : "conflicts"}`;
		}
		if (this.statusEl) {
			this.statusEl.empty();
			setIcon(this.statusEl.createSpan({ cls: "easy-git-sync-status-icon" }), icon);
			this.statusEl.createSpan({ text });
			this.statusEl.setAttr("aria-label", `${this.connectionLabel()}. ${this.statusDescription()}`);
			this.statusEl.toggleClass("is-syncing", s.kind === "syncing");
		}
		if (this.ribbonEl) {
			this.ribbonEl.toggleClass("is-syncing", s.kind === "syncing");
			this.ribbonEl.toggleClass("has-problem", s.kind === "error" || this.blocked !== null);
			this.ribbonEl.toggleClass("has-conflicts", conflicts > 0);
			this.ribbonEl.setAttr("aria-label", `${this.connectionLabel()}. ${this.statusDescription()}`);
		}
		this.settingTab?.refreshConnection();
	}

	private showMenu(event: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) => item.setTitle(this.connectionLabel()).setIsLabel(true));
		menu.addItem((item) => item.setTitle(this.statusDescription()).setIsLabel(true));
		menu.addItem((item) =>
			item
				.setTitle("Sync now")
				.setIcon("refresh-cw")
				.onClick(() => void this.syncNow("manual")),
		);
		const conflicts = this.state?.conflicts.length ?? 0;
		if (conflicts > 0) {
			menu.addItem((item) =>
				item
					.setTitle(`Show conflicts (${conflicts})`)
					.setIcon("git-merge")
					.onClick(() => this.showConflicts()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Resolve all with the newer version")
					.setIcon("history")
					.onClick(() => void this.resolveAllNewer()),
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Settings")
				.setIcon("settings")
				.onClick(() => {
					const setting = (
						this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }
					).setting;
					setting?.open();
					setting?.openTabById(this.manifest.id);
				}),
		);
		menu.showAtMouseEvent(event);
	}
}

function readOnly(provider: Host["id"], repo: string): string {
	switch (provider) {
		case "github":
			return `the token can read ${repo} but not write to it. Give it "Contents: Read and write" for this repository.`;
		case "gitlab":
			return `the token can read ${repo} but not write to it. It needs the write_repository scope, and you need the Developer role or higher on the project.`;
		case "bitbucket":
			return `the token can read ${repo} but not write to it. It needs the write:repository scope, and you need write access to the repository.`;
		case "forgejo":
			return `the token can read ${repo} but not write to it. Give it "Read and write" on repository, and check that you can push to it.`;
		case "other":
			return `the login can read ${repo} but not write to it.`;
	}
}

// in memory only; the token is part of the key so a new paste never reads an old answer
function lookupKey({ provider, server, username }: Connection, token: string | null): string {
	return JSON.stringify([provider, server, username, token]);
}

function connectionOf({ provider, server, username }: Connection): Connection {
	return { provider, server, username };
}

// GitHub's targets keep their old form, so an existing state stays valid
function targetOf(t: {
	provider: ProviderId;
	server: string;
	repo: string | null;
	branch: string;
}) {
	const { provider, server, repo, branch } = t;
	if (provider === "github") return `${repo}@${branch}`;
	const where = provider === "other" ? "" : `${server.replace(/^https?:\/\//, "")}/`;
	return `${provider}:${where}${repo}@${branch}`;
}

// a URL reads long in a sentence, so another git server is named by its path
function repoLabelOf(provider: ProviderId, repo: string): string {
	if (provider !== "other") return repo;
	try {
		return new URL(repo).pathname.replace(/^\/+|\.git$/g, "") || repo;
	} catch {
		return repo;
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function warn(what: string, error: unknown): void {
	console.warn(`Easy Git Sync: ${what} failed:`, error);
}
