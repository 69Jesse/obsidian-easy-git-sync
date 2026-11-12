import {
	type App,
	type DropdownComponent,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type EasyGitSync from "./main";
import { RepoPickerModal } from "./modals";
import {
	DEFAULT_SERVERS,
	type Host,
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

export class EasyGitSyncSettingTab extends PluginSettingTab {
	private accountLine: HTMLElement | null = null;
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
		const plugin = this.plugin;

		if (plugin.otherGitPluginEnabled()) {
			const warning = containerEl.createDiv({ cls: "easy-git-sync-warning" });
			warning.setText(
				"Paused while the Git plugin is on: two plugins syncing one vault would fight. Turn it off on this device to sync.",
			);
		}

		new Setting(containerEl).setName("Provider").setHeading();

		const device = plugin.device;
		const host = plugin.host;
		new Setting(containerEl)
			.setName("Provider")
			.setDesc(
				"Where the repository is. Changing it starts this device over with a new repository.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(PROVIDERS)
					.setValue(device.provider)
					.onChange(async (value) => {
						await plugin.setConnection({
							provider: value as ProviderId,
							server: "",
							username: "",
						});
						this.display();
					}),
			);

		if (device.provider === "gitlab" || device.provider === "forgejo") {
			const fallback = DEFAULT_SERVERS[device.provider] ?? "";
			new Setting(containerEl)
				.setName("Server")
				.setDesc(
					device.provider === "gitlab"
						? "Empty for gitlab.com, or the address of your own GitLab."
						: "Empty for codeberg.org, or the address of your Forgejo or Gitea server.",
				)
				.addText((text) => {
					text.setPlaceholder(fallback.replace(/^https:\/\//, "")).setValue(device.server);
					// applied once the field is left: each change starts the device over
					text.inputEl.addEventListener("change", () => {
						const value = text.getValue().trim();
						const server =
							value && normalizeServer(value) !== fallback ? normalizeServer(value) : "";
						void plugin.setConnection({ server }).then(() => this.display());
					});
				});
		}

		if (device.provider === "other") {
			this.displayOther(containerEl);
		} else {
			this.displayToken(containerEl, host);
			const repoSetting = new Setting(containerEl)
				.setName("Repository")
				.setDesc(
					device.repo
						? `${device.repo}, branch ${device.branch}.`
						: "The repository this vault syncs with. It can be empty or already hold the vault.",
				)
				.addButton((button) =>
					button
						.setButtonText(device.repo ? "Change" : "Choose")
						.setDisabled(!plugin.hasToken())
						.onClick(() => {
							new RepoPickerModal(this.app, plugin, async (fullName) => {
								await plugin.selectRepo(fullName);
								this.display();
							}).open();
						}),
				);
			this.addStart(repoSetting);
		}

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
				.setName(`Link commits to your ${host.name} account`)
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

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc(plugin.statusDescription())
			.addButton((button) =>
				button
					.setButtonText("Sync now")
					.setDisabled(!plugin.device.started)
					.onClick(() => void plugin.syncNow("manual")),
			);

		new Setting(containerEl)
			.setName("Disconnect this device")
			.setDesc(
				`Forgets the ${device.provider === "other" ? "password" : "token"}, repository and sync history here. Your notes are not touched.`,
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

	private displayToken(containerEl: HTMLElement, host: Host): void {
		const plugin = this.plugin;
		const help = TOKEN_HELP[host.id as Exclude<ProviderId, "other">];
		const tokenSetting = new Setting(containerEl)
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
				text.setPlaceholder(TOKEN_PLACEHOLDER[host.id]).onChange((value) => {
					window.clearTimeout(this.tokenTimer);
					this.tokenTimer = window.setTimeout(() => {
						const token = value.trim();
						if (!token) return;
						plugin.setToken(token);
						this.display();
					}, 600);
				});
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
	private displayOther(containerEl: HTMLElement): void {
		const plugin = this.plugin;
		const device = plugin.device;
		let url = device.repo ?? "";
		new Setting(containerEl)
			.setName("Username")
			.setDesc("The login for the repository.")
			.addText((text) => {
				text.setValue(device.username);
				text.inputEl.autocomplete = "off";
				text.inputEl.addEventListener("change", () => {
					void plugin
						.setConnection({ username: text.getValue().trim() })
						.then(() => this.display());
				});
			});
		new Setting(containerEl)
			.setName("Password")
			.setDesc(
				createFragment((desc) => {
					desc.appendText(
						"Its password, or an access token if the server issues them. Kept in this device's keychain, never synced.",
					);
					this.accountLine = desc.createDiv({ cls: "easy-git-sync-account" });
					this.accountLine.setText(plugin.token() ? "A password is saved." : "");
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.onChange((value) => {
					window.clearTimeout(this.tokenTimer);
					this.tokenTimer = window.setTimeout(() => {
						if (!value) return;
						plugin.setToken(value);
						this.display();
					}, 600);
				});
			});
		const repoSetting = new Setting(containerEl)
			.setName("Repository")
			.setDesc(
				device.repo
					? `${device.repo}, branch ${device.branch}.`
					: "Its address over HTTPS, as you would clone it. SSH addresses cannot work: phones cannot use SSH.",
			)
			.addText((text) => {
				text.setPlaceholder("https://git.example.com/me/vault.git").setValue(url);
				text.onChange((value) => {
					url = value.trim();
				});
			})
			.addButton((button) =>
				button.setButtonText(device.repo ? "Change" : "Connect").onClick(async () => {
					if (!/^https?:\/\//i.test(url)) {
						new Notice("Easy Git Sync: enter the repository's address, starting with https://.");
						return;
					}
					await plugin.selectRepo(url);
					this.display();
				}),
			);
		this.addStart(repoSetting);
	}

	private addStart(setting: Setting): void {
		const plugin = this.plugin;
		if (!plugin.device.repo || plugin.device.started) return;
		setting.addButton((button) =>
			button
				.setButtonText("Start syncing")
				.setCta()
				.onClick(async () => {
					await plugin.start();
					this.display();
				}),
		);
	}

	private async checkAccount(): Promise<void> {
		const line = this.accountLine;
		if (!line) return;
		if (!this.plugin.hasToken()) {
			line.setText("");
			return;
		}
		line.setText("Checking the token...");
		line.removeClass("mod-warning");
		const id = ++this.checkId;
		const host = this.plugin.host;
		try {
			const [account, repos, expiry] = await Promise.all([
				host.account(),
				host.repos(),
				host.tokenExpiry().catch(() => null),
			]);
			if (id !== this.checkId) return;
			// the same count the repository picker shows
			const count = repos.filter((repo) => repo.canPush).length;
			if (count === 0) {
				line.setText(
					`Connected as @${account.login}, but the token cannot write to any repository.`,
				);
				line.addClass("mod-warning");
				return;
			}
			const until = expiry ? ` The token expires on ${expiry.toLocaleDateString()}.` : "";
			line.setText(
				`Connected as @${account.login}. ${count} ${count === 1 ? "repository" : "repositories"} available.${until}`,
			);
		} catch (error) {
			if (id !== this.checkId) return;
			line.setText(error instanceof Error ? error.message : String(error));
			line.addClass("mod-warning");
		}
	}
}
