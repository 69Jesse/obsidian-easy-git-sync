import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import {
	findConflicts,
	hasConflictMarker,
	newerSide,
	type ParsedConflict,
	type Resolution,
	resolveConflict,
	sideName,
} from "./merge/conflict";

const PREFIX = "easy-git-sync";

export function conflictEditorExtension(): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(update: ViewUpdate) {
				if (!update.docChanged) return;
				// a note without blocks is parsed again only once a touched line looks like a marker
				if (this.decorations.size === 0 && !touchesMarker(update)) return;
				this.decorations = build(update.view);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

// named after VS Code's merge colours
export type ConflictPart =
	| "current-header"
	| "current"
	| "common-header"
	| "common"
	| "separator"
	| "incoming"
	| "incoming-header";

export function conflictParts(
	lines: string[],
): Map<number, { part: ConflictPart; conflict: ParsedConflict }> {
	const parts = new Map<number, { part: ConflictPart; conflict: ParsedConflict }>();
	for (const conflict of findConflicts(lines)) {
		const separator = conflict.sides[1].marker;
		let inBase = false;
		for (let n = conflict.start; n <= conflict.end; n++) {
			let part: ConflictPart;
			if (n === conflict.start) part = "current-header";
			else if (n === conflict.end) part = "incoming-header";
			else if (n === separator) part = "separator";
			else if (n < separator && /^\|{7}(?: |$)/.test(lines[n] ?? "")) {
				inBase = true;
				part = "common-header";
			} else if (n < separator) part = inBase ? "common" : "current";
			else part = "incoming";
			parts.set(n, { part, conflict });
		}
	}
	return parts;
}

const MARKER_START = /^(?:<{7}|={7}|>{7}|\|{7})/;

function touchesMarker(update: ViewUpdate): boolean {
	const doc = update.state.doc;
	let found = false;
	update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (found) return;
		for (let n = doc.lineAt(fromB).number; n <= doc.lineAt(toB).number; n++) {
			if (MARKER_START.test(doc.line(n).text)) {
				found = true;
				return;
			}
		}
	});
	return found;
}

function build(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc;
	const text = doc.toString();
	if (!hasConflictMarker(text)) return builder.finish();

	const parts = conflictParts(text.split("\n"));
	for (const n of [...parts.keys()].sort((a, b) => a - b)) {
		const entry = parts.get(n);
		if (!entry) continue;
		const line = doc.line(n + 1);
		const marker = entry.part.endsWith("header") || entry.part === "separator";
		const classes = `${PREFIX}-${entry.part}${marker ? ` ${PREFIX}-marker-line` : ""}`;
		builder.add(line.from, line.from, Decoration.line({ class: classes }));
		if (entry.part === "current-header") {
			builder.add(
				line.to,
				line.to,
				Decoration.widget({ widget: new ButtonsWidget(entry.conflict), side: 1 }),
			);
		}
	}
	return builder.finish();
}

function resolveAt(view: EditorView, at: number, choice: Resolution): void {
	const doc = view.state.doc;
	const text = doc.toString();
	const next = resolveConflict(text, doc.lineAt(at).number - 1, choice);
	if (next === null || next === text) return;
	let from = 0;
	const max = Math.min(text.length, next.length);
	while (from < max && text[from] === next[from]) from++;
	let tail = 0;
	while (tail < max - from && text[text.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
	// not Editor.transaction, which always scrolls the selection into view
	view.dispatch({
		changes: { from, to: text.length - tail, insert: next.slice(from, next.length - tail) },
	});
}

class ButtonsWidget extends WidgetType {
	constructor(private readonly conflict: ParsedConflict) {
		super();
	}

	override eq(other: ButtonsWidget): boolean {
		// whole labels, dates included: they decide which button says (newer)
		return (
			other.conflict.property === this.conflict.property &&
			other.conflict.sides[0].label === this.conflict.sides[0].label &&
			other.conflict.sides[1].label === this.conflict.sides[1].label
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const el = createSpan();
		appendButtons(el, this.conflict, (choice) => resolveAt(view, view.posAtDOM(el), choice));
		return el;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

export function appendButtons(
	parent: HTMLElement,
	conflict: ParsedConflict,
	resolve: (choice: Resolution) => void,
): void {
	const row = parent.createSpan({ cls: `${PREFIX}-buttons` });
	const newer = newerSide(conflict);
	const add = (text: string, choice: Resolution) => {
		const label = choice !== "both" && choice.keep === newer ? `${text} (newer)` : text;
		const button = row.createEl("button", { text: label, cls: `${PREFIX}-button` });
		button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("click", (event) => {
			event.preventDefault();
			resolve(choice);
		});
	};
	add(`Keep ${sideName(conflict, 0)}`, { keep: 0 });
	add(`Keep ${sideName(conflict, 1)}`, { keep: 1 });
	if (conflict.property === null) add("Keep both", "both");
}
