import { displayKey, parseKeyBlocks, replaceProperty, splitFrontmatter } from "./frontmatter";
import { joinLines, splitLines } from "./lines";

const SYNC_TAG = "sync conflict";
const OPEN = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SEPARATOR = /^={7}$/;
const CLOSE = /^>{7}(?: (.*))?$/;
const PROPERTY = / \(sync conflict in property "((?:[^"\\]|\\.)*)"\)$/;
// what sideLabel puts after the device name
const LABEL_DATE = /, (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;

export interface ConflictSide {
	label: string;
	lines: string[];
}

function cleanLabel(label: string): string {
	return label.replace(/[\r\n]+/g, " ").trim();
}

export function renderConflict(sides: [ConflictSide, ConflictSide], property?: string): string[] {
	const [top, bottom] = sides;
	const tag =
		property === undefined
			? SYNC_TAG
			: `${SYNC_TAG} in property "${displayKey(property).replace(/["\\]/g, "\\$&")}"`;
	// without the blank lines, `=======` turns the line above it into a setext heading
	const padded = (lines: string[]) => (lines.length === 0 ? [""] : ["", ...lines, ""]);
	return [
		`<<<<<<< ${cleanLabel(top.label)} (${tag})`,
		...padded(top.lines),
		"=======",
		...padded(bottom.lines),
		`>>>>>>> ${cleanLabel(bottom.label)}`,
	];
}

export interface ParsedSide {
	label: string;
	marker: number;
	lines: string[];
}

export interface ParsedConflict {
	sync: boolean;
	property: string | null;
	start: number;
	end: number;
	sides: [ParsedSide, ParsedSide];
}

export function findConflicts(lines: string[]): ParsedConflict[] {
	const found: ParsedConflict[] = [];
	let open: {
		start: number;
		label: string;
		top: string[];
		inBase: boolean;
		separator: number | null;
		bottom: string[];
	} | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const opening = OPEN.exec(line);
		if (opening) {
			open = {
				start: i,
				label: opening[1] ?? "",
				top: [],
				inBase: false,
				separator: null,
				bottom: [],
			};
			continue;
		}
		if (!open) continue;
		if (open.separator === null) {
			if (SEPARATOR.test(line)) {
				open.separator = i;
				open.inBase = false;
			} else if (BASE.test(line)) {
				open.inBase = true;
			} else if (!open.inBase) {
				open.top.push(line);
			}
			continue;
		}
		const closing = CLOSE.exec(line);
		if (!closing) {
			open.bottom.push(line);
			continue;
		}
		const raw = open.label;
		const sync = raw.endsWith(` (${SYNC_TAG})`) || PROPERTY.test(raw);
		const propertyMatch = PROPERTY.exec(raw);
		const property = propertyMatch?.[1]?.replace(/\\(.)/g, "$1") ?? null;
		const topLabel = sync ? raw.replace(PROPERTY, "").replace(` (${SYNC_TAG})`, "") : raw;
		const tidy = sync ? unpad : (lines: string[]) => lines;
		found.push({
			sync,
			property,
			start: open.start,
			end: i,
			sides: [
				{ label: topLabel, marker: open.start, lines: tidy(open.top) },
				{ label: closing[1] ?? "", marker: open.separator, lines: tidy(open.bottom) },
			],
		});
		open = null;
	}
	return found;
}

function unpad(lines: string[]): string[] {
	let from = 0;
	let to = lines.length;
	if (lines[0]?.trim() === "") from = 1;
	if (to > from && lines[to - 1]?.trim() === "") to--;
	return lines.slice(from, to);
}

export function hasConflictMarker(text: string): boolean {
	return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text);
}

export function sideName(conflict: ParsedConflict, index: 0 | 1): string {
	const label = conflict.sides[index].label;
	const name = conflict.sync ? label.replace(LABEL_DATE, "") : label;
	return name.trim() || (index === 0 ? "top" : "bottom");
}

// both labels of a block are written by one device in its local time, so they compare
export function sideTime(conflict: ParsedConflict, index: 0 | 1): Date | null {
	if (!conflict.sync) return null;
	const match = LABEL_DATE.exec(conflict.sides[index].label);
	if (!match) return null;
	const [, y, mo, d, h, mi] = match.map(Number);
	return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
}

export function newerSide(conflict: ParsedConflict): 0 | 1 | null {
	const top = sideTime(conflict, 0);
	const bottom = sideTime(conflict, 1);
	if (!top || !bottom || top.getTime() === bottom.getTime()) return null;
	return top > bottom ? 0 : 1;
}

export function resolveAllNewer(text: string): { text: string; resolved: number; skipped: number } {
	let out = text;
	let resolved = 0;
	let skipped = 0;
	// last block first, parsed afresh each time: keeping a property's value rewrites
	// the frontmatter, which moves every block below it
	for (let i = findConflicts(splitLines(text).lines).length - 1; i >= 0; i--) {
		const conflict = findConflicts(splitLines(out).lines)[i];
		if (!conflict) continue;
		const newer = newerSide(conflict);
		const next = newer === null ? null : resolveConflict(out, conflict.start, { keep: newer });
		if (next === null) {
			skipped++;
			continue;
		}
		out = next;
		resolved++;
	}
	return { text: out, resolved, skipped };
}

export type Resolution = { keep: 0 | 1 } | "both";

export function resolveConflict(text: string, start: number, choice: Resolution): string | null {
	const split = splitLines(text);
	const conflict = findConflicts(split.lines).find((c) => c.start === start);
	if (!conflict) return null;

	const kept = choice === "both" ? null : conflict.sides[choice.keep];

	// a property block holds a value for the frontmatter, so the block itself only ever goes
	let replacement: string[] = [];
	if (conflict.property === null) {
		replacement = kept ? kept.lines : conflict.sides.flatMap((side) => side.lines);
	}

	const lines = [
		...split.lines.slice(0, conflict.start),
		...replacement,
		...split.lines.slice(conflict.end + 1),
	];

	if (conflict.property !== null && kept) {
		const { frontmatter, body } = splitFrontmatter(lines);
		if (frontmatter) {
			const key =
				parseKeyBlocks(frontmatter).find(
					(b) => b.key !== null && displayKey(b.key) === conflict.property,
				)?.key ?? conflict.property;
			const updated = replaceProperty(frontmatter, key, kept.lines);
			return joinLines({ ...split, lines: ["---", ...updated, "---", ...body] });
		}
	}
	return joinLines({ ...split, lines });
}
