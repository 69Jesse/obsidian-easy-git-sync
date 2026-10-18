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
import { ObsidianFs } from "./local-fs";
import { GitLockstep } from "./lockstep";
import { hasConflictMarker, resolveAllNewer } from "./merge/conflict";
import { ConflictsModal, chooseFirstSync, confirm, pickBranch } from "./modals";
import { conflictPostProcessor } from "./reading";
import { GitHubClient, GitHubError, GitHubRemote } from "./remote/github";
import { type Http, OfflineError } from "./remote/http";
import {
	type DeviceSettings,
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
// a full scan even when GitHub has nothing new, to catch edits in the config folder
const FULL_SYNC_EVERY = 10 * 60_000;
const OWN_WRITE_ECHO = 5_000;

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
	client!: GitHubClient;
	private fs!: ObsidianFs;
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
		this.client = new GitHubClient(
			obsidianHttp,
			() => this.token(),
			(ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
		);

		this.addSettingTab(new EasyGitSyncSettingTab(this.app, this));
		this.registerEditorExtension(conflictEditorExtension());
		this.registerMarkdownPostProcessor(conflictPostProcessor(this.app));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("easy-git-sync-status", "mod-clickable");
		this.registerDomEvent(this.statusEl, "click", (event) => this.showMenu(event));
		this.ribbonEl = this.addRibbonIcon(
			"refresh-cw",
			"Sync with GitHub",
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
		this.addCommand({
			id: "open-on-github",
			name: "Open this note on GitHub",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.device.repo) return false;
				if (!checking) {
					const path = file.path.split("/").map(encodeURIComponent).join("/");
					window.open(
						`https://github.com/${this.device.repo}/blob/${encodeURIComponent(this.device.branch)}/${path}`,
					);
				}
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
			repo: null,
			branch: "main",
			deviceName: defaultDeviceName(),
			started: false,
			...(saved ?? {}),
		};
	}

	saveDevice(): void {
		this.app.saveLocalStorage(DEVICE_KEY, this.device);
	}

	// per vault, in case the keychain is shared: two vaults must not overwrite each other's token
	private get tokenId(): string {
		const appId = (this.app as unknown as { appId?: string }).appId;
		const suffix = (appId ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
		return suffix ? `${TOKEN_SECRET}-${suffix}` : TOKEN_SECRET;
	}

	token(): string | null {
		return this.app.secretStorage.getSecret(this.tokenId) || null;
	}

	hasToken(): boolean {
		return this.token() !== null;
	}

	setToken(token: string): void {
		this.app.secretStorage.setSecret(this.tokenId, token);
		this.blocked = null;
		this.render();
	}

	otherGitPluginEnabled(): boolean {
		const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
		return plugins?.enabledPlugins?.has("obsidian-git") ?? false;
	}

	remote(): GitHubRemote | null {
		return this.device.repo
			? new GitHubRemote(
					this.client,
					this.device.repo,
					this.device.branch,
					this.settings.commitAsAccount,
				)
			: null;
	}

	private get target(): string {
		return `${this.device.repo}@${this.device.branch}`;
	}

	private get stateFile(): string {
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return `${dir}/state.json`;
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

	async selectRepo(fullName: string): Promise<void> {
		let repo: Awaited<ReturnType<GitHubClient["repo"]>>;
		try {
			repo = await this.client.repo(fullName);
		} catch (error) {
			new Notice(`Easy Git Sync: could not open ${fullName}. ${describe(error)}`);
			return;
		}
		if (!repo.canPush) {
			new Notice(
				`Easy Git Sync: the token can read ${repo.fullName} but not write to it. Give it "Contents: Read and write" for this repository.`,
				10_000,
			);
			return;
		}
		let branch = repo.defaultBranch;
		if (!repo.empty) {
			const branches = await this.client
				.branches(repo.fullName, repo.defaultBranch)
				.catch(() => [repo.defaultBranch]);
			if (branches.length > 1) {
				const picked = await pickBranch(this.app, repo.fullName, branches, repo.defaultBranch);
				if (picked === null) return;
				branch = picked;
			}
		}
		// an empty base would merge every differing note as if both sides created it
		if (`${repo.fullName}@${branch}` === this.target) return;
		const { firstSync: _, ...device } = this.device;
		this.device = {
			...device,
			repo: repo.fullName,
			branch,
			started: false,
		};
		this.saveDevice();
		this.state = emptyState(this.target);
		await this.saveState();
		this.lockstep = undefined;
		this.blocked = null;
		this.render();
	}

	async start(): Promise<void> {
		if (this.otherGitPluginEnabled()) {
			new Notice("Easy Git Sync: turn off the Git plugin on this device first.");
			return;
		}
		this.setStatus({ kind: "syncing", text: "Comparing with GitHub" });
		let summary: Awaited<ReturnType<typeof preview>>;
		try {
			summary = await preview(await this.loadState(), this.syncOptions(false));
		} catch (error) {
			this.setStatus({ kind: "error", text: describe(error) });
			new Notice(`Easy Git Sync: ${describe(error)}`);
			return;
		}
		this.setStatus({ kind: "idle" });
		const repo = this.device.repo ?? "";
		// asked only when both sides have notes that differ: a fresh phone never offers to wipe GitHub
		const hereOnly = summary.upload;
		const thereOnly = summary.download;
		const { notes } = summary;
		let firstSync: FirstSync = "merge";
		if (!summary.emptyRemote && notes.here > 0 && notes.there > 0 && notes.differ > 0) {
			const chosen = await chooseFirstSync(this.app, {
				repo,
				same: summary.same,
				upload: hereOnly,
				download: thereOnly,
				merge: summary.merge,
				newest: this.settings.conflicts === "newest",
			});
			if (chosen === null) return;
			firstSync = chosen;
		} else {
			const lines = summary.emptyRemote
				? [`${repo} is empty. This vault becomes its first commit: ${summary.upload} files.`]
				: [
						`Already the same on both sides: ${summary.same} files.`,
						`Only in this vault, to upload: ${summary.upload}.`,
						`Only on GitHub, to download: ${summary.download}.`,
					];
			const ok = await confirm(this.app, `Start syncing with ${repo}?`, lines, "Start syncing");
			if (!ok) return;
		}
		this.device.started = true;
		this.device.firstSync = firstSync;
		this.saveDevice();
		this.reschedule();
		await this.syncNow("manual");
	}

	async disconnect(): Promise<void> {
		this.app.secretStorage.setSecret(this.tokenId, "");
		this.device = {
			repo: null,
			branch: "main",
			deviceName: this.device.deviceName,
			started: false,
		};
		this.saveDevice();
		this.state = null;
		this.savedState = null;
		for (const path of [this.stateFile, `${this.stateFile}.tmp`]) {
			if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
		}
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
						this.device.repo,
						this.device.branch,
						() => this.token(),
						this.stateFile,
					)
				: null;
		}
		return this.lockstep;
	}

	private async confirmMassDelete(error: MassDeleteError): Promise<void> {
		const where = [
			error.here > 0 ? `${error.here} files in this vault` : null,
			error.there > 0 ? `${error.there} files on GitHub` : null,
		]
			.filter(Boolean)
			.join(" and ");
		const ok = await confirm(
			this.app,
			"Delete most of the vault?",
			[
				`This sync would delete ${where}. That is usually a vault that did not finish loading, a moved folder, or an emptied repository, not something done on purpose.`,
				"Nothing is deleted until you confirm. Deleted files stay in GitHub's history either way.",
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
				this.tell("GitHub cannot be reached. Changes sync once it can.", 6_000);
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
			error instanceof GitHubError &&
			(error.kind === "auth" || error.kind === "not-found" || error.kind === "forbidden")
		) {
			this.blocked =
				error.kind === "auth"
					? "GitHub did not accept the token. It may have expired or been revoked: create a new one in the settings."
					: `${this.device.repo}: ${message} Check that the token still has access to it.`;
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
				f.appendText(". The other version is in GitHub's history.");
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
				report.deletedThere.length > 0 ? `${report.deletedThere.length} deleted on GitHub` : null,
			].filter(Boolean);
			summary = `in sync with ${this.device.repo}: ${report.pulled.length} files downloaded, ${report.pushed.length} uploaded, ${report.merged.length} merged${deleted.length > 0 ? `, ${deleted.join(", ")}` : ""}.`;
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
			`${resolvable} ${resolvable === 1 ? "conflict" : "conflicts"} in ${notes} will keep the version that was edited last. Both versions are already in GitHub's history.`,
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
		let state = emptyState(this.target);
		for (const path of [this.stateFile, `${this.stateFile}.tmp`]) {
			try {
				if (!(await this.app.vault.adapter.exists(path))) continue;
				const text = await this.app.vault.adapter.read(path);
				const saved = JSON.parse(text) as SyncState;
				if (saved.version === 1 && saved.target === this.target) {
					state = saved;
					this.savedState = path === this.stateFile ? text : null;
				}
				break;
			} catch (error) {
				warn(`reading ${path}`, error);
			}
		}
		this.state = state;
		return state;
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
		if (!this.hasToken()) return "add a GitHub token in the settings to start.";
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
				return `GitHub cannot be reached. Changes sync once it can.${suffix}`;
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
			this.statusEl.setAttr("aria-label", this.statusDescription());
			this.statusEl.toggleClass("is-syncing", s.kind === "syncing");
		}
		if (this.ribbonEl) {
			this.ribbonEl.toggleClass("is-syncing", s.kind === "syncing");
			this.ribbonEl.toggleClass("has-problem", s.kind === "error" || this.blocked !== null);
			this.ribbonEl.toggleClass("has-conflicts", conflicts > 0);
			this.ribbonEl.setAttr("aria-label", `Sync with GitHub. ${this.statusDescription()}`);
		}
	}

	private showMenu(event: MouseEvent): void {
		const menu = new Menu();
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

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function warn(what: string, error: unknown): void {
	console.warn(`Easy Git Sync: ${what} failed:`, error);
}
