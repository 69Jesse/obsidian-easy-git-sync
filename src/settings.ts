import {
	type App,
	type ButtonComponent,
	type DropdownComponent,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type EasyGitSync from "./main";
import { RepoPickerModal } from "./modals";
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

const SYNC_AFTER_EDIT: [string, string][] = [
	["10", "10 seconds"],
	["30", "30 seconds"],
	["60", "1 minute"],
	["300", "5 minutes"],
	["0", "Only when I ask"],
];

// in order: a record would sort its integer-like keys and put "Only when I ask" on top
function addOptions(dropdown: DropdownComponent, options: [string, string][]): DropdownComponent {
	for (const [value, label] of options) dropdown.addOption(value, label);
	return dropdown;
}

const CONFLICTS: Record<ConflictStrategy, string> = {
	"keep-both": "Keep both, marked",
	newest: "Keep the newer version",
};

const CHECK_INTERVAL: [string, string][] = [
	["30", "30 seconds"],
	["60", "1 minute"],
	["300", "5 minutes"],
	["900", "15 minutes"],
	["0", "Only when I ask"],
];

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
	private accountLine: HTMLElement | null = null;
	private chooseButton: ButtonComponent | null = null;
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

	override display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.chooseButton = null;
		this.commitButton = null;
		this.hintEl = null;
		this.accountLine = null;
		const plugin = this.plugin;

		if (plugin.otherGitPluginEnabled()) {
			const warning = containerEl.createDiv({ cls: "easy-git-sync-warning" });
			warning.setText(
				"Paused while the Git plugin is on: two plugins syncing one vault would fight. Turn it off on this device to sync.",
			);
		}

		new Setting(containerEl).setName("Connection").setHeading();
		const row = new Setting(containerEl);
		this.connectionSetting = row;
		if (plugin.device.started) {
			row
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
							}
							this.display();
						}),
				)
				.addButton((button) =>
					button.setButtonText("Sync now").onClick(() => void plugin.syncNow("manual")),
				);
		}
		this.refreshConnection();
		void plugin.refreshAccount();

		// not connected, the setup is the draft: there is nothing live to keep apart from it
		if (!plugin.device.started) plugin.beginDraft();
		if (plugin.draft && (this.draftOpen || !plugin.device.started)) this.displayDraft(containerEl);

		const host = plugin.host;
		new Setting(containerEl).setName("Syncing").setHeading();

		new Setting(containerEl)
			.setName("Sync after editing")
			.setDesc("How long after you stop typing to upload changes.")
			.addDropdown((dropdown) =>
				addOptions(dropdown, SYNC_AFTER_EDIT)
					.setValue(String(plugin.settings.syncAfterEdit))
					.onChange(async (value) => {
						plugin.settings.syncAfterEdit = Number(value);
						await plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Check for changes")
			.setDesc(
				"How often to look for changes from other devices. It also looks on startup and when you return to Obsidian.",
			)
			.addDropdown((dropdown) =>
				addOptions(dropdown, CHECK_INTERVAL)
					.setValue(String(plugin.settings.checkInterval))
					.onChange(async (value) => {
						plugin.settings.checkInterval = Number(value);
						await plugin.saveSettings();
						plugin.reschedule();
					}),
			);

		new Setting(containerEl)
			.setName("Merge conflicts")
			.setDesc(
				`When a note changed in the same place on two devices. Changes in different places always merge, and the version not kept stays in ${host.name}'s history.`,
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(CONFLICTS)
					.setValue(plugin.settings.conflicts)
					.onChange(async (value) => {
						plugin.settings.conflicts = value === "newest" ? "newest" : "keep-both";
						await plugin.saveSettings();
					}),
			);

		const conflicts = plugin.conflictCount();
		if (conflicts > 0) {
			new Setting(containerEl)
				.setName("Resolve all conflicts")
				.setDesc(
					conflicts === 1
						? "1 note still has a conflict. Keep the newer version in it."
						: `${conflicts} notes still have a conflict. Keep the newer version in every one of them.`,
				)
				.addButton((button) =>
					button.setButtonText("Keep newer").onClick(async () => {
						await plugin.resolveAllNewer();
						this.display();
					}),
				);
		}

		// synced, so it stays put when this device uses a host that cannot link commits
		const linkHelp = LINK_HELP[host.id];
		if (host.linksAccounts && linkHelp) {
			new Setting(containerEl)
				.setName(
					host.name.startsWith("the ")
						? `Link commits to your account on ${host.name}`
						: `Link commits to your ${host.name} account`,
				)
				.setDesc(linkHelp)
				.addToggle((toggle) =>
					toggle.setValue(plugin.settings.commitAsAccount).onChange(async (value) => {
						plugin.settings.commitAsAccount = value;
						await plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl).setName("This device").setHeading();

		new Setting(containerEl)
			.setName("This device's name")
			.setDesc("Used in commits and conflict blocks.")
			.addText((text) =>
				text.setValue(plugin.device.deviceName).onChange((value) => {
					plugin.device.deviceName = value.trim() || defaultDeviceName();
					plugin.saveDevice();
				}),
			);

		if (plugin.device.started || plugin.hasToken()) {
			new Setting(containerEl)
				.setName("Disconnect this device")
				.setDesc(
					`Forgets the ${plugin.device.provider === "other" ? "password" : "token"}, repository and sync history here. Your notes are not touched.`,
				)
				.addButton((button) =>
					button
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await plugin.disconnect();
							new Notice("Easy Git Sync: this device is disconnected.");
							this.display();
						}),
				);
		}
	}

	override hide(): void {
		this.draftOpen = false;
		super.hide();
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
			row.descEl.setText("Fill in the connection below, then press Start syncing.");
			return;
		}
		const login =
			device.provider === "other" ? device.username : device.account ? `@${device.account}` : "";
		row.descEl.createDiv({
			text: `On ${whereOf(device)}${login ? ` as ${login}` : ""}, branch ${device.branch}.`,
		});
		row.descEl.createDiv({ text: plugin.statusDescription() });
	}

	private displayDraft(containerEl: HTMLElement): void {
		const plugin = this.plugin;
		const draft = plugin.draft;
		if (!draft) return;

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Where the repository is.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(PROVIDERS)
					.setValue(draft.provider)
					.onChange((value) => {
						plugin.setDraftConnection({
							provider: value as ProviderId,
							server: "",
							username: "",
						});
						this.display();
					}),
			);

		if (draft.provider === "gitlab" || draft.provider === "forgejo") {
			const fallback = DEFAULT_SERVERS[draft.provider] ?? "";
			new Setting(containerEl)
				.setName("Server")
				.setDesc(
					draft.provider === "gitlab"
						? "Empty for gitlab.com, or the address of your own GitLab."
						: "Empty for codeberg.org, or the address of your Forgejo or Gitea server.",
				)
				.addText((text) => {
					text.setPlaceholder(fallback.replace(/^https:\/\//, "")).setValue(draft.server);
					// applied once the field is left: a new server means a new token and repository
					text.inputEl.addEventListener("change", () => {
						const value = text.getValue().trim();
						const server =
							value && normalizeServer(value) !== fallback ? normalizeServer(value) : "";
						plugin.setDraftConnection({ server });
						this.display();
					});
				});
		}

		if (draft.provider === "other") {
			this.displayOther(containerEl, draft);
		} else {
			this.displayToken(containerEl, draft);
			new Setting(containerEl)
				.setName("Repository")
				.setDesc(
					draft.repo
						? `${draft.repo}, branch ${draft.branch}.`
						: "The repository this vault syncs with. It can be empty or already hold the vault.",
				)
				.addButton((button) => {
					this.chooseButton = button;
					button.setButtonText(draft.repo ? "Change" : "Choose").onClick(() => {
						const host = plugin.draftHost();
						if (!host) return;
						new RepoPickerModal(this.app, host, async (fullName) => {
							if (await plugin.pickDraftRepo(fullName)) this.display();
						}).open();
					});
				});
		}

		const footer = new Setting(containerEl);
		footer.settingEl.addClass("easy-git-sync-draft-footer");
		this.hintEl = footer.descEl;
		footer.addButton((button) => {
			this.commitButton = button;
			button.setCta().onClick(async () => {
				const current = plugin.draft;
				if (current?.provider === "other" && !/^https?:\/\//i.test(current.repo ?? "")) {
					new Notice("Easy Git Sync: enter the repository's address, starting with https://.");
					return;
				}
				button.setDisabled(true);
				await plugin.commitDraft();
				this.display();
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

	private displayToken(panel: HTMLElement, draft: Draft): void {
		const plugin = this.plugin;
		const host = plugin.draftHost();
		if (!host) return;
		const help = TOKEN_HELP[host.id as Exclude<ProviderId, "other">];
		const tokenSetting = new Setting(panel)
			.setName("Access token")
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
		tokenSetting.settingEl.addClass("easy-git-sync-token-setting");
		this.accountLine = tokenSetting.descEl.createDiv({ cls: "easy-git-sync-account" });
		void this.checkAccount();
	}

	// another git server: its address and a login, and no account to list repositories from
	private displayOther(panel: HTMLElement, draft: Draft): void {
		const plugin = this.plugin;
		new Setting(panel)
			.setName("Username")
			.setDesc("The login for the repository.")
			.addText((text) => {
				text.setValue(draft.username);
				text.inputEl.autocomplete = "off";
				text.inputEl.addEventListener("change", () => {
					plugin.setDraftConnection({ username: text.getValue().trim() });
					this.display();
				});
			});
		new Setting(panel)
			.setName("Password")
			.setDesc(
				createFragment((desc) => {
					desc.appendText(
						"Its password, or an access token if the server issues them. Kept in this device's keychain, never synced.",
					);
					this.accountLine = desc.createDiv({ cls: "easy-git-sync-account" });
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				if (draft.token) text.setValue(draft.token);
				text.onChange((value) => this.onLoginTyped(value, false));
			});
		this.showPasswordLine();
		new Setting(panel)
			.setName("Repository")
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
		const plugin = this.plugin;
		const draft = plugin.draft;
		const host = plugin.draftHost();
		if (!line || !draft || !host) return;
		if (!plugin.draftHasLogin()) {
			line.setText("");
			return;
		}
		const typed = draft.token !== null;
		line.setText("Checking the token...");
		line.removeClass("mod-warning");
		const id = ++this.checkId;
		try {
			const [account, repos, expiry] = await Promise.all([
				host.account(),
				host.repos(),
				host.tokenExpiry().catch(() => null),
			]);
			if (id !== this.checkId) return;
			const who = typed
				? `The new token is for @${account.login}`
				: `A token is saved for @${account.login}`;
			// the same count the repository picker shows
			const count = repos.filter((repo) => repo.canPush).length;
			if (count === 0) {
				line.setText(`${who}, but it cannot write to any repository.`);
				line.addClass("mod-warning");
				return;
			}
			const until = expiry ? ` It expires on ${expiry.toLocaleDateString()}.` : "";
			line.setText(
				`${who}. ${count} ${count === 1 ? "repository" : "repositories"} available.${until}`,
			);
		} catch (error) {
			if (id !== this.checkId) return;
			line.setText(error instanceof Error ? error.message : String(error));
			line.addClass("mod-warning");
		}
	}
}
