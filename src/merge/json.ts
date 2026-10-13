type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export interface JsonMerge {
	text: string;
	conflicts: number;
}

interface MergeState {
	conflicts: number;
	prefer: "local" | "remote" | undefined;
}

export function mergeJson(
	base: string | null,
	local: string,
	remote: string,
	canvas: boolean,
	prefer?: "local" | "remote",
): JsonMerge | null {
	const b = base === null ? undefined : parse(base);
	const l = parse(local);
	const r = parse(remote);
	if (l === undefined || r === undefined) return null;

	const state: MergeState = { conflicts: 0, prefer };
	let merged: Json | undefined;
	if (canvas && isObject(l) && isObject(r)) {
		const bObj = isObject(b) ? b : {};
		const out: JsonObject = {};
		for (const key of keysOf(l, r)) {
			if (key === "nodes" || key === "edges") {
				const items = mergeItems(
					arrayOf(bObj[key]),
					arrayOf(l[key]),
					arrayOf(r[key]),
					key === "nodes",
					state,
				);
				out[key] = items;
			} else {
				const value = merge3(bObj[key], l[key], r[key], state);
				if (value !== undefined) out[key] = value;
			}
		}
		merged = out;
	} else {
		merged = merge3(b, l, r, state);
	}
	if (merged === undefined) merged = l;
	return { text: stringify(merged, local), conflicts: state.conflicts };
}

function parse(text: string): Json | undefined {
	try {
		return JSON.parse(text) as Json;
	} catch {
		return undefined;
	}
}

function isObject(value: Json | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOf(value: Json | undefined): Json[] {
	return Array.isArray(value) ? value : [];
}

function keysOf(first: JsonObject, second: JsonObject): string[] {
	const keys = Object.keys(first);
	for (const key of Object.keys(second)) if (!(key in first)) keys.push(key);
	return keys;
}

function same(a: Json | undefined, b: Json | undefined): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

// undefined means absent: deleted, or never there
function merge3(
	base: Json | undefined,
	local: Json | undefined,
	remote: Json | undefined,
	state: MergeState,
): Json | undefined {
	if (same(local, remote)) return local;
	if (same(local, base)) return remote;
	if (same(remote, base)) return local;
	if (local === undefined) return remote;
	if (remote === undefined) return local;
	if (isObject(local) && isObject(remote)) {
		const b = isObject(base) ? base : {};
		const out: JsonObject = {};
		for (const key of keysOf(local, remote)) {
			const value = merge3(b[key], local[key], remote[key], state);
			if (value !== undefined) out[key] = value;
		}
		return out;
	}
	state.conflicts++;
	return state.prefer === "remote" ? remote : local;
}

function idOf(item: Json): string | null {
	return isObject(item) && typeof item.id === "string" ? item.id : null;
}

function mergeItems(
	base: Json[],
	local: Json[],
	remote: Json[],
	nodes: boolean,
	state: MergeState,
): Json[] {
	const byId = (items: Json[]) => {
		const map = new Map<string, Json>();
		for (const item of items) {
			const id = idOf(item);
			if (id !== null) map.set(id, item);
		}
		return map;
	};
	const b = byId(base);
	const l = byId(local);
	const r = byId(remote);
	const taken = new Set([...l.keys(), ...r.keys()]);
	const out: Json[] = [];
	const extra: Json[] = [];

	for (const item of local) {
		const id = idOf(item);
		if (id === null) {
			out.push(item);
			continue;
		}
		const inner: MergeState = { conflicts: 0, prefer: state.prefer };
		const merged = merge3(b.get(id), item, r.get(id), inner);
		if (merged === undefined) continue;
		out.push(merged);
		const other = r.get(id);
		if (inner.conflicts > 0 && other !== undefined && nodes && !state.prefer) {
			state.conflicts++;
			extra.push(conflictCopy(other, id, taken));
		} else {
			state.conflicts += inner.conflicts;
		}
	}
	for (const item of remote) {
		const id = idOf(item);
		if (id === null) {
			if (!local.some((x) => same(x, item))) out.push(item);
			continue;
		}
		if (l.has(id)) continue;
		const merged = merge3(b.get(id), undefined, item, state);
		if (merged !== undefined) out.push(merged);
	}
	return [...out, ...extra];
}

function conflictCopy(node: Json, id: string, taken: Set<string>): Json {
	let copyId = `${id}-conflict`;
	for (let n = 2; taken.has(copyId); n++) copyId = `${id}-conflict-${n}`;
	taken.add(copyId);
	const copy: JsonObject = isObject(node) ? { ...node } : {};
	copy.id = copyId;
	if (typeof copy.x === "number") copy.x += 40;
	if (typeof copy.y === "number") copy.y += 40;
	copy.color = "1";
	return copy;
}

// in the local file's indentation, so a merge does not reformat it
function stringify(value: Json, like: string): string {
	const indent = /^[[{]\r?\n([ \t]+)/.exec(like)?.[1];
	const eol = like.includes("\r\n") ? "\r\n" : "\n";
	let text = indent === undefined ? JSON.stringify(value) : JSON.stringify(value, null, indent);
	if (eol === "\r\n") text = text.replace(/\n/g, "\r\n");
	return like.endsWith("\n") ? text + eol : text;
}
