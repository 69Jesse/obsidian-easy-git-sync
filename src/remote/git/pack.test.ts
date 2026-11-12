import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { encodeUtf8 } from "../../lib/bytes";
import {
	type GitObject,
	hashObject,
	parseCommit,
	parseTree,
	signature,
	writeCommit,
	writeTree,
} from "./objects";
import { readPack, writePack } from "./pack";

const dir = mkdtempSync(join(tmpdir(), "easy-git-pack-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function git(args: string[], input?: Uint8Array): Buffer {
	return execFileSync("git", ["-C", dir, ...args], {
		...(input ? { input } : {}),
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
		maxBuffer: 64 * 1024 * 1024,
	});
}

describe("packs against git itself", () => {
	git(["init", "-q", "-b", "main"]);
	const note = Array.from({ length: 300 }, (_, i) => `line ${i} of a long note\n`).join("");
	for (let round = 0; round < 4; round++) {
		writeFileSync(join(dir, "note.md"), `${note}round ${round}\n`);
		writeFileSync(join(dir, `file ${round}.md`), `the ${round}th file\n`);
		git(["add", "-A"]);
		git(["commit", "-q", "-m", `round ${round}`]);
	}

	it("reads a pack full of deltas exactly as git stores the objects", async () => {
		const list = git(["rev-list", "--objects", "--all"])
			.toString()
			.trim()
			.split("\n")
			.map((line) => line.split(" ")[0] ?? "");
		const pack = git(["pack-objects", "--stdout", "--window=10", "--depth=5"], encodeUtf8(`${list.join("\n")}\n`));
		const objects = await readPack(new Uint8Array(pack));
		expect(objects.size).toBe(list.length);
		for (const sha of list) {
			const object = objects.get(sha);
			expect(object, sha).toBeDefined();
			const type = git(["cat-file", "-t", sha]).toString().trim();
			expect(object?.type).toBe(type);
			const content = git(["cat-file", type, sha]);
			expect(Buffer.from(object?.data ?? []).equals(content)).toBe(true);
		}
	});

	it("parses and rewrites trees and commits byte for byte", async () => {
		const head = git(["rev-parse", "HEAD"]).toString().trim();
		const commitData = new Uint8Array(git(["cat-file", "commit", head]));
		const commit = parseCommit(commitData);
		expect(Buffer.from(writeCommit(commit)).equals(Buffer.from(commitData))).toBe(true);
		expect(await hashObject({ type: "commit", data: writeCommit(commit) })).toBe(head);
		const treeData = new Uint8Array(git(["cat-file", "tree", commit.tree]));
		const entries = parseTree(treeData);
		expect(entries.map((e) => e.name)).toContain("note.md");
		expect(await hashObject({ type: "tree", data: writeTree([...entries].reverse()) })).toBe(
			commit.tree,
		);
	});

	it("writes a pack git accepts, sorting folders the way git does", async () => {
		const blob: GitObject = { type: "blob", data: encodeUtf8("written by the plugin\n") };
		const blobSha = await hashObject(blob);
		const inner: GitObject = {
			type: "tree",
			data: writeTree([{ mode: "100644", name: "a.md", sha: blobSha }]),
		};
		const innerSha = await hashObject(inner);
		// fsck rejects a tree out of git's order, in which folder "a" compares as "a/"
		const root: GitObject = {
			type: "tree",
			data: writeTree([
				{ mode: "40000", name: "a", sha: innerSha },
				{ mode: "100644", name: "a.md", sha: blobSha },
				{ mode: "100755", name: "run.sh", sha: blobSha },
			]),
		};
		const rootSha = await hashObject(root);
		const when = new Date(Date.UTC(2026, 9, 23, 12, 0, 0));
		const commit: GitObject = {
			type: "commit",
			data: writeCommit({
				tree: rootSha,
				parents: [],
				author: signature("Jesse", "jesse@example.com", when),
				committer: signature("Jesse", "jesse@example.com", when),
				message: "iPhone: a.md",
			}),
		};
		const commitSha = await hashObject(commit);
		const pack = await writePack([commit, root, inner, blob]);
		git(["unpack-objects", "-q"], pack);
		git(["fsck", "--no-dangling", commitSha]);
		expect(git(["ls-tree", "-r", "--name-only", commitSha]).toString().trim().split("\n")).toEqual([
			"a.md",
			"a/a.md",
			"run.sh",
		]);
	});
});
