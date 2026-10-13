import { decodeText } from "../lib/bytes";
import {
	commitMessage,
	conflictCopyPath,
	deviceFromMessage,
	isSuperseded,
	sideLabel,
} from "../lib/format";
import { gitBlobSha } from "../lib/githash";
import { type FileMerge, mergeFile } from "../merge/file";
import { RENAME_SIMILARITY, similarity } from "../merge/similarity";
import type { Side } from "../merge/text";
import { defaultGitignore, isHardExcluded } from "./ignore";
import {
	type Action,
	plan,
	planReplace,
	type RenameCandidate,
	renameCandidates,
	type Snapshot,
} from "./plan";
import { type LocalEntry, scanLocal } from "./scan";
import type {
	Change,
	KeptCommit,
	KeptVersions,
	LocalFs,
	Remote,
	RemoteFile,
	SyncState,
} from "./types";

export type ConflictStrategy = "keep-both" | "newest";

export type FirstSync = "merge" | "use-remote" | "use-local";

export interface SyncOptions {
	fs: LocalFs;
	remote: Remote;
	device: string;
	stateFile: string;
	configDir: string;
	// called between the two halves, so a crash in between does not merge twice
	saveState(state: SyncState): Promise<void>;
	allowMassDelete?: boolean;
	conflicts?: ConflictStrategy;
	// only read while the state has never synced
	firstSync?: FirstSync;
	now?: () => Date;
	progress?(message: string): void;
}

export interface SyncReport {
	pulled: string[];
	pushed: string[];
	deletedHere: string[];
	deletedThere: string[];
	merged: string[];
	conflicts: Array<{ path: string; count: number }>;
	// `places` is 0 when the whole file was taken because it could not be merged
	newer: Array<{ path: string; from: string; places: number }>;
	keptBoth: Array<{ path: string; copy: string }>;
	restored: string[];
	deferred: string[];
	skipped: Array<{ path: string; reason: string }>;
	commit: string | null;
	initialized: boolean;
}

export class MassDeleteError extends Error {
	constructor(
		readonly here: number,
		readonly there: number,
	) {
		super(`This sync would delete ${here} files here and ${there} on GitHub.`);
	}
}

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

export async function sync(
	initial: SyncState,
	options: SyncOptions,
): Promise<{ state: SyncState; report: SyncReport }> {
	const { fs, remote } = options;
	const now = options.now ?? (() => new Date());
	const report = emptyReport();
	let state = initial;

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const head = await remote.head();
		if (head === null) {
			await initialize(options);
			report.initialized = true;
			continue;
		}

		options.progress?.("Checking GitHub");
		const { tree, files: remoteFiles } = await readRemote(remote, state, head, options, report);
		const first = state.commit === null;
		// a rerun after the first half of a first sync is saved is an ordinary sync
		const firstSync = first ? (options.firstSync ?? "merge") : "merge";
		const tracked = new Set([...Object.keys(state.base), ...remoteFiles.keys()]);
		const ignores = first ? await remoteIgnores(remoteFiles, head, options) : undefined;
		options.progress?.("Checking the vault");
		const scan = await scanLocal(fs, state.cache, tracked, options.stateFile, ignores);

		const base = new Map(Object.entries(state.base));
		const local = new Map([...scan.files].map(([p, e]) => [p, e.sha] as const));
		const remoteShas = new Map([...remoteFiles].map(([p, f]) => [p, f.sha] as const));
		let actions: Action[];
		if (firstSync === "merge") {
			if (first) await findHistoricalBases(base, local, remoteShas, head, options);
			const renames = await confirmRenames(base, local, remoteShas, scan.files, head, options);
			actions = plan(base, local, remoteShas, renames);
			if (!options.allowMassDelete) guardMassDelete(actions, base.size);
		} else {
			// no mass-delete guard: the user asked for exactly this
			const own = `${options.stateFile.slice(0, options.stateFile.lastIndexOf("/"))}/`;
			actions = planReplace(
				local,
				remoteShas,
				firstSync === "use-local" ? "local" : "remote",
				(path) => path === ".gitignore" || path.endsWith("/.gitignore") || path.startsWith(own),
			);
		}

		const incoming = await applyIncoming(
			actions,
			scan.files,
			remoteFiles,
			state,
			head,
			options,
			now,
			report,
		);

		const pulledBase: Record<string, string> = {};
		for (const [path, file] of remoteFiles) pulledBase[path] = file.sha;
		for (const path of incoming.deferred) {
			const old = state.base[path];
			if (old === undefined) delete pulledBase[path];
			else pulledBase[path] = old;
		}
		const cache = { ...scan.cache };
		for (const path of incoming.touched) delete cache[path];
		// `readRemote` rebuilds an unchanged remote from `base`, which deferred paths make wrong
		const knownTree = incoming.deferred.size > 0 ? null : tree;
		state = withKept(
			{
				...state,
				commit: head,
				tree: knownTree,
				base: pulledBase,
				modes: modesOf(remoteFiles),
				cache,
				conflicts: unique([...state.conflicts, ...report.conflicts.map((c) => c.path)]),
			},
			addKept(state.kept, state.commit, incoming.kept),
		);
		await options.saveState(state);

		const changes: Change[] = [];
		const newShas = new Map<string, string | null>();
		let edited = 0;
		for (const [path, upload] of incoming.outgoing) {
			if (incoming.deferred.has(path)) continue;
			const existing = remoteFiles.get(path);
			if (upload === null) {
				if (!existing) continue;
				changes.push({ path, read: null, mode: existing.mode });
				newShas.set(path, null);
				continue;
			}
			if (upload.size > MAX_FILE_SIZE) {
				report.skipped.push({ path, reason: "larger than GitHub's 100 MB limit" });
				continue;
			}
			if (existing?.sha === upload.sha) continue;
			changes.push({
				path,
				mode: existing?.mode ?? "100644",
				// hashed as read: the base must record what was uploaded, not what was scanned
				read: async () => {
					const bytes = await upload.read();
					newShas.set(path, await gitBlobSha(bytes));
					return bytes;
				},
			});
			newShas.set(path, upload.sha);
			if (upload.edited !== null) edited = Math.max(edited, upload.edited);
		}
		const kept = state.kept;
		if (changes.length === 0 && !kept) return { state, report };

		options.progress?.(
			changes.length > 0
				? `Uploading ${changes.length} ${changes.length === 1 ? "file" : "files"}`
				: "Keeping this device's version in the history",
		);
		const message = commitMessage({
			device: options.device,
			files: unique([...changes.map((c) => c.path), ...(kept?.files.map((f) => f.path) ?? [])]),
			deleted: new Set(changes.filter((c) => c.read === null).map((c) => c.path)),
		});
		const result = await remote.commit({
			parent: head,
			baseTree: tree,
			changes,
			message,
			// "the newer version" is judged by author date
			authored: edited > 0 ? new Date(edited) : null,
			kept: kept ? keptCommit(kept, options.device) : null,
		});
		if (result === "moved") continue;

		const finalBase = { ...state.base };
		for (const [path, sha] of newShas) {
			if (sha === null) delete finalBase[path];
			else finalBase[path] = sha;
		}
		const modes = { ...state.modes };
		for (const change of changes) {
			if (change.read === null || change.mode === "100644") delete modes[change.path];
			else modes[change.path] = change.mode;
		}
		for (const change of changes) {
			if (change.read === null) report.deletedThere.push(change.path);
			else report.pushed.push(change.path);
		}
		report.commit = result.commit;
		state = withKept(
			{
				...state,
				commit: result.commit,
				tree: knownTree === null ? null : result.tree,
				base: finalBase,
				modes,
			},
			undefined,
		);
		return { state, report };
	}
	throw new Error("GitHub kept changing while syncing. Will try again shortly.");
}

export interface SyncPreview {
	same: number;
	upload: number;
	download: number;
	merge: number;
	deleteHere: number;
	deleteThere: number;
	emptyRemote: boolean;
	// outside the config folder: a fresh vault always has config files of its own
	notes: { here: number; there: number; differ: number };
}

export async function preview(state: SyncState, options: SyncOptions): Promise<SyncPreview> {
	const head = await options.remote.head();
	const report = emptyReport();
	const remoteFiles =
		head === null
			? new Map<string, RemoteFile>()
			: (await readRemote(options.remote, state, head, options, report)).files;
	const tracked = new Set([...Object.keys(state.base), ...remoteFiles.keys()]);
	let ignores: Map<string, string> | undefined;
	// an empty repository gets the starting `.gitignore` before anything is uploaded
	let addsGitignore = false;
	if (head === null) {
		addsGitignore = !(await hasFile(options.fs, ".gitignore"));
		if (addsGitignore) ignores = new Map([["", defaultGitignore(options.configDir)]]);
	} else if (state.commit === null) {
		ignores = await remoteIgnores(remoteFiles, head, options);
	}
	const scan = await scanLocal(options.fs, state.cache, tracked, options.stateFile, ignores);
	const local = new Map([...scan.files].map(([p, e]) => [p, e.sha] as const));
	const actions = plan(
		new Map(Object.entries(state.base)),
		local,
		new Map([...remoteFiles].map(([p, f]) => [p, f.sha] as const)),
	);
	const isNote = (path: string) => !path.startsWith(`${options.configDir}/`);
	const count = (...kinds: Action["kind"][]) =>
		actions.filter((a) => kinds.includes(a.kind)).length;
	let same = 0;
	for (const [path, sha] of local) if (remoteFiles.get(path)?.sha === sha) same++;
	return {
		same,
		upload: count("push", "resurrect", "push-renamed") + (addsGitignore ? 1 : 0),
		download: count("pull", "restore", "pull-renamed"),
		merge: count("merge"),
		deleteHere: count("delete-local"),
		deleteThere: count("delete-remote"),
		emptyRemote: head === null,
		notes: {
			here: [...local.keys()].filter(isNote).length,
			there: [...remoteFiles.keys()].filter(isNote).length,
			differ: actions.filter((a) => isNote("path" in a ? a.path : a.to)).length,
		},
	};
}

function emptyReport(): SyncReport {
	return {
		pulled: [],
		pushed: [],
		deletedHere: [],
		deletedThere: [],
		merged: [],
		conflicts: [],
		newer: [],
		keptBoth: [],
		restored: [],
		deferred: [],
		skipped: [],
		commit: null,
		initialized: false,
	};
}

async function hasFile(fs: LocalFs, path: string): Promise<boolean> {
	try {
		await fs.read(path);
		return true;
	} catch {
		return false;
	}
}

async function initialize(options: SyncOptions): Promise<void> {
	let content: Uint8Array;
	try {
		content = await options.fs.read(".gitignore");
	} catch {
		content = new TextEncoder().encode(defaultGitignore(options.configDir));
	}
	const message = commitMessage({
		device: options.device,
		files: [".gitignore"],
	});
	await options.remote.initialize(".gitignore", content, message);
}

async function readRemote(
	remote: Remote,
	state: SyncState,
	head: string,
	options: SyncOptions,
	report: SyncReport,
): Promise<{ tree: string; files: Map<string, RemoteFile> }> {
	if (head === state.commit && state.tree) {
		const files = new Map<string, RemoteFile>();
		for (const [path, sha] of Object.entries(state.base)) {
			files.set(path, { sha, mode: state.modes[path] ?? "100644" });
		}
		return { tree: state.tree, files };
	}
	const read = await remote.readTree(head);
	const files = new Map<string, RemoteFile>();
	const lower = new Set<string>();
	for (const path of [...read.files.keys()].sort()) {
		const file = read.files.get(path);
		if (!file || isHardExcluded(path, options.stateFile)) continue;
		const key = path.toLowerCase();
		if (lower.has(key)) {
			report.skipped.push({
				path,
				reason: "differs from another file on GitHub only in letter case",
			});
			continue;
		}
		lower.add(key);
		files.set(path, file);
	}
	return { tree: read.tree, files };
}

// a fresh vault must not upload its workspace files before GitHub's `.gitignore` has come down
async function remoteIgnores(
	remoteFiles: Map<string, RemoteFile>,
	head: string,
	options: SyncOptions,
): Promise<Map<string, string>> {
	const wanted = [...remoteFiles]
		.filter(([path]) => path === ".gitignore" || path.endsWith("/.gitignore"))
		.map(([path, file]) => ({ sha: file.sha, path }));
	const out = new Map<string, string>();
	if (wanted.length === 0) return out;
	let blobs: Map<string, Uint8Array>;
	try {
		blobs = await options.remote.readBlobs(wanted, head);
	} catch {
		return out;
	}
	for (const { sha, path } of wanted) {
		const bytes = blobs.get(sha);
		const text = bytes ? decodeText(bytes) : null;
		if (text !== null) out.set(path.slice(0, Math.max(0, path.lastIndexOf("/"))), text);
	}
	return out;
}

const HISTORY_VERSIONS = 10;
const HISTORY_BUDGET = 1500;

// exact matches only: a merely similar version as base would delete lines GitHub still has
async function findHistoricalBases(
	base: Map<string, string>,
	local: Snapshot,
	remote: Snapshot,
	head: string,
	options: SyncOptions,
): Promise<void> {
	const differing = [...local]
		.filter(([path, sha]) => !base.has(path) && remote.has(path) && remote.get(path) !== sha)
		.map(([path]) => path);
	if (differing.length === 0) return;
	let budget = HISTORY_BUDGET;
	let done = 0;
	options.progress?.("Looking through GitHub's history");
	await pool(differing, 4, async (path) => {
		if (budget <= 0) return;
		let versions: string[];
		try {
			versions = await options.remote.fileHistory(path, head, HISTORY_VERSIONS);
		} catch {
			return;
		} finally {
			options.progress?.(`Looking through GitHub's history (${++done} of ${differing.length})`);
		}
		budget -= versions.length + 1;
		const sha = local.get(path);
		if (sha !== undefined && versions.includes(sha)) base.set(path, sha);
	});
}

const MAX_RENAME_PAIRS = 200;

async function confirmRenames(
	base: Snapshot,
	local: Snapshot,
	remote: Snapshot,
	localFiles: Map<string, LocalEntry>,
	head: string,
	options: SyncOptions,
): Promise<RenameCandidate[]> {
	const candidates = renameCandidates(base, local, remote);
	if (candidates.length === 0 || candidates.length > MAX_RENAME_PAIRS) return [];

	const wanted: Array<{ sha: string; path: string }> = [];
	for (const c of candidates) {
		const b = base.get(c.from);
		if (b) wanted.push({ sha: b, path: c.from });
		const r = c.side === "remote" ? remote.get(c.to) : undefined;
		if (r) wanted.push({ sha: r, path: c.to });
	}
	let blobs: Map<string, Uint8Array>;
	try {
		blobs = await options.remote.readBlobs(wanted, head);
	} catch {
		return [];
	}
	const text = (bytes: Uint8Array | undefined) => (bytes ? decodeText(bytes) : null);

	const scored: Array<{ candidate: RenameCandidate; score: number }> = [];
	for (const candidate of candidates) {
		const before = text(blobs.get(base.get(candidate.from) ?? ""));
		let after: string | null;
		if (candidate.side === "remote") {
			after = text(blobs.get(remote.get(candidate.to) ?? ""));
		} else {
			const entry = localFiles.get(candidate.to);
			after = entry ? text(await options.fs.read(entry.actual).catch(() => undefined)) : null;
		}
		if (before === null || after === null) continue;
		const score = similarity(before, after);
		if (score >= RENAME_SIMILARITY) scored.push({ candidate, score });
	}

	const taken = new Set<string>();
	const confirmed: RenameCandidate[] = [];
	for (const { candidate } of scored.sort((a, b) => b.score - a.score)) {
		if (taken.has(candidate.from) || taken.has(candidate.to)) continue;
		taken.add(candidate.from).add(candidate.to);
		confirmed.push(candidate);
	}
	return confirmed;
}

function guardMassDelete(actions: Action[], baseSize: number): void {
	const here = actions.filter((a) => a.kind === "delete-local").length;
	const there = actions.filter((a) => a.kind === "delete-remote").length;
	const limit = Math.max(20, baseSize / 2);
	if (here > limit || there > limit) throw new MassDeleteError(here, there);
}

interface Upload {
	sha: string;
	size: number;
	read(): Promise<Uint8Array>;
	edited: number | null;
}

async function uploadOf(bytes: Uint8Array, edited: number | null = null): Promise<Upload> {
	return { sha: await gitBlobSha(bytes), size: bytes.length, read: async () => bytes, edited };
}

interface Incoming {
	outgoing: Map<string, Upload | null>;
	deferred: Set<string>;
	touched: Set<string>;
	kept: KeptVersions["files"];
}

interface Author {
	name: string;
	time: Date | null;
}

type PullAction = Extract<Action, { kind: "pull" | "restore" | "pull-renamed" | "replace-local" }>;

async function applyIncoming(
	actions: Action[],
	local: Map<string, LocalEntry>,
	remoteFiles: Map<string, RemoteFile>,
	state: SyncState,
	head: string,
	options: SyncOptions,
	now: () => Date,
	report: SyncReport,
): Promise<Incoming> {
	const { fs, remote } = options;
	const strategy = options.conflicts ?? "keep-both";
	const outgoing = new Map<string, Upload | null>();
	const deferred = new Set<string>();
	const touched = new Set<string>();
	const kept: KeptVersions["files"] = [];

	const wanted: Array<{ sha: string; path: string }> = [];
	for (const action of actions) {
		if (action.kind === "merge") {
			wanted.push({ sha: action.remote, path: action.path });
			if (action.base) wanted.push({ sha: action.base, path: action.path });
		}
		if (action.kind === "merge-renamed") {
			const remotePath = action.renamedOn === "local" ? action.from : action.to;
			wanted.push({ sha: action.remote, path: remotePath });
			wanted.push({ sha: action.base, path: action.from });
		}
	}
	if (wanted.length > 0) options.progress?.("Merging");
	const blobs =
		wanted.length === 0 ? new Map<string, Uint8Array>() : await remote.readBlobs(wanted, head);

	const blob = (sha: string, path: string): Uint8Array => {
		const bytes = blobs.get(sha);
		if (!bytes) throw new Error(`Could not download ${path} from GitHub.`);
		return bytes;
	};
	const readLocal = (path: string): Promise<Uint8Array> => {
		const entry = local.get(path);
		return fs.read(entry?.actual ?? path);
	};
	const localUpload = (path: string): Upload | null => {
		const entry = local.get(path);
		if (!entry) return null;
		return {
			sha: entry.sha,
			size: entry.size,
			read: () => fs.read(entry.actual),
			edited: entry.mtime,
		};
	};
	const actualPath = (path: string) => local.get(path)?.actual ?? path;
	const write = async (
		path: string,
		data: Uint8Array,
		expected: string | null,
	): Promise<boolean> => {
		touched.add(actualPath(path));
		const ok = await fs.write(actualPath(path), data, expected);
		if (!ok) {
			deferred.add(path);
			report.deferred.push(path);
		}
		return ok;
	};

	// one request per sync for clean merges, one per file only for a file that clashes
	let everyone: Promise<Author> | null = null;
	const sinceLastSync = (): Promise<Author> => {
		if (!everyone) everyone = describeRemote(remote, state.commit, head);
		return everyone;
	};
	const authors = new Map<string, Promise<Author>>();
	const lastAuthor = (path: string): Promise<Author> => {
		let author = authors.get(path);
		if (!author) {
			author = remote.lastChange(path, head).then(
				(commit) =>
					commit
						? {
								name: deviceFromMessage(commit.message) ?? "GitHub",
								time: commit.authored ?? commit.date,
							}
						: sinceLastSync(),
				() => sinceLastSync(),
			);
			authors.set(path, author);
		}
		return author;
	};

	const mergeVersions = async (
		path: string,
		remotePath: string,
		baseBytes: Uint8Array | null,
		localBytes: Uint8Array,
		remoteBytes: Uint8Array,
		localEntry: LocalEntry | undefined,
	): Promise<{
		merged: FileMerge;
		other: Author;
		prefer: Side | undefined;
		edited: number | null;
	}> => {
		const localTime = localEntry ? new Date(localEntry.mtime) : null;
		const clean = mergeFile(path, baseBytes, localBytes, remoteBytes, { local: "", remote: "" });
		if (clean.kind === "merged" && clean.conflicts === 0) {
			const other = await sinceLastSync();
			return { merged: clean, other, prefer: undefined, edited: latest(localTime, other.time) };
		}
		const other = await lastAuthor(remotePath);
		const prefer = strategy === "newest" ? newerOf(localTime, other.time) : undefined;
		const merged = mergeFile(
			path,
			baseBytes,
			localBytes,
			remoteBytes,
			{ local: sideLabel(options.device, localTime), remote: sideLabel(other.name, other.time) },
			prefer,
		);
		return { merged, other, prefer, edited: latest(localTime, other.time) };
	};

	// stored on GitHub before it is overwritten, so the next commit can keep it in the history
	const keep = async (path: string, bytes: Uint8Array, entry: LocalEntry | undefined) => {
		const sha = await remote.storeBlob(bytes);
		kept.push({
			path,
			sha,
			mode: remoteFiles.get(path)?.mode ?? "100644",
			edited: entry?.mtime ?? null,
		});
	};
	const unkeep = (path: string) => {
		const at = kept.findIndex((file) => file.path === path);
		if (at !== -1) kept.splice(at, 1);
	};

	const takenPaths = new Set([...local.keys(), ...remoteFiles.keys()]);

	// removals first: a rename that only changes letter case must free the old name
	for (const action of actions) {
		if (action.kind === "delete-local") {
			const entry = local.get(action.path);
			if (!entry) continue;
			touched.add(entry.actual);
			if (await fs.remove(entry.actual, entry.sha)) report.deletedHere.push(action.path);
			else {
				deferred.add(action.path);
				report.deferred.push(action.path);
			}
		}
	}

	const pulls: PullAction[] = [];
	for (const action of actions) {
		switch (action.kind) {
			case "push":
			case "resurrect": {
				const upload = localUpload(action.path);
				if (upload) outgoing.set(action.path, upload);
				if (action.kind === "resurrect") report.restored.push(action.path);
				break;
			}
			case "pull":
			case "restore":
			case "pull-renamed":
			case "replace-local":
				pulls.push(action);
				break;
			case "delete-local":
				break;
			case "delete-remote":
				outgoing.set(action.path, null);
				break;
			case "merge": {
				const localBytes = await readLocal(action.path);
				const remoteBytes = blob(action.remote, action.path);
				const baseBytes = action.base ? (blobs.get(action.base) ?? null) : null;
				const localEntry = local.get(action.path);
				const { merged, other, prefer, edited } = await mergeVersions(
					action.path,
					action.path,
					baseBytes,
					localBytes,
					remoteBytes,
					localEntry,
				);
				const winner = prefer === "remote" ? other.name : options.device;
				if (merged.kind === "merged") {
					const losing = prefer === "remote" && merged.replaced > 0;
					if (losing) await keep(action.path, localBytes, localEntry);
					if (await write(action.path, merged.bytes, action.local)) {
						outgoing.set(action.path, await uploadOf(merged.bytes, edited));
						report.merged.push(action.path);
						if (merged.conflicts > 0)
							report.conflicts.push({ path: action.path, count: merged.conflicts });
						if (merged.replaced > 0)
							report.newer.push({ path: action.path, from: winner, places: merged.replaced });
					} else if (losing) {
						unkeep(action.path);
					}
				} else if (merged.kind === "take") {
					if (merged.side === "local") {
						const upload = localUpload(action.path);
						if (upload) outgoing.set(action.path, upload);
						report.newer.push({ path: action.path, from: winner, places: 0 });
					} else {
						await keep(action.path, localBytes, localEntry);
						if (await write(action.path, remoteBytes, action.local)) {
							report.newer.push({ path: action.path, from: winner, places: 0 });
						} else {
							unkeep(action.path);
						}
					}
				} else {
					const copy = conflictCopyPath(action.path, other.name, now(), (p) => takenPaths.has(p));
					takenPaths.add(copy);
					if (await write(copy, remoteBytes, null)) {
						outgoing.set(action.path, await uploadOf(localBytes, localEntry?.mtime ?? null));
						outgoing.set(copy, await uploadOf(remoteBytes));
						report.keptBoth.push({ path: action.path, copy });
					}
				}
				break;
			}
			case "merge-renamed": {
				const localPath = action.renamedOn === "local" ? action.to : action.from;
				const remotePath = action.renamedOn === "local" ? action.from : action.to;
				const localBytes = await readLocal(localPath);
				const remoteBytes = blob(action.remote, remotePath);
				const localEntry = local.get(localPath);
				const { merged, other, prefer, edited } = await mergeVersions(
					action.to,
					remotePath,
					blobs.get(action.base) ?? null,
					localBytes,
					remoteBytes,
					localEntry,
				);
				if (merged.kind !== "merged") {
					// will not merge: the edit made under the old name comes back next to the renamed note
					if (action.renamedOn === "local") {
						if (await write(action.from, remoteBytes, null)) {
							outgoing.set(action.to, await uploadOf(localBytes, localEntry?.mtime ?? null));
							report.restored.push(action.from);
						}
					} else if (await write(action.to, remoteBytes, null)) {
						outgoing.set(action.from, await uploadOf(localBytes, localEntry?.mtime ?? null));
						report.restored.push(action.from);
					}
					break;
				}
				const losing = prefer === "remote" && merged.replaced > 0;
				if (losing) await keep(localPath, localBytes, localEntry);
				const expected = action.renamedOn === "local" ? action.local : null;
				if (await write(action.to, merged.bytes, expected)) {
					if (action.renamedOn === "remote") {
						const entry = local.get(action.from);
						if (entry) {
							touched.add(entry.actual);
							await fs.remove(entry.actual, action.local);
						}
					} else {
						outgoing.set(action.from, null);
					}
					outgoing.set(action.to, await uploadOf(merged.bytes, edited));
					report.merged.push(action.to);
					if (merged.conflicts > 0)
						report.conflicts.push({ path: action.to, count: merged.conflicts });
					if (merged.replaced > 0) {
						const winner = prefer === "remote" ? other.name : options.device;
						report.newer.push({ path: action.to, from: winner, places: merged.replaced });
					}
				} else if (losing) {
					unkeep(localPath);
				}
				break;
			}
			case "push-renamed": {
				const content = await readLocal(action.from);
				if (await write(action.to, content, null)) {
					const entry = local.get(action.from);
					if (entry) {
						touched.add(entry.actual);
						await fs.remove(entry.actual, action.localSha);
					}
					outgoing.set(action.to, await uploadOf(content, entry?.mtime ?? null));
				}
				break;
			}
		}
	}

	// written as they arrive and let go, so a first sync never holds the vault in memory
	if (pulls.length > 0) {
		const bySha = new Map<string, PullAction[]>();
		for (const action of pulls) bySha.set(action.sha, [...(bySha.get(action.sha) ?? []), action]);
		const pull = async (action: PullAction, content: Uint8Array) => {
			if (action.kind === "pull-renamed") {
				if (await write(action.to, content, action.localSha)) {
					outgoing.set(action.to, await uploadOf(content));
					outgoing.set(action.from, null);
					report.pulled.push(action.to);
				}
				return;
			}
			if (action.kind === "replace-local") {
				// replaced in place so an open note keeps its tab
				const entry = local.get(action.path);
				if (entry) await fs.backup(entry.actual);
				if (await write(action.path, content, action.local)) report.pulled.push(action.path);
				return;
			}
			const expected = local.get(action.path)?.sha ?? null;
			if (await write(action.path, content, expected)) {
				if (action.kind === "restore") report.restored.push(action.path);
				else report.pulled.push(action.path);
			}
		};
		options.progress?.(`Downloading ${pulls.length} ${pulls.length === 1 ? "file" : "files"}`);
		const arrived = new Set<string>();
		// writes one at a time, so two new files in one new folder do not both create it
		let writing: Promise<void> = Promise.resolve();
		await remote.readBlobs(
			pulls.map((a) => ({ sha: a.sha, path: a.kind === "pull-renamed" ? a.from : a.path })),
			head,
			(done, total) => options.progress?.(`Downloading ${done} of ${total}`),
			(sha, bytes) => {
				const next = writing.then(async () => {
					arrived.add(sha);
					for (const action of bySha.get(sha) ?? []) await pull(action, bytes);
				});
				writing = next.catch(() => undefined);
				return next;
			},
		);
		await writing;
		const missing = pulls.find((a) => !arrived.has(a.sha));
		if (missing) {
			const path = missing.kind === "pull-renamed" ? missing.from : missing.path;
			throw new Error(`Could not download ${path} from GitHub.`);
		}
	}
	return { outgoing, deferred, touched, kept };
}

// a tie goes to this device
function newerOf(local: Date | null, remote: Date | null): Side | undefined {
	if (!local || !remote) return undefined;
	return remote.getTime() > local.getTime() ? "remote" : "local";
}

function latest(...dates: Array<Date | null>): number | null {
	const times = dates.filter((d): d is Date => d !== null).map((d) => d.getTime());
	return times.length === 0 ? null : Math.max(...times);
}

// versions still waiting from an earlier round win: they are what this device had first
function addKept(
	waiting: KeptVersions | undefined,
	parent: string | null,
	added: KeptVersions["files"],
): KeptVersions | undefined {
	if (added.length === 0) return waiting;
	const files = [...(waiting?.files ?? [])];
	for (const file of added) if (!files.some((f) => f.path === file.path)) files.push(file);
	return { parent: waiting ? waiting.parent : parent, files };
}

function withKept(state: SyncState, kept: KeptVersions | undefined): SyncState {
	const { kept: _, ...rest } = state;
	return kept ? { ...rest, kept } : rest;
}

function keptCommit(kept: KeptVersions, device: string): KeptCommit {
	const edited = Math.max(0, ...kept.files.map((f) => f.edited ?? 0));
	return {
		parent: kept.parent,
		files: kept.files.map(({ path, sha, mode }) => ({ path, sha, mode })),
		message: commitMessage({ device, files: kept.files.map((f) => f.path), superseded: true }),
		authored: edited > 0 ? new Date(edited) : null,
	};
}

async function describeRemote(remote: Remote, base: string | null, head: string): Promise<Author> {
	let commits: Awaited<ReturnType<Remote["commitsSince"]>> = [];
	try {
		commits = await remote.commitsSince(base, head);
	} catch {
		// labels are a nicety, a failed lookup must not fail the sync
	}
	commits = commits.filter((c) => !isSuperseded(c.message));
	const devices = unique(commits.map((c) => deviceFromMessage(c.message) ?? "GitHub"));
	const name = devices.length === 0 ? "GitHub" : devices.slice(0, 2).join(", ");
	const newest = commits[0];
	return { name, time: newest ? (newest.authored ?? newest.date) : null };
}

function modesOf(files: Map<string, RemoteFile>): Record<string, string> {
	const modes: Record<string, string> = {};
	for (const [path, file] of files) if (file.mode !== "100644") modes[path] = file.mode;
	return modes;
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			await run(item);
		}
	});
	await Promise.all(workers);
}
