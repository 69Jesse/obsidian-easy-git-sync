import { diff3Merge, diffComm, diffIndices } from "node-diff3";

export type Segment = { ok: string[] } | { conflict: { remote: string[]; local: string[] } };

export type Side = "local" | "remote";

export function preferSide(
	segments: Segment[],
	prefer: Side,
): { lines: string[]; replaced: number } {
	const lines: string[] = [];
	let replaced = 0;
	for (const segment of segments) {
		if ("ok" in segment) {
			lines.push(...segment.ok);
			continue;
		}
		replaced++;
		lines.push(...segment.conflict[prefer]);
	}
	return { lines, replaced };
}

export function mergeLines(base: string[] | null, local: string[], remote: string[]): Segment[] {
	const segments: Segment[] = [];
	if (base === null) {
		for (const part of diffComm(remote, local)) {
			if (part.common) push(segments, { ok: part.common });
			else pushDifference(segments, part.buffer1, part.buffer2, false);
		}
		return tidy(segments);
	}

	for (const region of diff3Merge(local, base, remote, { excludeFalseConflicts: true })) {
		if (region.ok) {
			push(segments, { ok: region.ok });
			continue;
		}
		const conflict = region.conflict;
		if (conflict) resplit(segments, conflict.o, conflict.b, conflict.a);
	}
	return tidy(segments);
}

interface Hunk {
	start: number;
	length: number;
	lines: string[];
}

interface SideHunk extends Hunk {
	side: 0 | 1;
}

function hunks(base: string[], side: string[]): Hunk[] {
	return diffIndices(base, side).map((d) => ({
		start: d.buffer1[0],
		length: d.buffer1[1],
		lines: d.buffer2Content,
	}));
}

// diff3 conflicts on edits to neighbouring lines, as git does for code. In a note those are
// separate edits, so a region only conflicts where both sides changed the same base line
function resplit(segments: Segment[], base: string[], remote: string[], local: string[]): void {
	const all: SideHunk[] = [
		...hunks(base, remote).map((h) => ({ ...h, side: 0 as const })),
		...hunks(base, local).map((h) => ({ ...h, side: 1 as const })),
	].sort((x, y) => x.start - y.start || x.length - y.length || x.side - y.side);

	const groups: SideHunk[][] = [];
	for (const hunk of all) {
		const group = groups[groups.length - 1];
		if (group?.some((h) => h.side !== hunk.side && overlaps(h, hunk))) group.push(hunk);
		else groups.push([hunk]);
	}

	let at = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i];
		const first = group?.[0];
		if (!group || !first) continue;
		const end = Math.max(...group.map((h) => h.start + h.length));
		push(segments, { ok: base.slice(at, first.start) });
		const next = groups[i + 1]?.[0];
		if (group.length > 1) {
			const span = base.slice(first.start, end);
			settle(
				segments,
				span,
				apply(span, first.start, group, 0),
				apply(span, first.start, group, 1),
			);
		} else if (
			next &&
			groups[i + 1]?.length === 1 &&
			first.length === 0 &&
			next.length === 0 &&
			next.start === first.start
		) {
			push(segments, { ok: unionLines(first.lines, next.lines) });
			i++;
		} else {
			push(segments, { ok: first.lines });
		}
		at = Math.max(at, end);
	}
	push(segments, { ok: base.slice(at) });
}

function apply(span: string[], offset: number, group: SideHunk[], side: 0 | 1): string[] {
	const out: string[] = [];
	let at = 0;
	for (const h of group) {
		if (h.side !== side) continue;
		out.push(...span.slice(at, h.start - offset), ...h.lines);
		at = h.start - offset + h.length;
	}
	out.push(...span.slice(at));
	return out;
}

// both sides changed the same lines. When they made the same edit and one or both only added
// lines to it (a task ticked on both, with a line under it on one), keeping all loses nothing
function settle(segments: Segment[], base: string[], remote: string[], local: string[]): void {
	if (onlyAdded(base, remote, local)) push(segments, { ok: unionLines(remote, local) });
	else pushDifference(segments, remote, local, true);
}

function onlyAdded(base: string[], remote: string[], local: string[]): boolean {
	const fromRemote = added(base, remote);
	const fromLocal = added(base, local);
	const common: string[] = [];
	let r = 0;
	let l = 0;
	for (const part of diffComm(remote, local)) {
		if (part.common) {
			common.push(...part.common);
			r += part.common.length;
			l += part.common.length;
			continue;
		}
		for (let i = 0; i < part.buffer1.length; i++) if (!fromRemote.has(r + i)) return false;
		for (let i = 0; i < part.buffer2.length; i++) if (!fromLocal.has(l + i)) return false;
		r += part.buffer1.length;
		l += part.buffer2.length;
	}
	// the shared edit must not remove a line: an edit against a deletion stays a conflict. Blank
	// lines do not count, or a line both blanked and rewrote apart would read as agreed
	return hunks(base, common).every(
		(h) => filled(h.lines) >= filled(base.slice(h.start, h.start + h.length)),
	);
}

function added(base: string[], side: string[]): Set<number> {
	const out = new Set<number>();
	for (const d of diffIndices(base, side)) {
		for (let i = 0; i < d.buffer2[1]; i++) out.add(d.buffer2[0] + i);
	}
	return out;
}

function filled(lines: string[]): number {
	return lines.filter((line) => line.trim() !== "").length;
}

function overlaps(x: Hunk, y: Hunk): boolean {
	// two insertions at one point never overlap: both are kept
	if (x.length === 0 && y.length === 0) return false;
	if (x.length === 0) return y.start < x.start && x.start < y.start + y.length;
	if (y.length === 0) return x.start < y.start && y.start < x.start + x.length;
	return x.start < y.start + y.length && y.start < x.start + x.length;
}

function pushDifference(
	segments: Segment[],
	remote: string[],
	local: string[],
	withBase: boolean,
): void {
	let head = 0;
	while (head < remote.length && head < local.length && remote[head] === local[head]) head++;
	let tail = 0;
	while (
		tail < remote.length - head &&
		tail < local.length - head &&
		remote[remote.length - 1 - tail] === local[local.length - 1 - tail]
	) {
		tail++;
	}
	push(segments, { ok: remote.slice(0, head) });
	const r = remote.slice(head, remote.length - tail);
	const l = local.slice(head, local.length - tail);
	if (!withBase && (r.length === 0 || l.length === 0)) {
		// without a base, a line only one side has was added there, not removed on the other
		push(segments, { ok: [...r, ...l] });
	} else if (r.length > 0 || l.length > 0) {
		segments.push({ conflict: { remote: r, local: l } });
	}
	push(segments, { ok: remote.slice(remote.length - tail) });
}

export function unionLines(first: string[], second: string[]): string[] {
	const out: string[] = [];
	for (const part of diffComm(first, second)) {
		if (part.common) out.push(...part.common);
		else out.push(...part.buffer1, ...part.buffer2);
	}
	return out;
}

function push(segments: Segment[], segment: { ok: string[] }): void {
	if (segment.ok.length === 0) return;
	const last = segments[segments.length - 1];
	if (last && "ok" in last) last.ok.push(...segment.ok);
	else segments.push({ ok: [...segment.ok] });
}

function tidy(segments: Segment[]): Segment[] {
	const out: Segment[] = [];
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (!segment) continue;
		const prev = out[out.length - 1];
		const next = segments[i + 1];
		if (
			"ok" in segment &&
			prev &&
			"conflict" in prev &&
			next &&
			"conflict" in next &&
			segment.ok.length <= 2 &&
			segment.ok.every((line) => line.trim() === "")
		) {
			prev.conflict.remote.push(...segment.ok, ...next.conflict.remote);
			prev.conflict.local.push(...segment.ok, ...next.conflict.local);
			i++;
			continue;
		}
		out.push(segment);
	}
	return out;
}

export function conflictCount(segments: Segment[]): number {
	return segments.filter((segment) => "conflict" in segment).length;
}
