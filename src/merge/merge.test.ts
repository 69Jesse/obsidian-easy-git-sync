import { describe, expect, it } from "vitest";
import { decodeText, encodeUtf8 } from "../lib/bytes";
import {
	findConflicts,
	newerSide,
	renderConflict,
	resolveAllNewer,
	resolveConflict,
	sideName,
} from "./conflict";
import { mergeFile } from "./file";
import { mergeFrontmatter } from "./frontmatter";
import { mergeJson } from "./json";
import { mergeMarkdown, mergePlainText } from "./markdown";
import { mergeLines } from "./text";

const labels = { local: "iPhone", remote: "MacBook" };
const md = (lines: string[]) => `${lines.join("\n")}\n`;

interface CanvasNode {
	id: string;
	text: string;
}

const canvasNodes = (text: string | undefined) =>
	(JSON.parse(text ?? "") as { nodes: CanvasNode[] }).nodes;

describe("mergeLines", () => {
	it("takes changes made on different lines from both sides", () => {
		const base = ["a", "b", "c", "d", "e"];
		const local = ["a", "B", "c", "d", "e"];
		const remote = ["a", "b", "c", "d", "E"];
		expect(mergeLines(base, local, remote)).toEqual([{ ok: ["a", "B", "c", "d", "E"] }]);
	});

	it("takes edits to neighbouring lines from both sides, where git would conflict", () => {
		const base = ["- [ ] milk", "- [ ] bread", "- [ ] eggs"];
		const local = ["- [x] milk", "- [ ] bread", "- [ ] eggs"];
		const remote = ["- [ ] milk", "- [x] bread", "- [ ] eggs"];
		expect(mergeLines(base, local, remote)).toEqual([
			{ ok: ["- [x] milk", "- [x] bread", "- [ ] eggs"] },
		]);
	});

	it("takes the same change made on both sides once", () => {
		const base = ["a", "b"];
		expect(mergeLines(base, ["a", "x"], ["a", "x"])).toEqual([{ ok: ["a", "x"] }]);
	});

	it("keeps both insertions at the same spot, remote first, without a conflict", () => {
		const base = ["# Log", "- one"];
		const local = ["# Log", "- one", "- from phone"];
		const remote = ["# Log", "- one", "- from mac"];
		expect(mergeLines(base, local, remote)).toEqual([
			{ ok: ["# Log", "- one", "- from mac", "- from phone"] },
		]);
	});

	it("does not duplicate a line both sides inserted", () => {
		const base = ["a"];
		const local = ["a", "same", "phone"];
		const remote = ["a", "same", "mac"];
		expect(mergeLines(base, local, remote)).toEqual([{ ok: ["a", "same", "mac", "phone"] }]);
	});

	it("marks the same line changed differently as a conflict, and only that line", () => {
		const base = ["a", "b", "c"];
		const local = ["a", "phone", "c"];
		const remote = ["a", "mac", "c"];
		expect(mergeLines(base, local, remote)).toEqual([
			{ ok: ["a"] },
			{ conflict: { remote: ["mac"], local: ["phone"] } },
			{ ok: ["c"] },
		]);
	});

	it("marks an edit against a deletion as a conflict with one empty side", () => {
		const base = ["a", "b", "c"];
		const local = ["a", "c"];
		const remote = ["a", "B", "c"];
		expect(mergeLines(base, local, remote)).toEqual([
			{ ok: ["a"] },
			{ conflict: { remote: ["B"], local: [] } },
			{ ok: ["c"] },
		]);
	});

	it("without a base keeps common lines once and every line only one side has", () => {
		const local = ["# 2026-10-06", "", "## Tasks", "- [ ] phone task"];
		const remote = ["# 2026-10-06", "", "## Tasks", "- [ ] mac task"];
		expect(mergeLines(null, local, remote)).toEqual([
			{ ok: ["# 2026-10-06", "", "## Tasks"] },
			{ conflict: { remote: ["- [ ] mac task"], local: ["- [ ] phone task"] } },
		]);
		expect(mergeLines(null, ["a", "b"], ["a", "c", "b"])).toEqual([{ ok: ["a", "c", "b"] }]);
	});
});

describe("mergeMarkdown", () => {
	it("writes a conflict block that parses back to both versions", () => {
		const base = md(["intro", "Meeting on Monday.", "outro"]);
		const local = md(["intro", "Meeting moved to Thursday.", "outro"]);
		const remote = md(["intro", "Meeting moved to Friday.", "outro"]);
		const merged = mergeMarkdown(base, local, remote, labels);
		expect(merged.conflicts).toBe(1);
		const lines = merged.text.split("\n");
		const [conflict] = findConflicts(lines);
		expect(conflict?.property).toBeNull();
		expect(conflict?.sides.map((s) => [s.label, s.lines])).toEqual([
			["MacBook", ["Meeting moved to Friday."]],
			["iPhone", ["Meeting moved to Thursday."]],
		]);
		expect(lines[0]).toBe("intro");
		expect(merged.text.endsWith("outro\n")).toBe(true);
	});

	it("resolves a block to either side or both", () => {
		const text = md([
			"a",
			...renderConflict([
				{ label: "MacBook", lines: ["x"] },
				{ label: "iPhone", lines: ["y"] },
			]),
			"b",
		]);
		expect(resolveConflict(text, 1, { keep: 0 })).toBe(md(["a", "x", "b"]));
		expect(resolveConflict(text, 1, { keep: 1 })).toBe(md(["a", "y", "b"]));
		expect(resolveConflict(text, 1, "both")).toBe(md(["a", "x", "y", "b"]));
		expect(resolveConflict(text, 0, "both")).toBeNull();
	});

	it("merges frontmatter per property and never puts a block inside it", () => {
		const base = md(["---", "status: draft", "tags:", "  - a", "---", "body"]);
		const local = md(["---", "status: waiting", "tags:", "  - a", "  - phone", "---", "body"]);
		const remote = md([
			"---",
			"status: done",
			"tags:",
			"  - a",
			"  - mac",
			"due: 2026-10-08",
			"---",
			"body",
		]);
		const merged = mergeMarkdown(base, local, remote, labels);
		expect(merged.conflicts).toBe(1);
		const lines = merged.text.split("\n");
		expect(lines.slice(0, 8)).toEqual([
			"---",
			"status: waiting",
			"tags:",
			"  - a",
			"  - phone",
			"  - mac",
			"due: 2026-10-08",
			"---",
		]);
		const [conflict] = findConflicts(lines);
		expect(conflict?.property).toBe("status");
		expect(conflict?.start).toBe(8);

		const keptRemote = resolveConflict(merged.text, 8, { keep: 0 });
		expect(keptRemote).toBe(
			md([
				"---",
				"status: done",
				"tags:",
				"  - a",
				"  - phone",
				"  - mac",
				"due: 2026-10-08",
				"---",
				"body",
			]),
		);
	});

	it("keeps a property one side edited and the other deleted", () => {
		const merged = mergeFrontmatter(["a: 1", "b: 2"], ["a: 1"], ["a: 1", "b: 3"]);
		expect(merged).toEqual({ lines: ["a: 1", "b: 3"], conflicts: [] });
	});

	it("keeps CRLF line endings and the final newline", () => {
		const base = "a\r\nb\r\n";
		const merged = mergeMarkdown(base, "a\r\nB\r\n", "A\r\nb\r\n", labels);
		expect(merged).toEqual({ text: "A\r\nB\r\n", conflicts: 0, replaced: 0 });
	});

	it("merges a note created on both devices from the same template", () => {
		const local = md(["# Monday", "", "- phone"]);
		const remote = md(["# Monday", "", "- mac"]);
		const merged = mergeMarkdown(null, local, remote, labels);
		expect(merged.conflicts).toBe(1);
		expect(merged.text.startsWith("# Monday\n\n<<<<<<< MacBook (sync conflict)\n")).toBe(true);
	});

	it("takes the other side whole when one side of a new note is empty", () => {
		expect(mergeMarkdown(null, "", md(["text"]), labels)).toEqual({
			text: md(["text"]),
			conflicts: 0,
			replaced: 0,
		});
	});

	it("keeping the newer version, settles only the clashing places", () => {
		const base = md(["---", "status: draft", "---", "one", "two", "three", "four"]);
		const local = md(["---", "status: waiting", "---", "ONE phone", "two", "three", "four"]);
		const remote = md(["---", "status: done", "---", "ONE mac", "two", "three", "FOUR"]);
		expect(mergeMarkdown(base, local, remote, labels, "remote")).toEqual({
			text: md(["---", "status: done", "---", "ONE mac", "two", "three", "FOUR"]),
			conflicts: 0,
			replaced: 2,
		});
		expect(mergeMarkdown(base, local, remote, labels, "local")).toEqual({
			text: md(["---", "status: waiting", "---", "ONE phone", "two", "three", "FOUR"]),
			conflicts: 0,
			replaced: 2,
		});
	});
});

describe("mergePlainText", () => {
	it("merges cleanly or gives up", () => {
		expect(mergePlainText("a\nb\n", "A\nb\n", "a\nB\n")?.text).toBe("A\nB\n");
		expect(mergePlainText("a\n", "x\n", "y\n")).toBeNull();
	});

	it("takes the preferred side's lines where they clash", () => {
		const [base, local, remote] = ["a\nm\nn\nb\n", "x\nm\nn\nb\n", "y\nm\nn\nB\n"];
		expect(mergePlainText(base, local, remote, "remote")).toEqual({
			text: "y\nm\nn\nB\n",
			replaced: 1,
		});
		expect(mergePlainText(base, local, remote, "local")).toEqual({
			text: "x\nm\nn\nB\n",
			replaced: 1,
		});
	});
});

describe("mergeJson", () => {
	it("merges settings key by key, this device winning a real clash", () => {
		const base = JSON.stringify({ a: 1, b: { c: 1, d: 1 } }, null, 2);
		const local = JSON.stringify({ a: 2, b: { c: 2, d: 1 } }, null, 2);
		const remote = JSON.stringify({ a: 3, b: { c: 1, d: 2 }, e: true }, null, 2);
		const merged = mergeJson(base, local, remote, false);
		expect(merged?.conflicts).toBe(1);
		expect(JSON.parse(merged?.text ?? "")).toEqual({ a: 2, b: { c: 2, d: 2 }, e: true });
		expect(merged?.text.split("\n")[1]).toBe('  "a": 2,');
	});

	it("keeps both versions of a canvas node changed on both sides", () => {
		const node = (text: string) => ({
			id: "n1",
			type: "text",
			text,
			x: 0,
			y: 0,
			width: 100,
			height: 50,
		});
		const base = JSON.stringify({ nodes: [node("base")], edges: [] }, null, "\t");
		const local = JSON.stringify({ nodes: [node("phone")], edges: [] }, null, "\t");
		const remote = JSON.stringify(
			{
				nodes: [
					node("mac"),
					{ id: "n2", type: "text", text: "new", x: 9, y: 9, width: 1, height: 1 },
				],
				edges: [],
			},
			null,
			"\t",
		);
		const merged = mergeJson(base, local, remote, true);
		const nodes = canvasNodes(merged?.text);
		expect(merged?.conflicts).toBe(1);
		expect(nodes.map((n) => [n.id, n.text])).toEqual([
			["n1", "phone"],
			["n2", "new"],
			["n1-conflict", "mac"],
		]);
		expect(nodes[2]).toMatchObject({ x: 40, y: 40, color: "1" });

		const newer = mergeJson(base, local, remote, true, "remote");
		expect(newer?.conflicts).toBe(1);
		expect(canvasNodes(newer?.text).map((n) => [n.id, n.text])).toEqual([
			["n1", "mac"],
			["n2", "new"],
		]);
	});
});

describe("mergeFile", () => {
	it("keeps both files for binaries", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
		expect(mergeFile("a.png", null, png, new Uint8Array([0x89, 0]), labels)).toEqual({
			kind: "keep-both",
		});
	});

	it("keeps both files for a code file that will not merge cleanly", () => {
		const r = mergeFile("x.css", encodeUtf8("a\n"), encodeUtf8("b\n"), encodeUtf8("c\n"), labels);
		expect(r.kind).toBe("keep-both");
	});

	it("merges a note to bytes", () => {
		const r = mergeFile(
			"n.md",
			encodeUtf8("a\nb\n"),
			encodeUtf8("A\nb\n"),
			encodeUtf8("a\nB\n"),
			labels,
		);
		expect(r.kind === "merged" && decodeText(r.bytes)).toBe("A\nB\n");
	});

	it("takes the preferred side whole for a binary, and settles a code file by lines", () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
		expect(mergeFile("a.png", null, png, new Uint8Array([0x89, 0]), labels, "remote")).toEqual({
			kind: "take",
			side: "remote",
		});
		const r = mergeFile(
			"x.css",
			encodeUtf8("a\n"),
			encodeUtf8("b\n"),
			encodeUtf8("c\n"),
			labels,
			"local",
		);
		expect(r).toEqual({ kind: "merged", bytes: encodeUtf8("b\n"), conflicts: 0, replaced: 1 });
	});

	it("keeps a settings clash for this device, whichever side is newer", () => {
		const r = mergeFile(
			"app.json",
			encodeUtf8('{"a":1}'),
			encodeUtf8('{"a":2}'),
			encodeUtf8('{"a":3}'),
			labels,
			"remote",
		);
		expect(r.kind === "merged" && [decodeText(r.bytes), r.replaced]).toEqual(['{"a":2}', 0]);
	});
});

describe("resolving to the newer side", () => {
	const block = (top: string, bottom: string, lines: [string, string]) =>
		renderConflict([
			{ label: top, lines: [lines[0]] },
			{ label: bottom, lines: [lines[1]] },
		]);

	it("tells the newer side from the labels' dates", () => {
		const [conflict] = findConflicts(
			block("MacBook, 2026-10-06 14:28", "iPhone, 2026-10-06 14:31", ["x", "y"]),
		);
		expect(conflict && newerSide(conflict)).toBe(1);
	});

	it("cannot tell within one minute, without dates, or in git's blocks", () => {
		const same = findConflicts(block("A, 2026-10-06 14:28", "B, 2026-10-06 14:28", ["x", "y"]));
		const undated = findConflicts(block("A", "B", ["x", "y"]));
		const git = findConflicts(["<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> main"]);
		for (const [conflict] of [same, undated, git])
			expect(conflict && newerSide(conflict)).toBeNull();
	});

	it("resolves every block it can, properties included, and counts the rest", () => {
		const text = md([
			"---",
			"status: waiting",
			"---",
			...renderConflict(
				[
					{ label: "MacBook, 2026-10-06 14:28", lines: ["status: done"] },
					{ label: "iPhone, 2026-10-06 14:20", lines: ["status: waiting"] },
				],
				"status",
			),
			"intro",
			...block("MacBook, 2026-10-06 14:28", "iPhone, 2026-10-06 14:31", ["mac", "phone"]),
			"middle",
			...block("MacBook", "iPhone", ["a", "b"]),
			"outro",
		]);
		const result = resolveAllNewer(text);
		expect(result.resolved).toBe(2);
		expect(result.skipped).toBe(1);
		const lines = result.text.split("\n");
		expect(lines.slice(0, 6)).toEqual(["---", "status: done", "---", "intro", "phone", "middle"]);
		expect(findConflicts(lines)).toHaveLength(1);
	});
});

describe("git's own conflict blocks", () => {
	it("are found, with git's labels and the lines exactly as git wrote them", () => {
		const text = md([
			"a",
			"<<<<<<< HEAD",
			"",
			"mine",
			"=======",
			"theirs",
			">>>>>>> origin/main",
			"b",
		]);
		const [conflict] = findConflicts(text.split("\n"));
		expect(conflict?.sync).toBe(false);
		expect(conflict?.sides.map((s) => [s.label, s.lines])).toEqual([
			["HEAD", ["", "mine"]],
			["origin/main", ["theirs"]],
		]);
		expect(resolveConflict(text, 1, { keep: 1 })).toBe(md(["a", "theirs", "b"]));
		expect(resolveConflict(text, 1, "both")).toBe(md(["a", "", "mine", "theirs", "b"]));
	});

	it("drop the base section of git's three-way style", () => {
		const text = md(["<<<<<<< ours", "x", "||||||| base", "o", "=======", "y", ">>>>>>> theirs"]);
		expect(resolveConflict(text, 0, { keep: 0 })).toBe(md(["x"]));
		expect(resolveConflict(text, 0, "both")).toBe(md(["x", "y"]));
	});

	it("name an unlabelled side top or bottom", () => {
		const [conflict] = findConflicts(["<<<<<<<", "x", "=======", "y", ">>>>>>>"]);
		expect(conflict && [sideName(conflict, 0), sideName(conflict, 1)]).toEqual(["top", "bottom"]);
	});

	it("are told apart from the plugin's, whose labels name the device", () => {
		const lines = renderConflict([
			{ label: "MacBook, 2026-10-06 14:28", lines: ["x"] },
			{ label: "iPhone, 2026-10-06 14:31", lines: [] },
		]);
		expect(lines).toEqual([
			"<<<<<<< MacBook, 2026-10-06 14:28 (sync conflict)",
			"",
			"x",
			"",
			"=======",
			"",
			">>>>>>> iPhone, 2026-10-06 14:31",
		]);
		const [conflict] = findConflicts(lines);
		expect(conflict?.sync).toBe(true);
		expect(conflict && [sideName(conflict, 0), sideName(conflict, 1)]).toEqual([
			"MacBook",
			"iPhone",
		]);
		expect(conflict?.sides.map((s) => s.lines)).toEqual([["x"], []]);
	});
});
