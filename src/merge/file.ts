import { decodeText, encodeUtf8 } from "../lib/bytes";
import { mergeJson } from "./json";
import { type MergeLabels, mergeMarkdown, mergePlainText } from "./markdown";
import type { Side } from "./text";

export type FileMerge =
	| { kind: "merged"; bytes: Uint8Array; conflicts: number; replaced: number }
	| { kind: "keep-both" }
	| { kind: "take"; side: Side };

export function mergeFile(
	path: string,
	base: Uint8Array | null,
	local: Uint8Array,
	remote: Uint8Array,
	labels: MergeLabels,
	prefer?: Side,
): FileMerge {
	const l = decodeText(local);
	const r = decodeText(remote);
	if (l === null || r === null)
		return prefer ? { kind: "take", side: prefer } : { kind: "keep-both" };
	const b = base === null ? null : decodeText(base);
	const ext = extension(path);

	if (ext === "md") {
		const merged = mergeMarkdown(b, l, r, labels, prefer);
		return {
			kind: "merged",
			bytes: encodeUtf8(merged.text),
			conflicts: merged.conflicts,
			replaced: merged.replaced,
		};
	}
	if (ext === "json" || ext === "canvas") {
		const canvas = ext === "canvas";
		// settings keep this device's value whatever the strategy, the other one is in GitHub's history
		const merged = mergeJson(b, l, r, canvas, canvas ? prefer : undefined);
		if (merged) {
			const bytes = encodeUtf8(merged.text);
			if (!canvas) return { kind: "merged", bytes, conflicts: 0, replaced: 0 };
			return prefer
				? { kind: "merged", bytes, conflicts: 0, replaced: merged.conflicts }
				: { kind: "merged", bytes, conflicts: merged.conflicts, replaced: 0 };
		}
	}
	const merged = mergePlainText(b, l, r, prefer);
	if (merged !== null) {
		return {
			kind: "merged",
			bytes: encodeUtf8(merged.text),
			conflicts: 0,
			replaced: merged.replaced,
		};
	}
	return { kind: "keep-both" };
}

export function extension(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
