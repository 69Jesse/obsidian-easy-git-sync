import { type App, Modal, Setting, SuggestModal } from "obsidian";
import type EasyGitSync from "./main";
import type { GitHubRepo } from "./remote/github";
import type { FirstSync } from "./sync/engine";

export class RepoPickerModal extends SuggestModal<GitHubRepo | string> {
	private repos: GitHubRepo[] = [];
	private loaded = false;

	constructor(
		app: App,
		private readonly plugin: EasyGitSync,
		private readonly onPick: (fullName: string) => void | Promise<void>,
	) {
		super(app);
		this.setPlaceholder("Repository, or owner/name");
		this.emptyStateText = "Loading repositories...";
	}

	override onOpen(): void {
		void super.onOpen();
		void this.plugin.client.repos().then(
			(repos) => {
				this.repos = repos.filter((repo) => repo.canPush);
				this.loaded = true;
				this.emptyStateText = "No repository matches. Type owner/name to use one anyway.";
				// re-runs the query so the list appears
				this.inputEl.dispatchEvent(new Event("input"));
			},
			(error: unknown) => {
				this.emptyStateText = error instanceof Error ? error.message : String(error);
				this.inputEl.dispatchEvent(new Event("input"));
			},
		);
	}

	getSuggestions(query: string): Array<GitHubRepo | string> {
		const q = query.trim().toLowerCase();
		const matches = this.repos.filter((repo) => repo.fullName.toLowerCase().includes(q));
		const typed = /^[\w.-]+\/[\w.-]+$/.test(query.trim()) ? query.trim() : null;
		if (typed && !matches.some((repo) => repo.fullName.toLowerCase() === typed.toLowerCase())) {
			return [...matches, typed];
		}
		return this.loaded || matches.length > 0 ? matches : [];
	}

	renderSuggestion(item: GitHubRepo | string, el: HTMLElement): void {
		if (typeof item === "string") {
			el.createDiv({ text: item });
			el.createEl("small", { text: "Use this repository", cls: "easy-git-sync-muted" });
			return;
		}
		el.createDiv({ text: item.fullName });
		const details = [item.private ? "private" : "public", item.empty ? "empty" : null].filter(
			Boolean,
		);
		el.createEl("small", { text: details.join(", "), cls: "easy-git-sync-muted" });
	}

	onChooseSuggestion(item: GitHubRepo | string): void {
		void this.onPick(typeof item === "string" ? item : item.fullName);
	}
}

export function pickBranch(
	app: App,
	repo: string,
	branches: string[],
	defaultBranch: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		const modal = new (class extends SuggestModal<string> {
			getSuggestions(query: string): string[] {
				const q = query.trim().toLowerCase();
				return branches.filter((branch) => branch.toLowerCase().includes(q));
			}
			renderSuggestion(branch: string, el: HTMLElement): void {
				el.createDiv({ text: branch });
				if (branch === defaultBranch) {
					el.createEl("small", { text: "Default branch", cls: "easy-git-sync-muted" });
				}
			}
			onChooseSuggestion(branch: string): void {
				resolve(branch);
			}
			override onClose(): void {
				// deferred, so a choice resolves first whichever order Obsidian calls these in
				window.setTimeout(() => resolve(null), 0);
			}
		})(app);
		modal.setPlaceholder(`Branch of ${repo} to sync with`);
		modal.open();
	});
}

export function confirm(
	app: App,
	title: string,
	body: string[],
	action: string,
	warning = false,
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new (class extends Modal {
			private answered = false;
			override onOpen(): void {
				this.setTitle(title);
				this.modalEl.addClass("easy-git-sync-modal");
				for (const paragraph of body) this.contentEl.createEl("p", { text: paragraph });
				const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
				const yes = buttons.createEl("button", {
					text: action,
					cls: warning ? "mod-warning" : "mod-cta",
				});
				yes.addEventListener("click", () => {
					this.answered = true;
					resolve(true);
					this.close();
				});
				buttons
					.createEl("button", { text: "Cancel" })
					.addEventListener("click", () => this.close());
			}
			override onClose(): void {
				if (!this.answered) resolve(false);
				this.contentEl.empty();
			}
		})(app);
		modal.open();
	});
}

export interface FirstSyncSummary {
	repo: string;
	same: number;
	upload: number;
	download: number;
	merge: number;
	newest: boolean;
}

export function chooseFirstSync(app: App, s: FirstSyncSummary): Promise<FirstSync | null> {
	const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
	return new Promise((resolve) => {
		const modal = new (class extends Modal {
			private answered = false;
			override onOpen(): void {
				this.setTitle(`Start syncing with ${s.repo}`);
				this.modalEl.addClass("easy-git-sync-modal");
				this.contentEl.createEl("p", {
					text: `Both have files. ${files(s.same)} are the same on both sides, ${files(s.upload)} only in this vault, ${files(s.download)} only on GitHub, and ${files(s.merge)} differ.`,
				});
				const choice = (name: string, desc: string, action: string, value: FirstSync) => {
					const setting = new Setting(this.contentEl).setName(name).setDesc(desc);
					setting.settingEl.addClass("easy-git-sync-choice");
					setting.addButton((button) => {
						button.setButtonText(action).onClick(() => {
							this.answered = true;
							resolve(value);
							this.close();
						});
						if (value === "merge") button.setCta();
						else button.setWarning();
					});
				};
				choice(
					"Merge",
					`Keep everything from both: files only on one side are copied to the other. A file here that is an older version from GitHub's history just updates. The ${files(s.merge)} that differ otherwise merge, and where both changed the same place ${s.newest ? "the newer version is kept" : "both versions are kept, marked"}.`,
					"Merge",
					"merge",
				);
				choice(
					"Use GitHub's version",
					`Make this vault a copy of GitHub's: ${files(s.merge)} replaced and ${files(s.upload)} deleted here. Both go to the trash.`,
					"Use GitHub's",
					"use-remote",
				);
				choice(
					"Use this vault",
					`Make GitHub's a copy of this vault: ${files(s.merge)} replaced and ${files(s.download)} deleted there, in one commit. GitHub's history keeps the old versions.`,
					"Use this vault",
					"use-local",
				);
			}
			override onClose(): void {
				if (!this.answered) resolve(null);
				this.contentEl.empty();
			}
		})(app);
		modal.open();
	});
}

export class ConflictsModal extends SuggestModal<string> {
	constructor(
		app: App,
		private readonly paths: string[],
		private readonly onPick: (path: string) => void,
	) {
		super(app);
		this.setPlaceholder("Notes with sync conflicts");
		this.emptyStateText = "No sync conflicts.";
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.paths.filter((path) => path.toLowerCase().includes(q));
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	onChooseSuggestion(path: string): void {
		this.onPick(path);
	}
}
