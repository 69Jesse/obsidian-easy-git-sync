// merged per top-level key on raw text, never per line: a conflict block inside YAML would break it

export interface KeyBlock {
	key: string | null;
	lines: string[];
}

export interface PropertyConflict {
	key: string;
	local: string[];
	remote: string[];
}

export function splitFrontmatter(lines: string[]): {
	frontmatter: string[] | null;
	body: string[];
} {
	if (lines[0]?.trimEnd() !== "---") return { frontmatter: null, body: lines };
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trimEnd() === "---") {
			return { frontmatter: lines.slice(1, i), body: lines.slice(i + 1) };
		}
	}
	return { frontmatter: null, body: lines };
}

const KEY_LINE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"-][^:]*?|-\S[^:]*?)\s*:(?:\s|$)/;

export function parseKeyBlocks(frontmatter: string[]): KeyBlock[] {
	const blocks: KeyBlock[] = [];
	for (const line of frontmatter) {
		const match = KEY_LINE.exec(line);
		if (match?.[1] !== undefined) {
			blocks.push({ key: match[1], lines: [line] });
			continue;
		}
		const last = blocks[blocks.length - 1];
		if (last) last.lines.push(line);
		else blocks.push({ key: null, lines: [line] });
	}
	return blocks;
}

export function displayKey(key: string): string {
	if (key.startsWith('"') && key.endsWith('"')) return key.slice(1, -1).replace(/\\(.)/g, "$1");
	if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
	return key;
}

export function mergeFrontmatter(
	base: string[] | null,
	local: string[],
	remote: string[],
	prefer?: "local" | "remote",
): { lines: string[]; conflicts: PropertyConflict[] } {
	const baseMap = toMap(base ? parseKeyBlocks(base) : []);
	const localBlocks = parseKeyBlocks(local);
	const remoteBlocks = parseKeyBlocks(remote);
	const localMap = toMap(localBlocks);
	const remoteMap = toMap(remoteBlocks);
	const conflicts: PropertyConflict[] = [];

	const out: KeyBlock[] = [];
	for (const block of localBlocks) {
		if (block.key === null) {
			out.push(block);
			continue;
		}
		const merged = mergeKey(
			block.key,
			baseMap.get(block.key),
			block.lines,
			remoteMap.get(block.key),
			prefer,
		);
		if (merged.conflict) conflicts.push(merged.conflict);
		if (merged.lines) out.push({ key: block.key, lines: merged.lines });
	}

	// keys local does not have: added on remote, or deleted here
	let after: string | null = null;
	for (const block of remoteBlocks) {
		if (block.key === null) continue;
		if (localMap.has(block.key)) {
			after = block.key;
			continue;
		}
		const merged = mergeKey(block.key, baseMap.get(block.key), undefined, block.lines, prefer);
		if (merged.lines) {
			const at = after === null ? -1 : out.findIndex((b) => b.key === after);
			const insertAt = at === -1 ? (after === null ? firstKeyIndex(out) : out.length) : at + 1;
			out.splice(insertAt, 0, { key: block.key, lines: merged.lines });
			after = block.key;
		}
	}

	return { lines: out.flatMap((block) => block.lines), conflicts };
}

function firstKeyIndex(blocks: KeyBlock[]): number {
	return blocks[0]?.key === null ? 1 : 0;
}

function mergeKey(
	key: string,
	base: string[] | undefined,
	local: string[] | undefined,
	remote: string[] | undefined,
	prefer: "local" | "remote" | undefined,
): { lines: string[] | undefined; conflict?: PropertyConflict } {
	const b = base?.join("\n");
	const l = local?.join("\n");
	const r = remote?.join("\n");
	if (l === r) return { lines: local };
	if (l === b) return { lines: remote };
	if (r === b) return { lines: local };
	// changed differently on both sides, and a deletion loses to an edit
	if (local === undefined) return { lines: remote };
	if (remote === undefined) return { lines: local };
	const list = mergeList(base, local, remote);
	if (list) return { lines: list };
	return { lines: prefer === "remote" ? remote : local, conflict: { key, local, remote } };
}

function mergeList(base: string[] | undefined, local: string[], remote: string[]): string[] | null {
	const l = listItems(local);
	const r = listItems(remote);
	if (!l || !r) return null;
	const b = base ? (listItems(base) ?? []) : [];
	const header = local[0] ?? "";
	const keep = (item: string, other: string[]) => other.includes(item) || !b.includes(item);
	const merged = l.filter((item) => keep(item, r));
	for (const item of r) {
		if (!l.includes(item) && !b.includes(item)) merged.push(item);
	}
	return [header, ...merged];
}

function listItems(lines: string[]): string[] | null {
	const [header, ...rest] = lines;
	if (header === undefined || !/:\s*$/.test(header)) return null;
	const items = rest.filter((line) => line.trim() !== "");
	if (items.length === 0 || !items.every((line) => /^\s*- /.test(line))) return null;
	return items;
}

function toMap(blocks: KeyBlock[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const block of blocks) if (block.key !== null) map.set(block.key, block.lines);
	return map;
}

export function replaceProperty(frontmatter: string[], key: string, lines: string[]): string[] {
	const blocks = parseKeyBlocks(frontmatter);
	const at = blocks.findIndex((block) => block.key === key);
	if (at === -1) {
		if (lines.length > 0) blocks.push({ key, lines });
	} else if (lines.length === 0) {
		blocks.splice(at, 1);
	} else {
		blocks[at] = { key, lines };
	}
	return blocks.flatMap((block) => block.lines);
}
