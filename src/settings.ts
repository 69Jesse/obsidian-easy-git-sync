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
	repo: string | null;
	branch: string;
	deviceName: string;
	started: boolean;
	// kept until a sync completes, so a retried first sync does not turn into a merge
	firstSync?: FirstSync;
}

export function defaultDeviceName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android phone";
	const host = hostname();
	if (host) return host;
	return Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows PC" : "Computer";
}

function hostname(): string {
	const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
	try {
		const os = nodeRequire?.("os") as { hostname(): string } | undefined;
		return (
			os
				?.hostname()
				.replace(/\.local$/, "")
				.replace(/-/g, " ")
				.trim() ?? ""
		);
	} catch {
		return "";
	}
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

export const TOKEN_URL =
	"https://github.com/settings/personal-access-tokens/new?" +
	new URLSearchParams({
		name: "Obsidian Easy Git Sync",
		description: "Lets Obsidian sync this vault with its repository.",
		contents: "write",
		expires_in: "none",
	}).toString();

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

		new Setting(containerEl).setName("GitHub").setHeading();

		const tokenSetting = new Setting(containerEl)
			.setName("Access token")
			.setDesc(
				createFragment((desc) => {
					// named exactly as GitHub's token form names them
					desc.appendText("A fine-grained token with the ");
					desc.createEl("code", { text: "Read and write" });
					desc.appendText(" permission on ");
					desc.createEl("code", { text: "Contents" });
					desc.appendText(", under ");
					desc.createEl("code", { text: "Repositories" });
					desc.appendText(". The button opens GitHub's form with this already filled in.");
				}),
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text.setPlaceholder("github_pat_...").onChange((value) => {
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
				button.setButtonText("Create token on GitHub").onClick(() => {
					window.open(TOKEN_URL);
				}),
			);
		// whether a token is saved goes in the description: a placeholder vanishes on paste
		tokenSetting.settingEl.addClass("easy-git-sync-token-setting");
		this.accountLine = tokenSetting.descEl.createDiv({ cls: "easy-git-sync-account" });
		void this.checkAccount();

		const repoSetting = new Setting(containerEl)
			.setName("Repository")
			.setDesc(
				plugin.device.repo
					? `${plugin.device.repo}, branch ${plugin.device.branch}.`
					: "The repository this vault syncs with. It can be empty or already hold the vault.",
			)
			.addButton((button) =>
				button
					.setButtonText(plugin.device.repo ? "Change" : "Choose")
					.setDisabled(!plugin.hasToken())
					.onClick(() => {
						new RepoPickerModal(this.app, plugin, async (fullName) => {
							await plugin.selectRepo(fullName);
							this.display();
						}).open();
					}),
			);
		if (plugin.device.repo && !plugin.device.started) {
			repoSetting.addButton((button) =>
				button
					.setButtonText("Start syncing")
					.setCta()
					.onClick(async () => {
						await plugin.start();
						this.display();
					}),
			);
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
			.setName("Check GitHub for changes")
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
				"When a note changed in the same place on two devices. Changes in different places always merge, and the version not kept stays in GitHub's history.",
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

		new Setting(containerEl)
			.setName("Link commits to your GitHub account")
			.setDesc("Turn this off to keep syncs off your contribution graph.")
			.addToggle((toggle) =>
				toggle.setValue(plugin.settings.commitAsAccount).onChange(async (value) => {
					plugin.settings.commitAsAccount = value;
					await plugin.saveSettings();
				}),
			);

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
			.setDesc("Forgets the token, repository and sync history here. Your notes are not touched.")
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
		try {
			const [user, repos] = await Promise.all([
				this.plugin.client.user(),
				this.plugin.client.repos(),
			]);
			if (id !== this.checkId) return;
			// the same count the repository picker shows
			const count = repos.filter((repo) => repo.canPush).length;
			if (count === 0) {
				line.setText(`Connected as @${user.login}, but the token cannot write to any repository.`);
				line.addClass("mod-warning");
				return;
			}
			line.setText(
				`Connected as @${user.login}. ${count} ${count === 1 ? "repository" : "repositories"} available.`,
			);
		} catch (error) {
			if (id !== this.checkId) return;
			line.setText(error instanceof Error ? error.message : String(error));
			line.addClass("mod-warning");
		}
	}
}
