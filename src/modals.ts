import { type App, ConfirmationModal, Modal, Setting, SuggestModal } from "obsidian";
import { capitalize } from "./lib/format";
import type { RepoInfo } from "./remote/hosts";
import type { FirstSync } from "./sync/engine";

export class RepoPickerModal extends SuggestModal<RepoInfo | string> {
	private repos: RepoInfo[] = [];
	private loaded = false;

	// a list fetched earlier shows at once; the fresh one replaces it when it arrives
	constructor(
		app: App,
		private readonly cached: RepoInfo[] | null,
		private readonly fresh: Promise<RepoInfo[]>,
		private readonly onPick: (fullName: string) => void | Promise<void>,
	) {
		super(app);
		this.setPlaceholder("Repository, or owner/name");
		this.emptyStateText = "Loading repositories...";
	}

	override onOpen(): void {
		void super.onOpen();
		if (this.cached) this.show(this.cached);
		void this.fresh.then(
			(repos) => this.show(repos),
			(error: unknown) => {
				if (this.loaded) return;
				this.emptyStateText = error instanceof Error ? error.message : String(error);
				this.inputEl.dispatchEvent(new Event("input"));
			},
		);
	}

	private show(repos: RepoInfo[]): void {
		this.repos = repos.filter((repo) => repo.canPush);
		this.loaded = true;
		this.emptyStateText = "No repository matches. Type owner/name to use one anyway.";
		// re-runs the query so the list appears
		this.inputEl.dispatchEvent(new Event("input"));
	}

	getSuggestions(query: string): Array<RepoInfo | string> {
		const q = query.trim().toLowerCase();
		const matches = this.repos.filter((repo) => repo.fullName.toLowerCase().includes(q));
		// GitLab nests groups, so a full name can have more than two parts
		const typed = /^[\w.-]+(\/[\w.-]+)+$/.test(query.trim()) ? query.trim() : null;
		if (typed && !matches.some((repo) => repo.fullName.toLowerCase() === typed.toLowerCase())) {
			return [...matches, typed];
		}
		return this.loaded || matches.length > 0 ? matches : [];
	}

	renderSuggestion(item: RepoInfo | string, el: HTMLElement): void {
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

	onChooseSuggestion(item: RepoInfo | string): void {
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
	destructive = false,
): Promise<boolean> {
	return new Promise((resolve) => {
		// a button resolves first, so the close that follows it changes nothing
		const modal = new (class extends ConfirmationModal {
			override onClose(): void {
				super.onClose();
				resolve(false);
			}
		})(app);
		modal.setTitle(title);
		for (const paragraph of body) modal.contentEl.createEl("p", { text: paragraph });
		modal.addButton((button) => {
			button.setButtonText(action).onClick(() => resolve(true));
			if (destructive) button.setDestructive();
			else button.setCta();
		});
		modal.addCancelButton();
		modal.open();
	});
}

export interface FirstSyncSummary {
	repo: string;
	// GitHub, GitLab, or "the server"
	remote: string;
	same: number;
	upload: number;
	download: number;
	merge: number;
	newest: boolean;
	// the connection this device leaves, when it had one
	leaving: string | null;
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
					text: `Both have files. ${files(s.same)} are the same on both sides, ${files(s.upload)} only in this vault, ${files(s.download)} only on ${s.remote}, and ${files(s.merge)} differ.`,
				});
				if (s.leaving) this.contentEl.createEl("p", { text: s.leaving });
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
						else button.setDestructive();
					});
				};
				const changes = (replaced: number, deleted: number, where: string) =>
					[
						replaced > 0 && `${files(replaced)} replaced`,
						deleted > 0 && `${files(deleted)} deleted ${where}`,
					]
						.filter(Boolean)
						.join(" and ");
				const differ =
					s.merge > 0
						? ` The ${files(s.merge)} that differ otherwise merge, and where both changed the same place ${s.newest ? "the newer version is kept" : "both versions are kept, marked"}.`
						: "";
				choice(
					"Merge",
					`Keep everything from both: files only on one side are copied to the other. A file here that is an older version from ${s.remote}'s history just updates.${differ}`,
					"Merge",
					"merge",
				);
				const here = changes(s.merge, s.upload, "here");
				choice(
					`Use ${s.remote}'s version`,
					here
						? `Make this vault a copy of ${s.remote}'s: ${here}. ${s.merge > 0 && s.upload > 0 ? "Both go" : s.merge + s.upload === 1 ? "It goes" : "They go"} to the trash.`
						: `Make this vault a copy of ${s.remote}'s.`,
					`Use ${s.remote}'s`,
					"use-remote",
				);
				const there = changes(s.merge, s.download, "there");
				choice(
					"Use this vault",
					`Make ${s.remote}'s a copy of this vault${there ? `: ${there},` : ","} in one commit. ${capitalize(s.remote)}'s history keeps the old versions.`,
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
