import { describe, expect, it } from "vitest";
import { commitMessage, deviceFromMessage, summarize } from "./format";

describe("summarize", () => {
	const none = new Set<string>();

	it("names one file, however long its path", () => {
		const long = `${"deep/".repeat(20)}note.md`;
		expect(summarize([long], none)).toBe(long);
	});

	it("lists up to three files, marking deletions", () => {
		expect(
			summarize(["work/plan.md", "scratchpad/draft.md"], new Set(["scratchpad/draft.md"])),
		).toBe("work/plan.md, deleted scratchpad/draft.md");
	});

	it("counts more files, with the folders they are in", () => {
		const files = ["work/a.md", "work/b.md", "attachments/x.png", "todo.md"];
		expect(summarize(files, none)).toBe("4 files (work/, attachments/, top level)");
	});

	it("counts three files whose list would be too long", () => {
		const files = [`work/${"a".repeat(40)}.md`, `work/${"b".repeat(40)}.md`, "c.md"];
		expect(summarize(files, none)).toBe("3 files (work/, top level)");
	});

	it("says so when every file was deleted, and caps the folders shown", () => {
		const files = ["a/1.md", "b/2.md", "c/3.md", "d/4.md", "e/5.md"];
		expect(summarize(files, new Set(files))).toBe("deleted 5 files (a/, b/, c/, 2 more)");
	});
});

describe("commitMessage", () => {
	it("names the device and the change, with the device trailer", () => {
		const message = commitMessage({ device: "iPhone", files: ["daily/2026-10-06.md"] });
		expect(message).toBe("iPhone: daily/2026-10-06.md\n\nSynced-From: iPhone");
		expect(deviceFromMessage(message)).toBe("iPhone");
	});

	it("keeps a device name with a line break on one line", () => {
		expect(commitMessage({ device: "Mac\nBook", files: ["a.md"] })).toBe(
			"Mac Book: a.md\n\nSynced-From: Mac Book",
		);
	});
});

describe("commit body", () => {
	it("lists the files when the subject only counts them", () => {
		const files = ["work/a.md", "work/b.md", "attachments/x.png", "old.md"];
		expect(commitMessage({ device: "Mac", files, deleted: new Set(["old.md"]) })).toBe(
			[
				"Mac: 4 files (work/, attachments/, top level)",
				"",
				"- work/a.md",
				"- work/b.md",
				"- attachments/x.png",
				"- deleted old.md",
				"",
				"Synced-From: Mac",
			].join("\n"),
		);
	});

	it("leaves the body to the trailer when the subject already names every file", () => {
		expect(commitMessage({ device: "Mac", files: ["a.md", "b.md"] })).toBe(
			"Mac: a.md, b.md\n\nSynced-From: Mac",
		);
	});
});
