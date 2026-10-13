import { decodeText } from "../lib/bytes";
import { gitBlobSha } from "../lib/githash";
import { GitIgnore, isHardExcluded } from "./ignore";
import type { LocalFs, SyncState } from "./types";

export interface LocalEntry {
	// GitHub's spelling when only letter case differs; `actual` is the one on disk
	path: string;
	actual: string;
	sha: string;
	mtime: number;
	size: number;
}

export interface LocalScan {
	files: Map<string, LocalEntry>;
	cache: SyncState["cache"];
}

export async function scanLocal(
	fs: LocalFs,
	cache: SyncState["cache"],
	tracked: ReadonlySet<string>,
	stateFile: string,
	fallbackIgnores: ReadonlyMap<string, string> = new Map(),
): Promise<LocalScan> {
	// lower-cased: macOS, iOS and Windows treat spellings that differ in case as one path
	const trackedDirs = new Set<string>();
	const byLower = new Map<string, string>();
	for (const path of tracked) {
		byLower.set(path.toLowerCase(), path);
		for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) {
			trackedDirs.add(path.slice(0, i).toLowerCase());
		}
	}

	const ignore = new GitIgnore();
	// the Git plugin keeps its askpass script out of the repository through this file
	try {
		const exclude = decodeText(await fs.read(".git/info/exclude"));
		if (exclude !== null) ignore.addExclude(exclude);
	} catch {
		// no .git, or no exclude file
	}
	const found = new Map<string, LocalEntry>();
	const nextCache: SyncState["cache"] = {};
	// each listing and read is a native round trip on iOS; a first scan reads every file
	const listing = limit(8);
	const reading = limit(4);

	// `ignored`: entered only because something tracked is inside
	const walk = async (dir: string, ignored: boolean): Promise<void> => {
		const entries = await listing(() => fs.listDir(dir));
		const gitignorePath = dir === "" ? ".gitignore" : `${dir}/.gitignore`;
		if (entries.files.some((f) => f.path === gitignorePath)) {
			const text = decodeText(await reading(() => fs.read(gitignorePath)));
			if (text !== null) ignore.add(dir, text);
		} else {
			const fallback = fallbackIgnores.get(dir);
			if (fallback !== undefined) ignore.add(dir, fallback);
		}
		const files = entries.files.map(async (file) => {
			if (isHardExcluded(file.path, stateFile)) return;
			const canonical = tracked.has(file.path)
				? file.path
				: (byLower.get(file.path.toLowerCase()) ?? file.path);
			// as in git, nothing inside an ignored folder can be un-ignored
			if (!tracked.has(canonical) && (ignored || ignore.ignores(file.path, false))) return;
			const cached = cache[file.path];
			let sha: string;
			if (cached && cached.mtime === file.mtime && cached.size === file.size) {
				sha = cached.sha;
			} else {
				sha = await reading(async () => gitBlobSha(await fs.read(file.path)));
			}
			nextCache[file.path] = { mtime: file.mtime, size: file.size, sha };
			if (found.has(canonical)) return; // two spellings of one tracked path: one wins
			found.set(canonical, {
				path: canonical,
				actual: file.path,
				sha,
				mtime: file.mtime,
				size: file.size,
			});
		});
		const folders = entries.folders.map(async (folder) => {
			if (isHardExcluded(folder, stateFile)) return;
			const ignoredHere = ignored || ignore.ignores(folder, true);
			if (ignoredHere && !trackedDirs.has(folder.toLowerCase())) return;
			await walk(folder, ignoredHere);
		});
		await Promise.all([...files, ...folders]);
	};

	await walk("", false);
	const files = new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	return { files, cache: nextCache };
}

function limit(size: number): <T>(task: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async (task) => {
		if (active < size) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await task();
		} finally {
			// the slot passes straight to the next task instead of being freed
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}
