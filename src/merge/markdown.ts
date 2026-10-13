import { renderConflict } from "./conflict";
import { mergeFrontmatter, splitFrontmatter } from "./frontmatter";
import { joinLines, type SplitText, splitLines } from "./lines";
import { mergeLines, preferSide, type Side } from "./text";

export interface MergeLabels {
	local: string;
	remote: string;
}

export interface TextMerge {
	text: string;
	conflicts: number;
	replaced: number;
}

export function mergeMarkdown(
	base: string | null,
	local: string,
	remote: string,
	labels: MergeLabels,
	prefer?: Side,
): TextMerge {
	const b = base === null ? null : splitLines(base);
	const l = splitLines(local);
	const r = splitLines(remote);

	const bParts = b ? splitFrontmatter(b.lines) : null;
	const lParts = splitFrontmatter(l.lines);
	const rParts = splitFrontmatter(r.lines);

	let conflicts = 0;
	let replaced = 0;
	const out: string[] = [];

	const hasFrontmatter = lParts.frontmatter !== null || rParts.frontmatter !== null;
	const propertyBlocks: string[] = [];
	if (hasFrontmatter) {
		const merged = mergeFrontmatter(
			bParts?.frontmatter ?? (bParts ? [] : null),
			lParts.frontmatter ?? [],
			rParts.frontmatter ?? [],
			prefer,
		);
		out.push("---", ...merged.lines, "---");
		for (const conflict of merged.conflicts) {
			if (prefer) {
				replaced++;
				continue;
			}
			conflicts++;
			propertyBlocks.push(
				...renderConflict(
					[
						{ label: labels.remote, lines: conflict.remote },
						{ label: labels.local, lines: conflict.local },
					],
					conflict.key,
				),
			);
		}
	}
	out.push(...propertyBlocks);

	const segments = mergeLines(bParts?.body ?? null, lParts.body, rParts.body);
	if (prefer) {
		const settled = preferSide(segments, prefer);
		out.push(...settled.lines);
		replaced += settled.replaced;
	} else {
		for (const segment of segments) {
			if ("ok" in segment) {
				out.push(...segment.ok);
				continue;
			}
			conflicts++;
			out.push(
				...renderConflict([
					{ label: labels.remote, lines: segment.conflict.remote },
					{ label: labels.local, lines: segment.conflict.local },
				]),
			);
		}
	}

	return {
		text: joinLines({ lines: out, eol: l.eol, finalNewline: finalNewline(b, l, r) }),
		conflicts,
		replaced,
	};
}

function finalNewline(base: SplitText | null, local: SplitText, remote: SplitText): boolean {
	if (base === null) return local.finalNewline || remote.finalNewline;
	return local.finalNewline === base.finalNewline ? remote.finalNewline : local.finalNewline;
}

export function mergePlainText(
	base: string | null,
	local: string,
	remote: string,
	prefer?: Side,
): { text: string; replaced: number } | null {
	const b = base === null ? null : splitLines(base);
	const l = splitLines(local);
	const r = splitLines(remote);
	const segments = mergeLines(b?.lines ?? null, l.lines, r.lines);
	if (!prefer && segments.some((segment) => "conflict" in segment)) return null;
	const { lines, replaced } = preferSide(segments, prefer ?? "local");
	return {
		text: joinLines({ lines, eol: l.eol, finalNewline: finalNewline(b, l, r) }),
		replaced,
	};
}
