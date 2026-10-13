import { type App, type MarkdownPostProcessorContext, TFile } from "obsidian";
import { appendButtons, conflictParts } from "./editor";
import {
	findConflicts,
	hasConflictMarker,
	type ParsedConflict,
	type Resolution,
	resolveConflict,
} from "./merge/conflict";

const PREFIX = "easy-git-sync";

export function conflictPostProcessor(app: App) {
	// called per section, each handed the whole note: parse it once per render
	let last: { text: string; lines: string[]; parts: ReturnType<typeof conflictParts> } | null =
		null;
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
		const info = ctx.getSectionInfo(el);
		if (!info) return;
		if (last?.text !== info.text) {
			const lines = hasConflictMarker(info.text) ? info.text.split("\n") : [];
			last = { text: info.text, lines, parts: conflictParts(lines) };
		}
		const { lines, parts } = last;
		if (parts.size === 0) return;

		const own: number[] = [];
		for (let n = info.lineStart; n <= info.lineEnd; n++) {
			if ((lines[n] ?? "").trim() !== "") own.push(n);
		}
		const mine = own.map((n) => parts.get(n));
		if (mine.every((entry) => entry === undefined)) return;

		const isMarker = (n: number) => {
			const part = parts.get(n)?.part;
			return part !== undefined && (part.endsWith("header") || part === "separator");
		};
		const opening = own.find((n) => parts.get(n)?.part === "current-header");
		const openingConflict = opening === undefined ? undefined : parts.get(opening)?.conflict;

		// markdown would render `>>>>>>>` as a seven-deep quote, so marker-only sections show as text
		if (own.every(isMarker)) {
			el.empty();
			const first = parts.get(own[0] ?? -1)?.part;
			el.addClass(`${PREFIX}-${first}`);
			const p = el.createEl("p", { cls: `${PREFIX}-reading-marker` });
			own.forEach((n, i) => {
				if (i > 0) p.createEl("br");
				p.appendText(lines[n] ?? "");
				const entry = parts.get(n);
				if (entry?.part === "current-header") {
					appendButtons(p, entry.conflict, resolver(app, ctx, el, entry.conflict));
				}
			});
			return;
		}

		const content = own
			.map((n) => parts.get(n)?.part)
			.find((part) => part && !part.endsWith("header"));
		if (content && content !== "separator") el.addClass(`${PREFIX}-${content}`);
		// the opening marker shares a paragraph with the text above it
		if (openingConflict)
			appendButtons(el, openingConflict, resolver(app, ctx, el, openingConflict));
	};
}

function resolver(
	app: App,
	ctx: MarkdownPostProcessorContext,
	el: HTMLElement,
	conflict: ParsedConflict,
): (choice: Resolution) => void {
	return (choice) => {
		const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!(file instanceof TFile)) return;
		// where the block is now: a cached section is not re-rendered after edits above it
		const at = ctx.getSectionInfo(el)?.lineStart ?? conflict.start;
		void app.vault.process(file, (text) => {
			const nearest = findConflicts(text.split("\n")).sort(
				(a, b) => Math.abs(a.start - at) - Math.abs(b.start - at),
			)[0];
			return nearest ? (resolveConflict(text, nearest.start, choice) ?? text) : text;
		});
	};
}
