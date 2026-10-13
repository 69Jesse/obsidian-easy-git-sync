export type Snapshot = ReadonlyMap<string, string>;

export type Action =
	| { kind: "push"; path: string }
	| { kind: "pull"; path: string; sha: string }
	| { kind: "delete-local"; path: string; sha: string }
	| { kind: "delete-remote"; path: string }
	| { kind: "merge"; path: string; base: string | null; local: string; remote: string }
	// deleted here, edited on GitHub: the edit comes back
	| { kind: "restore"; path: string; sha: string }
	// deleted on GitHub, edited here: the edit goes back up
	| { kind: "resurrect"; path: string }
	| { kind: "pull-renamed"; from: string; to: string; sha: string; localSha: string }
	| { kind: "push-renamed"; from: string; to: string; localSha: string }
	| { kind: "replace-local"; path: string; sha: string; local: string }
	| {
			kind: "merge-renamed";
			from: string;
			to: string;
			renamedOn: "local" | "remote";
			base: string;
			local: string;
			remote: string;
	  };

export interface RenameCandidate {
	from: string;
	to: string;
	side: "local" | "remote";
}

// exact-content renames are left out: `plan` pairs those by sha
export function renameCandidates(
	base: Snapshot,
	local: Snapshot,
	remote: Snapshot,
): RenameCandidate[] {
	const out: RenameCandidate[] = [];
	const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	for (const [from, sha] of base) {
		const r = remote.get(from);
		const l = local.get(from);
		if (l === undefined && r !== undefined && r !== sha) {
			for (const [to, s] of local) {
				if (s !== sha && !base.has(to) && !remote.has(to) && ext(to) === ext(from)) {
					out.push({ from, to, side: "local" });
				}
			}
		}
		if (r === undefined && l !== undefined && l !== sha) {
			for (const [to, s] of remote) {
				if (s !== sha && !base.has(to) && !local.has(to) && ext(to) === ext(from)) {
					out.push({ from, to, side: "remote" });
				}
			}
		}
	}
	return out;
}

export function plan(
	base: Snapshot,
	local: Snapshot,
	remote: Snapshot,
	renames: RenameCandidate[] = [],
): Action[] {
	const actions: Action[] = [];
	const handled = new Set<string>();

	for (const [from, sha] of base) {
		if (!local.has(from)) {
			const r = remote.get(from);
			if (r !== undefined && r !== sha) {
				const to = renamedTo(sha, local, base, remote, handled);
				if (to !== null) {
					actions.push({ kind: "pull-renamed", from, to, sha: r, localSha: sha });
					handled.add(from).add(to);
					continue;
				}
			}
		}
		if (!remote.has(from)) {
			const l = local.get(from);
			if (l !== undefined && l !== sha) {
				const to = renamedTo(sha, remote, base, local, handled);
				if (to !== null) {
					actions.push({ kind: "push-renamed", from, to, localSha: l });
					handled.add(from).add(to);
				}
			}
		}
	}

	for (const { from, to, side } of renames) {
		if (handled.has(from) || handled.has(to)) continue;
		const b = base.get(from);
		const l = local.get(side === "local" ? to : from);
		const r = remote.get(side === "local" ? from : to);
		if (b === undefined || l === undefined || r === undefined) continue;
		actions.push({
			kind: "merge-renamed",
			from,
			to,
			renamedOn: side,
			base: b,
			local: l,
			remote: r,
		});
		handled.add(from).add(to);
	}

	const paths = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
	for (const path of [...paths].sort()) {
		if (handled.has(path)) continue;
		const action = decide(path, base.get(path), local.get(path), remote.get(path));
		if (action) actions.push(action);
	}
	return actions;
}

export function planReplace(
	local: Snapshot,
	remote: Snapshot,
	keep: "local" | "remote",
	merges: (path: string) => boolean,
): Action[] {
	const actions: Action[] = [];
	const paths = new Set([...local.keys(), ...remote.keys()]);
	for (const path of [...paths].sort()) {
		const l = local.get(path);
		const r = remote.get(path);
		if (l === r) continue;
		if (merges(path)) {
			const action = decide(path, undefined, l, r);
			if (action) actions.push(action);
			continue;
		}
		if (keep === "local") {
			if (l !== undefined) actions.push({ kind: "push", path });
			else actions.push({ kind: "delete-remote", path });
		} else if (r === undefined) {
			if (l !== undefined) actions.push({ kind: "delete-local", path, sha: l });
		} else if (l === undefined) {
			actions.push({ kind: "pull", path, sha: r });
		} else {
			actions.push({ kind: "replace-local", path, sha: r, local: l });
		}
	}
	return actions;
}

function renamedTo(
	sha: string,
	side: Snapshot,
	base: Snapshot,
	other: Snapshot,
	handled: Set<string>,
): string | null {
	for (const [path, s] of side) {
		if (s === sha && !base.has(path) && !other.has(path) && !handled.has(path)) return path;
	}
	return null;
}

function decide(
	path: string,
	b: string | undefined,
	l: string | undefined,
	r: string | undefined,
): Action | null {
	if (l === r) return null;
	if (b === undefined) {
		if (l === undefined && r !== undefined) return { kind: "pull", path, sha: r };
		if (r === undefined) return { kind: "push", path };
		if (l === undefined) return null;
		return { kind: "merge", path, base: null, local: l, remote: r };
	}
	if (l === b) {
		if (r === undefined) return { kind: "delete-local", path, sha: b };
		return { kind: "pull", path, sha: r };
	}
	if (r === b) {
		if (l === undefined) return { kind: "delete-remote", path };
		return { kind: "push", path };
	}
	if (l === undefined) return r === undefined ? null : { kind: "restore", path, sha: r };
	if (r === undefined) return { kind: "resurrect", path };
	return { kind: "merge", path, base: b, local: l, remote: r };
}
