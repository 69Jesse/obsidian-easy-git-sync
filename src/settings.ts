import {
	type App,
	type ButtonComponent,
	Notice,
	Platform,
	PluginSettingTab,
	type Setting,
	type SettingDefinitionItem,
	type SettingGroupItem,
} from "obsidian";
import type { default as EasyGitSync, Lookup } from "./main";
import { confirm, RepoPickerModal } from "./modals";
import {
	type Connection,
	DEFAULT_SERVERS,
	normalizeServer,
	PROVIDERS,
	type ProviderId,
} from "./remote/hosts";
import type { ConflictStrategy, FirstSync } from "./sync/engine";

// in data.json, so the same on every device: a clash must settle alike wherever it is synced
export interface EasyGitSyncSettings {
	// both in seconds, 0 is only on demand
	syncAfterEdit: number;
	checkInterval: number;
	commitAsAccount: boolean;
	conflicts: ConflictStrategy;
}

// only known keys are kept, so a removed setting drops out of data.json on the next save
export function parseSettings(saved: Partial<EasyGitSyncSettings> | null): EasyGitSyncSettings {
	const { syncAfterEdit, checkInterval, commitAsAccount, conflicts } = Object.assign(
		{},
		DEFAULT_SETTINGS,
		saved,
	);
	return {
		syncAfterEdit,
		checkInterval,
		commitAsAccount,
		conflicts: conflicts === "newest" ? "newest" : "keep-both",
	};
}

export const DEFAULT_SETTINGS: EasyGitSyncSettings = {
	syncAfterEdit: 30,
	checkInterval: 60,
	commitAsAccount: true,
	conflicts: "keep-both",
};

// in local storage, not data.json: a fresh phone needs these before it has synced anything
export interface DeviceSettings {
	provider: ProviderId;
	// GitLab's or Forgejo's server; empty for the default one
	server: string;
	// another git server only
	username: string;
	// the full name, or for another git server its URL
	repo: string | null;
	branch: string;
	deviceName: string;
	started: boolean;
	// kept until a sync completes, so a retried first sync does not turn into a merge
	firstSync?: FirstSync;
	// the expiry date last warned about, so the warning shows once
	expiryWarned?: string;
	// the login at connecting, so the settings name it before any request
	account?: string;
}

// a connection being filled in, kept in memory: nothing live changes until it is committed
export interface Draft extends Connection {
	// typed but not saved; null uses the one saved for this provider and server
	token: string | null;
	repo: string | null;
	branch: string;
	// whether repo and branch were checked against the host; a typed address is not yet
	checked: boolean;
}

export function defaultDeviceName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
	if (Platform.isMacOS) return "Mac";
	return Platform.isWin ? "Windows PC" : "Linux PC";
}

// keys end in "s": a record puts integer-like keys first in numeric order, "Only when I ask" on top
const SYNC_AFTER_EDIT: Record<string, string> = {
	"10s": "10 seconds",
	"30s": "30 seconds",
	"60s": "1 minute",
	"300s": "5 minutes",
	"0s": "Only when I ask",
};

const CHECK_INTERVAL: Record<string, string> = {
	"30s": "30 seconds",
	"60s": "1 minute",
	"300s": "5 minutes",
	"900s": "15 minutes",
	"0s": "Only when I ask",
};

const CONFLICTS: Record<ConflictStrategy, string> = {
	"keep-both": "Keep both, marked",
	newest: "Keep the newer version",
};

// text and code alternate: every second part is a name exactly as that host's token form shows it
const TOKEN_HELP: Record<Exclude<ProviderId, "other">, string[]> = {
	github: [
		"A fine-grained token with the ",
		"Read and write",
		" permission on ",
		"Contents",
		", under ",
		"Repositories",
		". The button opens GitHub's form with this already filled in.",
	],
	gitlab: [
		"A personal access token with the scopes ",
		"read_api",
		" and ",
		"write_repository",
		". The button opens GitLab's form with these already filled in.",
	],
	bitbucket: [
		"An API token with scopes, for the Bitbucket app: ",
		"read:user:bitbucket",
		", ",
		"read:workspace:bitbucket",
		", ",
		"read:repository:bitbucket",
		" and ",
		"write:repository:bitbucket",
		". The button opens Atlassian's token page: choose ",
		"Create API token with scopes",
		".",
	],
	forgejo: [
		"An access token with ",
		"Read and write",
		" on ",
		"repository",
		" and ",
		"Read",
		" on ",
		"user",
		". The button opens the server's token form, filled in where the server allows it.",
	],
};

const TOKEN_PLACEHOLDER: Record<ProviderId, string> = {
	github: "github_pat_...",
	gitlab: "glpat-...",
	bitbucket: "ATATT...",
	forgejo: "",
	other: "",
};

const LINK_HELP: Partial<Record<ProviderId, string>> = {
	github: "Turn this off to keep syncs off your contribution graph.",
	gitlab:
		"Commits use your private GitLab commit address. Turn this off to keep syncs off your activity.",
	forgejo:
		"Commits use your account's no-reply address. Turn this off to keep syncs off your activity.",
};

// how the settings name the host: GitHub, GitLab at git.example.com, Codeberg, or the server's address
function whereOf(device: DeviceSettings): string {
	const hostOf = (url: string) => {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	};
	switch (device.provider) {
		case "github":
			return "GitHub";
		case "bitbucket":
			return "Bitbucket";
		case "gitlab":
			return device.server ? `GitLab at ${hostOf(device.server)}` : "GitLab";
		case "forgejo":
			return device.server && hostOf(device.server) !== "codeberg.org"
				? hostOf(device.server)
				: "Codeberg";
		case "other":
			return device.repo ? hostOf(device.repo) : "another git server";
	}
}

export class EasyGitSyncSettingTab extends PluginSettingTab {
	private connectionSetting: Setting | null = null;
	// the draft's fields are shown; leaving the settings folds them away, keeping what was typed
	private draftOpen = false;
	// a token's access can grow without the token changing, so showing the fields asks again
	private revalidate = true;
	private tokenSetting: Setting | null = null;
	private accountLine: HTMLElement | null = null;
	private chooseButton: ButtonComponent | null = null;
	private repoSetting: Setting | null = null;
	private commitButton: ButtonComponent | null = null;
	private hintEl: HTMLElement | null = null;
	private tokenTimer: number | undefined;
	// a slow failing check must not overwrite a newer result
	private checkId = 0;

	constructor(
		app: App,
		private readonly plugin: EasyGitSync,
	) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		const host = plugin.host;
		// not connected, the setup is the draft: there is nothing live to keep apart from it
		if (!plugin.device.started) plugin.beginDraft();
		const linkHelp = LINK_HELP[host.id];
		return [
			{
				type: "group",
				heading: "Connection",
				items: [
					{
						name: "Connection",
						aliases: ["Sync now", "Change connection", "Repository", "Account"],
						render: (setting) => this.renderConnection(setting),
					},
					...this.draftItems(),
				],
			},
			{
				type: "group",
				heading: "Syncing",
				items: [
					{
						name: "Sync after editing",
						desc: "How long after you stop typing to upload changes.",
						control: { type: "dropdown", key: "syncAfterEdit", options: SYNC_AFTER_EDIT },
					},
					{
						name: "Check for changes",
						desc: "How often to look for changes from other devices. It also looks on startup and when you return to Obsidian.",
						control: { type: "dropdown", key: "checkInterval", options: CHECK_INTERVAL },
					},
					{
						name: "Merge conflicts",
						desc: `When a note changed in the same place on two devices. Changes in different places always merge, and the version not kept stays in ${host.name}'s history.`,
						control: { type: "dropdown", key: "conflicts", options: CONFLICTS },
					},
					{
						name: "Resolve all conflicts",
						visible: () => plugin.conflictCount() > 0,
						render: (setting) => this.renderResolve(setting),
					},
					// synced, so it stays put when this device uses a host that cannot link commits
					{
						name: host.name.startsWith("the ")
							? `Link commits to your account on ${host.name}`
							: `Link commits to your ${host.name} account`,
						desc: linkHelp ?? "",
						visible: host.linksAccounts && linkHelp !== undefined,
						control: { type: "toggle", key: "commitAsAccount" },
					},
				],
			},
			{
				type: "group",
				heading: "This device",
				items: [
					{
						name: "This device's name",
						desc: "Used in commits and conflict blocks.",
						control: { type: "text", key: "deviceName" },
					},
					{
						name: "Disconnect this device",
						visible: () => plugin.device.started || plugin.hasToken(),
						render: (setting) => this.renderDisconnect(setting),
					},
				],
			},
		];
	}

	// the dropdowns hold "30s" for 30, and the device name lives in device settings
	override getControlValue(key: string): unknown {
		const { settings, device } = this.plugin;
		switch (key) {
			case "syncAfterEdit":
			case "checkInterval":
				return `${settings[key]}s`;
			case "deviceName":
				return device.deviceName;
			default:
				return settings[key as keyof EasyGitSyncSettings];
		}
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const plugin = this.plugin;
		switch (key) {
			case "syncAfterEdit":
			case "checkInterval":
				plugin.settings[key] = Number.parseInt(String(value), 10) || 0;
				break;
			case "conflicts":
				plugin.settings.conflicts = value === "newest" ? "newest" : "keep-both";
				break;
			case "commitAsAccount":
				plugin.settings.commitAsAccount = value === true;
				break;
			case "deviceName":
				plugin.device.deviceName = String(value).trim() || defaultDeviceName();
				plugin.saveDevice();
				return;
			default:
				return;
		}
		await plugin.saveSettings();
		if (key === "checkInterval") plugin.reschedule();
	}

	override hide(): void {
		const folding = this.draftOpen;
		this.draftOpen = false;
		this.revalidate = true;
		super.hide();
		// reopening renders the definitions of the last update(), draft rows included
		if (folding) this.update();
	}

	private renderConnection(setting: Setting): void {
		const plugin = this.plugin;
		this.connectionSetting = setting;
		if (plugin.device.started) {
			setting
				.addButton((button) =>
					button
						.setButtonText(this.draftOpen && plugin.draft ? "Cancel change" : "Change connection")
						.onClick(() => {
							if (this.draftOpen && plugin.draft) {
								plugin.cancelDraft();
								this.draftOpen = false;
							} else {
								plugin.beginDraft();
								this.draftOpen = true;
								this.revalidate = true;
							}
							this.update();
						}),
				)
				.addButton((button) =>
					button.setButtonText("Sync now").onClick(() => void plugin.syncNow("manual")),
				);
		}
		this.refreshConnection();
		void plugin.refreshAccount();
	}

	// what this device syncs with right now; redrawn on every status change while it is shown
	refreshConnection(): void {
		const row = this.connectionSetting;
		if (!row?.settingEl.isConnected) return;
		const plugin = this.plugin;
		const device = plugin.device;
		row.nameEl.empty();
		row.nameEl.createSpan({ cls: `easy-git-sync-dot is-${plugin.health()}` });
		row.nameEl.appendText(device.started ? `Connected to ${plugin.repoLabel}` : "Not connected");
		row.descEl.empty();
		if (!device.started) {
			row.descEl.setText(
				plugin.otherGitPluginEnabled()
					? "Turn off the Git plugin on this device first: two plugins syncing one vault would fight."
					: "Fill in the connection below to start syncing.",
			);
			return;
		}
		const login =
			device.provider === "other" ? device.username : device.account ? `@${device.account}` : "";
		row.descEl.createDiv({
			text: `On ${whereOf(device)}${login ? ` as ${login}` : ""}, branch ${device.branch}.`,
		});
		row.descEl.createDiv({ text: plugin.statusDescription() });
	}

	private renderResolve(setting: Setting): void {
		const plugin = this.plugin;
		const conflicts = plugin.conflictCount();
		setting
			.setDesc(
				conflicts === 1
					? "1 note still has a conflict. Keep the newer version in it."
					: `${conflicts} notes still have a conflict. Keep the newer version in every one of them.`,
			)
			.addButton((button) =>
				button.setButtonText("Keep newer").onClick(async () => {
					await plugin.resolveAllNewer();
					this.update();
				}),
			);
	}

	private renderDisconnect(setting: Setting): void {
		const plugin = this.plugin;
		const login = plugin.device.provider === "other" ? "password" : "token";
		setting
			.setDesc(
				`Forgets the ${login}, repository and sync history here. Your notes are not touched.`,
			)
			.addButton((button) =>
				button
					.setButtonText("Disconnect")
					.setDestructive()
					.onClick(async () => {
						const ok = await confirm(
							this.app,
							"Disconnect this device?",
							[
								plugin.device.started
									? `This device stops syncing with ${plugin.repoLabel} and forgets its ${login} and sync history. Your notes are not touched.`
									: `This device forgets its ${login}. Your notes are not touched.`,
							],
							"Disconnect",
							true,
						);
						if (!ok) return;
						await plugin.disconnect();
						new Notice("Easy Git Sync: this device is disconnected.");
						this.update();
					}),
			);
	}

	// built from the draft as it is now; a change to its shape (provider, server) calls update()
	private draftItems(): SettingGroupItem[] {
		const plugin = this.plugin;
		const draft = plugin.draft;
		if (!draft || !(this.draftOpen || !plugin.device.started)) return [];
		const items: SettingGroupItem[] = [
			{
				name: "Provider",
				desc: "Where the repository is.",
				render: (setting) => this.renderProvider(setting, draft),
			},
		];
		if (draft.provider === "gitlab" || draft.provider === "forgejo") {
			items.push({
				name: "Server",
				desc:
					draft.provider === "gitlab"
						? "Empty for gitlab.com, or the address of your own GitLab."
						: "Empty for codeberg.org, or the address of your Forgejo or Gitea server.",
				render: (setting) => this.renderServer(setting, draft),
			});
		}
		if (draft.provider === "other") {
			items.push(
				{
					name: "Username",
					desc: "The login for the repository.",
					render: (setting) => this.renderUsername(setting, draft),
				},
				{
					name: "Password",
					render: (setting) => this.renderPassword(setting, draft),
				},
				{
					name: "Repository",
					render: (setting) => this.renderAddress(setting, draft),
				},
			);
		} else {
			items.push(
				{
					name: "Access token",
					render: (setting) => this.renderToken(setting, draft),
				},
				{
					name: "Repository",
					render: (setting) => this.renderRepository(setting, draft),
				},
			);
		}
		items.push({
			name: "",
			searchable: false,
			render: (setting) => this.renderCommit(setting),
		});
		return items;
	}

	private renderProvider(setting: Setting, draft: Draft): void {
		const plugin = this.plugin;
		setting.addDropdown((dropdown) =>
			dropdown
				.addOptions(PROVIDERS)
				.setValue(draft.provider)
				.onChange((value) => {
					plugin.setDraftConnection({ provider: value as ProviderId, server: "", username: "" });
					this.update();
				}),
		);
	}

	private renderServer(setting: Setting, draft: Draft): void {
		const plugin = this.plugin;
		const fallback = DEFAULT_SERVERS[draft.provider] ?? "";
		setting.addText((text) => {
			text.setPlaceholder(fallback.replace(/^https:\/\//, "")).setValue(draft.server);
			// applied once the field is left: a new server means a new token and repository
			text.inputEl.addEventListener("change", () => {
				const value = text.getValue().trim();
				const server = value && normalizeServer(value) !== fallback ? normalizeServer(value) : "";
				plugin.setDraftConnection({ server });
				this.update();
			});
		});
	}

	private renderToken(setting: Setting, draft: Draft): void {
		const plugin = this.plugin;
		const host = plugin.draftHost();
		if (!host) return;
		const help = TOKEN_HELP[host.id as Exclude<ProviderId, "other">];
		setting
			.setDesc(
				createFragment((desc) => {
					help.forEach((part, i) => {
						if (i % 2 === 1) desc.createEl("code", { text: part });
						else desc.appendText(part);
					});
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				if (draft.token) text.setValue(draft.token);
				text
					.setPlaceholder(TOKEN_PLACEHOLDER[host.id])
					.onChange((value) => this.onLoginTyped(value, true));
			})
			.addButton((button) =>
				button
					.setButtonText(
						host.id === "bitbucket" ? "Create token on Atlassian" : `Create token on ${host.name}`,
					)
					.onClick(async () => {
						const url = await host.tokenUrl();
						if (url) window.open(url);
					}),
			);
		// whether a token is saved goes in the description: a placeholder vanishes on paste
		setting.settingEl.addClass("easy-git-sync-token-setting");
		this.tokenSetting = setting;
		this.accountLine = setting.descEl.createDiv();
		void this.checkAccount();
	}

	private renderRepository(setting: Setting, draft: Draft): void {
		const plugin = this.plugin;
		this.repoSetting = setting;
		setting
			.setDesc(
				draft.repo
					? `${draft.repo}, branch ${draft.branch}.`
					: "The repository this vault syncs with. It can be empty or already hold the vault.",
			)
			.addButton((button) => {
				this.chooseButton = button;
				button.setButtonText(draft.repo ? "Change" : "Choose").onClick(() => {
					// a list older than a minute shows while a fresh one loads, for a repository just made
					const fresh = plugin.draftLookup(60_000)?.then((found) => found.repos);
					if (!fresh) return;
					const cached = plugin.peekDraftLookup()?.repos ?? null;
					new RepoPickerModal(this.app, cached, fresh, async (fullName) => {
						if (await plugin.pickDraftRepo(fullName)) this.update();
					}).open();
				});
			});
	}

	// another git server: its address and a login, and no account to list repositories from
	private renderUsername(setting: Setting, draft: Draft): void {
		const plugin = this.plugin;
		setting.addText((text) => {
			text.setValue(draft.username);
			text.inputEl.autocomplete = "off";
			text.inputEl.addEventListener("change", () => {
				plugin.setDraftConnection({ username: text.getValue().trim() });
				this.update();
			});
		});
	}

	private renderPassword(setting: Setting, draft: Draft): void {
		setting
			.setDesc(
				"Its password, or an access token if the server issues them. Kept in this device's keychain, never synced.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				if (draft.token) text.setValue(draft.token);
				text.onChange((value) => this.onLoginTyped(value, false));
			});
		this.accountLine = setting.descEl.createDiv();
		this.showPasswordLine();
	}

	private renderAddress(setting: Setting, draft: Draft): void {
		const plugin = this.plugin;
		setting
			.setDesc(
				draft.repo && draft.checked
					? `${draft.repo}, branch ${draft.branch}.`
					: "Its address over HTTPS, as you would clone it. SSH addresses cannot work: phones cannot use SSH.",
			)
			.addText((text) => {
				text.setPlaceholder("https://git.example.com/me/vault.git").setValue(draft.repo ?? "");
				text.onChange((value) => {
					const current = plugin.draft;
					if (!current) return;
					const url = value.trim();
					if (url === current.repo) return;
					current.repo = url || null;
					// checked on Start syncing, which also asks for the branch when there are several
					current.checked = false;
					this.refreshDraft();
				});
			});
	}

	private renderCommit(setting: Setting): void {
		const plugin = this.plugin;
		setting.settingEl.addClass("easy-git-sync-draft-footer");
		this.hintEl = setting.descEl;
		setting.addButton((button) => {
			this.commitButton = button;
			button.setCta().onClick(async () => {
				const current = plugin.draft;
				if (current?.provider === "other" && !/^https?:\/\//i.test(current.repo ?? "")) {
					new Notice("Easy Git Sync: enter the repository's address, starting with https://.");
					return;
				}
				button.setDisabled(true);
				await plugin.commitDraft();
				this.update();
			});
		});
		this.refreshDraft();
	}

	// the parts that follow what is typed, without redrawing the field being typed in
	private refreshDraft(): void {
		const plugin = this.plugin;
		const draft = plugin.draft;
		if (!draft) return;
		const login = plugin.draftHasLogin();
		const change = plugin.draftChange();
		const word = draft.provider === "other" ? "login" : "token";
		this.chooseButton?.setDisabled(!login);
		this.commitButton
			?.setButtonText(change === "login" ? `Save ${word}` : "Start syncing")
			.setDisabled(!login || !draft.repo || change === "none");
		const live = `${plugin.repoLabel} on ${plugin.host.name}`;
		let hint: string;
		if (!plugin.device.started) {
			hint = "Start syncing shows what will happen before anything syncs.";
		} else if (change === "none") {
			hint = `Nothing changed yet. This device keeps syncing with ${live}.`;
		} else if (change === "login") {
			hint = `Keeps syncing with ${live} and its sync history, with the new ${word}.`;
		} else {
			hint = `This device keeps syncing with ${live} until you press Start syncing. That compares this vault with the new repository first, and its sync history starts over.`;
		}
		this.hintEl?.setText(hint);
	}

	// held in the draft until committed, so a wrong paste never replaces the working token
	private onLoginTyped(value: string, trim: boolean): void {
		window.clearTimeout(this.tokenTimer);
		this.tokenTimer = window.setTimeout(() => {
			const draft = this.plugin.draft;
			if (!draft) return;
			const token = trim ? value.trim() : value;
			draft.token = token || null;
			if (draft.provider === "other") this.showPasswordLine();
			else void this.checkAccount();
			this.refreshDraft();
		}, 600);
	}

	private showPasswordLine(): void {
		const line = this.accountLine;
		if (!line) return;
		const plugin = this.plugin;
		line.setText(
			plugin.draft?.token
				? "A new password is entered. It is saved when you press the button below."
				: plugin.draftSavedToken()
					? "A password is saved."
					: "",
		);
	}

	private async checkAccount(): Promise<void> {
		const line = this.accountLine;
		const setting = this.tokenSetting;
		const plugin = this.plugin;
		const draft = plugin.draft;
		if (!line || !setting || !draft || !plugin.draftHost()) return;
		setting.setErrorMessage(null);
		if (!plugin.draftHasLogin()) {
			line.setText("");
			return;
		}
		const typed = draft.token !== null;
		const id = ++this.checkId;
		// redraws in between, such as after picking a repository, use the answer just fetched
		const maxAge = this.revalidate ? 0 : undefined;
		this.revalidate = false;
		const show = ({ account, repos, expiry }: Lookup) => {
			const who = typed
				? `The new token is for @${account.login}`
				: `A token is saved for @${account.login}`;
			// the same count the repository picker shows
			const count = repos.filter((repo) => repo.canPush).length;
			const until = expiry ? ` It expires on ${expiry.toLocaleDateString()}.` : "";
			if (count === 0) {
				line.setText(`${who}.${until}`);
				setting.setErrorMessage("It cannot write to any repository.");
				return;
			}
			setting.setErrorMessage(null);
			line.setText(
				`${who}. ${count} ${count === 1 ? "repository" : "repositories"} available.${until}`,
			);
		};
		const cached = plugin.peekDraftLookup();
		if (cached) show(cached);
		else line.setText("Checking the token...");
		try {
			const found = await plugin.draftLookup(maxAge);
			if (!found || id !== this.checkId) return;
			show(found);
			await this.prefill(found);
		} catch (error) {
			if (id !== this.checkId) return;
			line.setText("");
			setting.setErrorMessage(error instanceof Error ? error.message : String(error));
		}
	}

	// one repository the token can write to, with one branch: nothing to choose, so it is filled in
	private async prefill(found: Lookup): Promise<void> {
		const plugin = this.plugin;
		const writable = found.repos.filter((repo) => repo.canPush);
		const only = writable.length === 1 ? writable[0] : undefined;
		if (!only || plugin.draft?.repo !== null) return;
		if (!(await plugin.pickDraftRepo(only.fullName, true))) return;
		const draft = plugin.draft;
		if (!draft?.repo || !this.repoSetting?.settingEl.isConnected) return;
		this.repoSetting.setDesc(`${draft.repo}, branch ${draft.branch}.`);
		this.chooseButton?.setButtonText("Change");
		this.refreshDraft();
	}
}
