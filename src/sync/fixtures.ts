import { decodeText, encodeUtf8 } from "../lib/bytes";
import { isSuperseded } from "../lib/format";
import { gitBlobSha } from "../lib/githash";
import type { ConflictStrategy, FirstSync, SyncOptions, SyncPreview, SyncReport } from "./engine";
import { preview, sync } from "./engine";
import type {
	Change,
	KeptCommit,
	LocalFile,
	LocalFs,
	Remote,
	RemoteCommit,
	RemoteFile,
	RemoteTree,
} from "./types";
import { emptyState, type SyncState } from "./types";

interface StoredCommit {
	files: Map<string, RemoteFile>;
	parent: string | null;
	merged: string | null;
	message: string;
	date: Date;
	authored: Date;
}

export class MemoryRemote implements Remote {
	readonly blobs = new Map<string, Uint8Array>();
	readonly commits = new Map<string, StoredCommit>();
	headSha: string | null = null;
	beforeCommit: (() => Promise<void>) | null = null;
	requests = 0;
	private counter = 0;

	async head(): Promise<string | null> {
		this.requests++;
		return this.headSha;
	}

	async readTree(commit: string): Promise<RemoteTree> {
		this.requests++;
		const stored = this.commits.get(commit);
		if (!stored) throw new Error(`no commit ${commit}`);
		return { tree: `tree-${commit}`, files: new Map(stored.files) };
	}

	async readBlobs(
		wanted: Array<{ sha: string; path: string }>,
		_commit: string,
		_progress?: (done: number, total: number) => void,
		each?: (sha: string, bytes: Uint8Array) => Promise<void>,
	): Promise<Map<string, Uint8Array>> {
		this.requests++;
		const out = new Map<string, Uint8Array>();
		for (const { sha } of wanted) {
			const blob = this.blobs.get(sha);
			if (!blob || out.has(sha)) continue;
			if (each) await each(sha, blob);
			out.set(sha, blob);
		}
		return each ? new Map() : out;
	}

	async commit(input: {
		parent: string;
		baseTree: string;
		changes: Change[];
		message: string;
		authored?: Date | null;
		kept?: KeptCommit | null;
	}): Promise<{ commit: string; tree: string } | "moved"> {
		this.requests++;
		const hook = this.beforeCommit;
		this.beforeCommit = null;
		if (hook) await hook();
		if (input.parent !== this.headSha) return "moved";
		const parent = this.commits.get(input.parent);
		const files = new Map(parent?.files ?? []);
		for (const change of input.changes) {
			if (change.read === null) files.delete(change.path);
			else
				files.set(change.path, { sha: await this.store(await change.read()), mode: change.mode });
		}
		const merged = input.kept ? this.keptCommit(input.kept) : null;
		const sha = this.addCommit(files, input.parent, input.message, {
			merged,
			authored: input.authored ?? null,
		});
		return { commit: sha, tree: `tree-${sha}` };
	}

	private keptCommit(kept: KeptCommit): string {
		const parent = kept.parent ? this.commits.get(kept.parent) : undefined;
		const files = new Map(parent?.files ?? []);
		for (const file of kept.files) {
			if (!this.blobs.has(file.sha)) throw new Error(`no blob ${file.sha}`);
			files.set(file.path, { sha: file.sha, mode: file.mode });
		}
		return this.addCommit(files, parent ? kept.parent : null, kept.message, {
			authored: kept.authored,
			move: false,
		});
	}

	async storeBlob(content: Uint8Array): Promise<string> {
		this.requests++;
		return this.store(content);
	}

	async initialize(path: string, content: Uint8Array, message: string): Promise<void> {
		if (this.headSha !== null) throw new Error("not empty");
		const files = new Map([[path, { sha: await this.store(content), mode: "100644" }]]);
		this.addCommit(files, null, message);
	}

	async commitsSince(base: string | null, head: string): Promise<RemoteCommit[]> {
		const out: RemoteCommit[] = [];
		for (let sha: string | null = head; sha && sha !== base; ) {
			const commit = this.commits.get(sha);
			if (!commit) break;
			out.push(this.toRemote(sha, commit));
			sha = commit.parent;
		}
		return out;
	}

	// along first parents, as git's default history simplification goes for these merges
	async lastChange(path: string, head: string): Promise<RemoteCommit | null> {
		this.requests++;
		for (const [sha, commit] of this.changesOf(path, head)) {
			if (!isSuperseded(commit.message)) return this.toRemote(sha, commit);
		}
		return null;
	}

	async fileHistory(path: string, head: string, max: number): Promise<string[]> {
		this.requests++;
		const shas: string[] = [];
		for (const [, commit] of this.changesOf(path, head).slice(0, max)) {
			const sha = commit.files.get(path)?.sha;
			if (sha && !shas.includes(sha)) shas.push(sha);
		}
		return shas;
	}

	private changesOf(path: string, head: string): Array<[string, StoredCommit]> {
		const out: Array<[string, StoredCommit]> = [];
		for (let sha: string | null = head; sha; ) {
			const commit = this.commits.get(sha);
			if (!commit) break;
			const before = commit.parent ? this.commits.get(commit.parent) : undefined;
			if (commit.files.get(path)?.sha !== before?.files.get(path)?.sha) out.push([sha, commit]);
			sha = commit.parent;
		}
		return out;
	}

	private toRemote(sha: string, commit: StoredCommit): RemoteCommit {
		return {
			sha,
			message: commit.message,
			date: commit.date,
			authored: commit.authored,
			parent: commit.parent,
		};
	}

	snapshot(): Record<string, string> {
		const out: Record<string, string> = {};
		const head = this.headSha ? this.commits.get(this.headSha) : null;
		for (const [path, file] of head?.files ?? []) {
			out[path] = decodeText(this.blobs.get(file.sha) ?? new Uint8Array()) ?? "<binary>";
		}
		return out;
	}

	// a commit made outside the plugin, such as by the Git plugin or the command line
	async pushDirect(files: Record<string, string | null>, message = "vault backup"): Promise<void> {
		const parent = this.headSha ? this.commits.get(this.headSha) : null;
		const next = new Map(parent?.files ?? []);
		for (const [path, text] of Object.entries(files)) {
			if (text === null) next.delete(path);
			else next.set(path, { sha: await this.store(encodeUtf8(text)), mode: "100644" });
		}
		this.addCommit(next, this.headSha, message);
	}

	private async store(content: Uint8Array): Promise<string> {
		const sha = await gitBlobSha(content);
		this.blobs.set(sha, content);
		return sha;
	}

	private addCommit(
		files: Map<string, RemoteFile>,
		parent: string | null,
		message: string,
		extra: { merged?: string | null; authored?: Date | null; move?: boolean } = {},
	): string {
		const sha = `c${++this.counter}`;
		const date = new Date(2026, 9, 6, 12, this.counter);
		this.commits.set(sha, {
			files,
			parent,
			merged: extra.merged ?? null,
			message,
			date,
			authored: extra.authored ?? date,
		});
		if (extra.move !== false) this.headSha = sha;
		return sha;
	}
}

export class MemoryFs implements LocalFs {
	readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
	readonly trash: string[] = [];
	readonly backups = new Map<string, Uint8Array>();
	beforeWrite = new Map<string, () => void>();
	// each write is a second after the one before, unless a test says when
	private clock = new Date(2026, 9, 6, 9, 0).getTime();

	set(path: string, content: string | Uint8Array, mtime?: Date): void {
		const data = typeof content === "string" ? encodeUtf8(content) : content;
		this.files.set(path, { data, mtime: mtime ? mtime.getTime() : this.tick() });
	}

	private tick(): number {
		this.clock += 1000;
		return this.clock;
	}

	get(path: string): string | undefined {
		const file = this.files.get(path);
		return file ? (decodeText(file.data) ?? "<binary>") : undefined;
	}

	delete(path: string): void {
		this.files.delete(path);
	}

	text(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const path of [...this.files.keys()].sort()) out[path] = this.get(path) ?? "";
		return out;
	}

	async listDir(dir: string): Promise<{ files: LocalFile[]; folders: string[] }> {
		const prefix = dir === "" ? "" : `${dir}/`;
		const files: LocalFile[] = [];
		const folders = new Set<string>();
		for (const [path, file] of this.files) {
			if (!path.startsWith(prefix)) continue;
			const rest = path.slice(prefix.length);
			const slash = rest.indexOf("/");
			if (slash === -1) files.push({ path, mtime: file.mtime, size: file.data.length });
			else folders.add(prefix + rest.slice(0, slash));
		}
		return { files, folders: [...folders] };
	}

	async read(path: string): Promise<Uint8Array> {
		const file = this.files.get(path);
		if (!file) throw new Error(`ENOENT ${path}`);
		return file.data;
	}

	async write(path: string, data: Uint8Array, expectedSha: string | null): Promise<boolean> {
		const hook = this.beforeWrite.get(path);
		this.beforeWrite.delete(path);
		hook?.();
		if (!(await this.matches(path, expectedSha))) return false;
		this.files.set(path, { data, mtime: this.tick() });
		return true;
	}

	async remove(path: string, expectedSha: string): Promise<boolean> {
		if (!(await this.matches(path, expectedSha))) return false;
		this.files.delete(path);
		this.trash.push(path);
		return true;
	}

	async backup(path: string): Promise<void> {
		const file = this.files.get(path);
		if (file) this.backups.set(path, file.data);
	}

	private async matches(path: string, expectedSha: string | null): Promise<boolean> {
		const current = this.files.get(path);
		if (!current) return expectedSha === null;
		return expectedSha !== null && (await gitBlobSha(current.data)) === expectedSha;
	}
}

export class Device {
	readonly fs = new MemoryFs();
	state: SyncState = emptyState("me/vault@main");
	lastReport: SyncReport | null = null;

	constructor(
		readonly name: string,
		readonly remote: MemoryRemote,
	) {}

	preview(): Promise<SyncPreview> {
		return preview(this.state, this.options());
	}

	async sync(
		options: {
			allowMassDelete?: boolean;
			conflicts?: ConflictStrategy;
			firstSync?: FirstSync;
		} = {},
	): Promise<SyncReport> {
		const result = await sync(this.state, { ...this.options(), ...options });
		this.state = result.state;
		this.lastReport = result.report;
		return result.report;
	}

	private options(): SyncOptions {
		return {
			fs: this.fs,
			remote: this.remote,
			device: this.name,
			stateFile: ".obsidian/plugins/easy-git-sync/state.json",
			configDir: ".obsidian",
			saveState: async (state) => {
				this.state = state;
			},
			now: () => new Date(2026, 9, 6, 14, 31),
		};
	}
}
