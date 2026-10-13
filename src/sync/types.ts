export interface LocalFile {
	path: string;
	mtime: number;
	size: number;
}

export interface LocalFs {
	listDir(dir: string): Promise<{ files: LocalFile[]; folders: string[] }>;
	read(path: string): Promise<Uint8Array>;
	// false when the file no longer has `expectedSha` (the user typed during the sync)
	write(path: string, data: Uint8Array, expectedSha: string | null): Promise<boolean>;
	remove(path: string, expectedSha: string): Promise<boolean>;
	backup(path: string): Promise<void>;
}

export interface RemoteFile {
	sha: string;
	mode: string;
	size?: number;
}

export interface RemoteTree {
	tree: string;
	files: Map<string, RemoteFile>;
}

export interface RemoteCommit {
	sha: string;
	message: string;
	date: Date | null;
	// for this plugin's commits, when the newest edit in it was made, not when it synced
	authored: Date | null;
	parent: string | null;
}

export interface Change {
	path: string;
	// null deletes the path; read lazily so an upload never holds the whole vault
	read: (() => Promise<Uint8Array>) | null;
	mode: string;
}

export interface Remote {
	head(): Promise<string | null>;
	readTree(commit: string): Promise<RemoteTree>;
	// with `each`, blobs are handed to it as they arrive and the returned map stays empty
	readBlobs(
		wanted: Array<{ sha: string; path: string }>,
		commit: string,
		progress?: (done: number, total: number) => void,
		each?: (sha: string, bytes: Uint8Array) => Promise<void>,
	): Promise<Map<string, Uint8Array>>;
	// "moved" when another device pushed since `parent`; nothing is changed then
	commit(input: {
		parent: string;
		baseTree: string;
		changes: Change[];
		message: string;
		authored?: Date | null;
		kept?: KeptCommit | null;
	}): Promise<{ commit: string; tree: string } | "moved">;
	storeBlob(content: Uint8Array): Promise<string>;
	initialize(path: string, content: Uint8Array, message: string): Promise<void>;
	commitsSince(base: string | null, head: string): Promise<RemoteCommit[]>;
	// skips commits that only hold a version which lost to a newer one
	lastChange(path: string, head: string): Promise<RemoteCommit | null>;
	fileHistory(path: string, head: string, max: number): Promise<string[]>;
}

export interface KeptVersions {
	parent: string | null;
	files: Array<{ path: string; sha: string; mode: string; edited: number | null }>;
}

export interface KeptCommit {
	parent: string | null;
	files: Array<{ path: string; sha: string; mode: string }>;
	message: string;
	authored: Date | null;
}

export interface SyncState {
	version: 1;
	target: string;
	commit: string | null;
	tree: string | null;
	base: Record<string, string>;
	modes: Record<string, string>;
	cache: Record<string, { mtime: number; size: number; sha: string }>;
	conflicts: string[];
	// kept in the state, not in memory: iOS may kill the app between the two halves of a sync
	kept?: KeptVersions;
}

export function emptyState(target: string): SyncState {
	return {
		version: 1,
		target,
		commit: null,
		tree: null,
		base: {},
		modes: {},
		cache: {},
		conflicts: [],
	};
}
