export interface SplitText {
	lines: string[];
	eol: "\n" | "\r\n";
	finalNewline: boolean;
}

export function splitLines(text: string): SplitText {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const finalNewline = text.endsWith("\n");
	let body = text;
	if (finalNewline) body = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
	const lines = body === "" && !finalNewline ? [] : body.split(/\r?\n/);
	return { lines, eol, finalNewline };
}

export function joinLines(split: SplitText): string {
	if (split.lines.length === 0) return "";
	return split.lines.join(split.eol) + (split.finalNewline ? split.eol : "");
}
