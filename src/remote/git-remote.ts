import { isSuperseded } from "../lib/format";
import type {
	Change,
	KeptCommit,
	Remote,
	RemoteCommit,
	RemoteFile,
	RemoteTree,
} from "../sync/types";
import {
	type Commit,
	type GitObject,
	hashObject,
	parseCommit,
	parseTree,
	signature,
	signatureDate,
	TREE_MODE,
	type TreeEntry,
	writeCommit,
	writeTree,
	ZERO_SHA,
} from "./git/objects";
import { writePack } from "./git/pack";
import type { GitHttp } from "./git/smart";
import { RemoteError } from "./http";

export interface Identity {
	name: string;
	email: string;
}

// keeps this device's losing versions until they are pushed: unlike an API upload, a blob
// cannot go to a git server on its own, and iOS may kill the app before the commit
export interface BlobStash {
	get(sha: string): Promise<Uint8Array | null>;
	put(sha: string, bytes: Uint8Array): Promise<void>;
	delete(sha: string): Promise<void>;
}

const HISTORY_DEPTH = 100;
const SINCE_DEPTH = 50;
const WANT_BATCH = 100;
const CONCURRENCY = 6;

interface Edit {
	parts: string[];
	entry: { sha: string; mode: string } | null;
}

export class GitRemote implements Remote {
	private readonly trees = new Map<string, TreeEntry[]>();
	private readonly commits = new Map<string, Commit>();
	private readonly roots = new Map<string, string>();
	private readonly blobs = new Map<string, Uint8Array>();
	private readonly keptBlobs = new Map<string, Uint8Array>();
	private readonly whole = new Set<string>();
	private recent: string[] = [];
	private deepened: string | null = null;

	constructor(
		private readonly git: GitHttp,
		readonly branch: string,
		private readonly identity: () => Promise<Identity>,
		private readonly stash: BlobStash | null = null,
	) {}

	private get ref(): string {
		return `refs/heads/${this.branch}`;
	}

	async head(): Promise<string | null> {
		const refs = await this.git.refs();
		const sha = refs.heads.get(this.branch);
		if (sha) return sha;
		if (refs.heads.size === 0) return null;
		throw new RemoteError(
			404,
			`The branch "${this.branch}" does not exist on ${this.git.name}.`,
			"not-found",
		);
	}

	async seed(commit: string, tree: string, files: Map<string, RemoteFile>): Promise<void> {
		if (!this.isWhole(tree)) {
			const built = new Map<string, TreeEntry[]>();
			const root = await buildTree(
				[...files].map(([path, file]) => ({
					parts: path.split("/"),
					entry: { sha: file.sha, mode: file.mode },
				})),
				built,
			);
			// only trusted when it hashes to the tree the state recorded
			if (root !== tree) return;
			for (const [sha, entries] of built) this.trees.set(sha, entries);
		}
		this.roots.set(commit, tree);
		this.remember(commit);
	}

	async readTree(commit: string): Promise<RemoteTree> {
		const tree = await this.ensure(commit);
		const files = new Map<string, RemoteFile>();
		this.flatten(tree, "", files);
		return { tree, files };
	}

	// fetches a commit with all its folders, sending what this device already has
	private async ensure(commit: string): Promise<string> {
		const known = this.roots.get(commit);
		if (known !== undefined && this.isWhole(known)) return known;
		const haves = this.recent.filter((sha) => sha !== commit);
		await this.load({
			wants: [commit],
			haves,
			depth: haves.length > 0 ? SINCE_DEPTH : 1,
			blobless: true,
		});
		let root = this.roots.get(commit);
		if (root === undefined || !this.isWhole(root)) {
			// what was held back as already here was not all here after all
			await this.load({ wants: [commit], depth: 1, blobless: true });
			root = this.roots.get(commit);
		}
		if (root === undefined || !this.isWhole(root))
			throw new RemoteError(0, `${this.git.name} did not send commit ${commit}.`, "other");
		this.remember(commit);
		return root;
	}

	private async load(request: Parameters<GitHttp["fetch"]>[0]): Promise<void> {
		const objects = await this.git.fetch(request, (sha) => this.object(sha));
		for (const [sha, object] of objects) this.absorb(sha, object);
	}

	private object(sha: string): GitObject | undefined {
		const entries = this.trees.get(sha);
		if (entries) return { type: "tree", data: writeTree(entries) };
		const blob = this.blobs.get(sha);
		return blob ? { type: "blob", data: blob } : undefined;
	}

	private absorb(sha: string, object: GitObject): void {
		if (object.type === "commit") {
			const commit = parseCommit(object.data);
			this.commits.set(sha, commit);
			this.roots.set(sha, commit.tree);
		} else if (object.type === "tree") {
			this.trees.set(sha, parseTree(object.data));
		} else if (object.type === "blob") {
			this.blobs.set(sha, object.data);
		}
	}

	private remember(commit: string): void {
		this.recent = [commit, ...this.recent.filter((sha) => sha !== commit)].slice(0, 8);
	}

	private isWhole(tree: string): boolean {
		if (this.whole.has(tree)) return true;
		const entries = this.trees.get(tree);
		if (!entries) return false;
		for (const entry of entries) {
			if (entry.mode === TREE_MODE && !this.isWhole(entry.sha)) return false;
		}
		this.whole.add(tree);
		return true;
	}

	// symlinks (120000) and submodules (160000) have no place in a vault
	private flatten(tree: string, prefix: string, files: Map<string, RemoteFile>): void {
		for (const entry of this.trees.get(tree) ?? []) {
			if (entry.mode === TREE_MODE) this.flatten(entry.sha, `${prefix}${entry.name}/`, files);
			else if (entry.mode === "100644" || entry.mode === "100755")
				files.set(prefix + entry.name, { sha: entry.sha, mode: entry.mode });
		}
	}

	async readBlobs(
		wanted: Array<{ sha: string; path: string }>,
		commit: string,
		progress?: (done: number, total: number) => void,
		each?: (sha: string, bytes: Uint8Array) => Promise<void>,
	): Promise<Map<string, Uint8Array>> {
		const out = new Map<string, Uint8Array>();
		const shas = [...new Set(wanted.map((w) => w.sha))];
		let done = 0;
		const deliver = async (sha: string) => {
			const bytes = this.blobs.get(sha) ?? this.keptBlobs.get(sha);
			if (!bytes) return false;
			this.blobs.delete(sha);
			if (each) await each(sha, bytes);
			else out.set(sha, bytes);
			progress?.(++done, shas.length);
			return true;
		};
		let missing: string[] = [];
		for (const sha of shas) if (!(await deliver(sha))) missing.push(sha);

		if (missing.length > 0 && this.git.anyWant) {
			const still: string[] = [];
			for (let i = 0; i < missing.length; i += WANT_BATCH) {
				const batch = missing.slice(i, i + WANT_BATCH);
				await this.load({ wants: batch });
				for (const sha of batch) if (!(await deliver(sha))) still.push(sha);
			}
			missing = still;
		}
		// a server that only hands out branch tips: the files of the commit, then of its history
		for (const depth of [1, SINCE_DEPTH]) {
			if (missing.length === 0) break;
			await this.load({ wants: [commit], depth });
			const still: string[] = [];
			for (const sha of missing) if (!(await deliver(sha))) still.push(sha);
			missing = still;
		}
		return out;
	}

	async commit(input: {
		parent: string;
		baseTree: string;
		changes: Change[];
		message: string;
		authored?: Date | null;
		kept?: KeptCommit | null;
	}): Promise<{ commit: string; tree: string } | "moved"> {
		const base = this.isWhole(input.baseTree) ? input.baseTree : await this.ensure(input.parent);
		const objects = new Map<string, GitObject>();
		const edits: Edit[] = [];
		await pool(input.changes, CONCURRENCY, async (change) => {
			const parts = change.path.split("/");
			if (change.read === null) {
				edits.push({ parts, entry: null });
				return;
			}
			const data = await change.read();
			const blob: GitObject = { type: "blob", data };
			const sha = await hashObject(blob);
			objects.set(sha, blob);
			edits.push({ parts, entry: { sha, mode: change.mode } });
		});
		const tree = await this.rewrite(base, edits, objects);
		const parents = [input.parent];
		let keptShas: string[] = [];
		if (input.kept && input.kept.files.length > 0) {
			const kept = await this.keptCommit(input.kept, objects);
			if (kept) {
				parents.push(kept.sha);
				keptShas = kept.blobs;
			}
		}
		const now = new Date();
		const { name, email } = await this.identity();
		const commit: GitObject = {
			type: "commit",
			data: writeCommit({
				tree,
				parents,
				author: signature(name, email, input.authored ?? now),
				committer: signature(name, email, now),
				message: input.message,
			}),
		};
		const sha = await hashObject(commit);
		objects.set(sha, commit);

		const result = await this.git.push(
			this.ref,
			input.parent,
			sha,
			await writePack([...objects.values()]),
		);
		if (!result.ok) {
			const head = await this.head().catch(() => null);
			if (head !== sha) {
				if (head !== input.parent) return "moved";
				throw new RemoteError(
					0,
					`${this.git.name} refused the upload: ${result.reason}.`,
					"forbidden",
				);
			}
		}
		for (const [objectSha, object] of objects)
			if (object.type !== "blob") this.absorb(objectSha, object);
		this.remember(sha);
		for (const blob of keptShas) {
			this.keptBlobs.delete(blob);
			await this.stash?.delete(blob);
		}
		return { commit: sha, tree };
	}

	// this device's losing versions on top of the commit it was in sync with
	private async keptCommit(
		kept: KeptCommit,
		objects: Map<string, GitObject>,
	): Promise<{ sha: string; blobs: string[] } | null> {
		let parent = kept.parent;
		let base: string | null = null;
		if (parent !== null) {
			// a rewritten branch can have lost the parent, then the versions get a root commit
			base = await this.ensure(parent).catch(() => null);
			if (base === null) parent = null;
		}
		const edits: Edit[] = [];
		const blobs: string[] = [];
		for (const file of kept.files) {
			const data = this.keptBlobs.get(file.sha) ?? (await this.stash?.get(file.sha)) ?? null;
			// gone with a restart before the stash existed: nothing left to keep
			if (!data) continue;
			objects.set(file.sha, { type: "blob", data });
			edits.push({ parts: file.path.split("/"), entry: { sha: file.sha, mode: file.mode } });
			blobs.push(file.sha);
		}
		if (edits.length === 0) return null;
		const tree = await this.rewrite(base, edits, objects);
		const { name, email } = await this.identity();
		const when = kept.authored ?? new Date();
		const commit: GitObject = {
			type: "commit",
			data: writeCommit({
				tree,
				parents: parent === null ? [] : [parent],
				author: signature(name, email, when),
				committer: signature(name, email, new Date()),
				message: kept.message,
			}),
		};
		const sha = await hashObject(commit);
		objects.set(sha, commit);
		return { sha, blobs };
	}

	// the folders along each edited path get new trees; the rest are reused as they are
	private async rewrite(
		tree: string | null,
		edits: Edit[],
		objects: Map<string, GitObject>,
	): Promise<string> {
		const built = new Map<string, TreeEntry[]>();
		const root = await buildTree(
			edits,
			built,
			tree === null ? [] : (this.trees.get(tree) ?? []),
			this.trees,
		);
		for (const [sha, entries] of built) {
			if (!this.trees.has(sha)) objects.set(sha, { type: "tree", data: writeTree(entries) });
			this.trees.set(sha, entries);
		}
		return root;
	}

	async storeBlob(content: Uint8Array): Promise<string> {
		const sha = await hashObject({ type: "blob", data: content });
		this.keptBlobs.set(sha, content);
		await this.stash?.put(sha, content);
		return sha;
	}

	async initialize(path: string, content: Uint8Array, message: string): Promise<void> {
		const objects = new Map<string, GitObject>();
		const blob: GitObject = { type: "blob", data: content };
		const blobSha = await hashObject(blob);
		objects.set(blobSha, blob);
		const tree = await this.rewrite(
			null,
			[{ parts: path.split("/"), entry: { sha: blobSha, mode: "100644" } }],
			objects,
		);
		const now = new Date();
		const { name, email } = await this.identity();
		const commit: GitObject = {
			type: "commit",
			data: writeCommit({
				tree,
				parents: [],
				author: signature(name, email, now),
				committer: signature(name, email, now),
				message,
			}),
		};
		const sha = await hashObject(commit);
		objects.set(sha, commit);
		const result = await this.git.push(
			this.ref,
			ZERO_SHA,
			sha,
			await writePack([...objects.values()]),
		);
		// another device may have made the first commit in the meantime
		if (!result.ok && (await this.head()) === null)
			throw new RemoteError(
				0,
				`${this.git.name} refused the first commit: ${result.reason}.`,
				"forbidden",
			);
	}

	async commitsSince(base: string | null, head: string): Promise<RemoteCommit[]> {
		if (!this.commits.has(head)) await this.ensure(head);
		const top = this.commits.get(head);
		if (!top) return [];
		if (base === null || base === head) return [toRemoteCommit(head, top)];
		const out: RemoteCommit[] = [];
		const seen = new Set<string>([base]);
		const queue = [head];
		while (queue.length > 0) {
			const sha = queue.shift() ?? "";
			if (seen.has(sha)) continue;
			seen.add(sha);
			const commit = this.commits.get(sha);
			if (!commit) continue;
			out.push(toRemoteCommit(sha, commit));
			queue.push(...commit.parents);
		}
		return out.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
	}

	async lastChange(path: string, head: string): Promise<RemoteCommit | null> {
		if (!this.commits.has(head)) await this.ensure(head);
		for (let attempt = 0; attempt < 2; attempt++) {
			const found = this.walk(path, head);
			if (found !== undefined) return found;
			if (!(await this.deepen(head))) break;
		}
		return null;
	}

	// undefined when the history needed to tell is not here
	private walk(path: string, head: string): RemoteCommit | null | undefined {
		let current: string | undefined = head;
		while (current !== undefined) {
			const commit = this.commits.get(current);
			if (!commit) return undefined;
			const here = this.pathSha(commit.tree, path);
			const parent = commit.parents[0];
			const parentTree = parent === undefined ? null : this.roots.get(parent);
			if (parentTree === undefined) return undefined;
			const before = parentTree === null ? null : this.pathSha(parentTree, path);
			if (here === undefined || before === undefined) return undefined;
			if (here !== before && !isSuperseded(commit.message)) return toRemoteCommit(current, commit);
			current = parent;
		}
		return null;
	}

	private pathSha(tree: string, path: string): string | null | undefined {
		let entries = this.trees.get(tree);
		const parts = path.split("/");
		for (const [i, part] of parts.entries()) {
			if (!entries) return undefined;
			const entry = entries.find((e) => e.name === part);
			if (!entry) return null;
			if (i === parts.length - 1) return entry.mode === TREE_MODE ? null : entry.sha;
			if (entry.mode !== TREE_MODE) return null;
			entries = this.trees.get(entry.sha);
		}
		return null;
	}

	// older history comes only from a server that sends folders without their files
	private async deepen(head: string): Promise<boolean> {
		if (!this.git.blobless || this.deepened === head) return false;
		this.deepened = head;
		await this.load({ wants: [head], depth: HISTORY_DEPTH, blobless: true });
		return true;
	}

	async fileHistory(path: string, head: string, max: number): Promise<string[]> {
		if (!(await this.deepen(head)) && this.deepened !== head) return [];
		const shas: string[] = [];
		for (let current: string | undefined = head; current !== undefined && shas.length < max; ) {
			const commit = this.commits.get(current);
			if (!commit) break;
			const sha = this.pathSha(commit.tree, path);
			if (sha && !shas.includes(sha)) shas.push(sha);
			current = commit.parents[0];
		}
		return shas;
	}
}

function toRemoteCommit(sha: string, commit: Commit): RemoteCommit {
	return {
		sha,
		message: commit.message,
		date: commit.committer.time ? signatureDate(commit.committer) : null,
		authored: commit.author.time ? signatureDate(commit.author) : null,
		parent: commit.parents[0] ?? null,
	};
}

// builds the trees for `edits` over `base`, recording each new one in `built`
async function buildTree(
	edits: Edit[],
	built: Map<string, TreeEntry[]>,
	base: TreeEntry[] = [],
	trees: Map<string, TreeEntry[]> = new Map(),
): Promise<string> {
	const entries = new Map(base.map((entry) => [entry.name, entry]));
	const folders = new Map<string, Edit[]>();
	for (const edit of edits) {
		const [name, ...rest] = edit.parts;
		if (name === undefined) continue;
		if (rest.length === 0) {
			if (edit.entry) entries.set(name, { name, ...edit.entry });
			else entries.delete(name);
		} else {
			folders.set(name, [...(folders.get(name) ?? []), { parts: rest, entry: edit.entry }]);
		}
	}
	for (const [name, inner] of folders) {
		const existing = entries.get(name);
		const below =
			existing?.mode === TREE_MODE
				? (trees.get(existing.sha) ?? built.get(existing.sha) ?? [])
				: [];
		const sha = await buildTree(inner, built, below, trees);
		// git has no empty folders; a file that took the folder's name stays
		if (sha !== EMPTY_TREE) entries.set(name, { name, mode: TREE_MODE, sha });
		else if (existing?.mode === TREE_MODE) entries.delete(name);
	}
	const list = [...entries.values()];
	const sha = await hashObject({ type: "tree", data: writeTree(list) });
	built.set(sha, list);
	return sha;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
		while (next < items.length) {
			await run(items[next++]);
		}
	});
	await Promise.all(workers);
}
