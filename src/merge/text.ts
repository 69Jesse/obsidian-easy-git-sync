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
		if (!conflict) continue;
		const zipped = interleave(conflict.o, conflict.b, conflict.a);
		if (zipped) push(segments, { ok: zipped });
		else pushDifference(segments, conflict.b, conflict.a, true);
	}
	return tidy(segments);
}

interface Hunk {
	start: number;
	length: number;
	lines: string[];
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
function interleave(base: string[], remote: string[], local: string[]): string[] | null {
	const all = [
		...hunks(base, remote).map((h) => ({ ...h, side: 0 })),
		...hunks(base, local).map((h) => ({ ...h, side: 1 })),
	].sort((x, y) => x.start - y.start || x.length - y.length || x.side - y.side);

	for (let i = 0; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			const x = all[i];
			const y = all[j];
			if (!x || !y || x.side === y.side) continue;
			if (overlaps(x, y)) return null;
		}
	}

	const out: string[] = [];
	let at = 0;
	for (let i = 0; i < all.length; i++) {
		const h = all[i];
		if (!h) continue;
		out.push(...base.slice(at, h.start));
		const next = all[i + 1];
		if (next && h.length === 0 && next.length === 0 && next.start === h.start) {
			out.push(...unionLines(h.lines, next.lines));
			i++;
		} else {
			out.push(...h.lines);
		}
		at = Math.max(at, h.start + h.length);
	}
	out.push(...base.slice(at));
	return out;
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
