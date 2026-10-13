import { describe, expect, it } from "vitest";
import { MemoryFs } from "./fixtures";
import { scanLocal } from "./scan";

const STATE = ".obsidian/plugins/easy-git-sync/state.json";

async function scan(fs: MemoryFs, tracked: string[] = []): Promise<string[]> {
	const result = await scanLocal(fs, {}, new Set(tracked), STATE);
	return [...result.files.keys()];
}

describe("scanLocal", () => {
	it("follows .gitignore, keeping tracked files and skipping ignored folders", async () => {
		const fs = new MemoryFs();
		fs.set(".gitignore", "Private/\n*.log\n");
		fs.set("note.md", "a");
		fs.set("debug.log", "x");
		fs.set("Private/secret.md", "s");
		expect(await scan(fs)).toEqual([".gitignore", "note.md"]);
	});

	it("does not take untracked files from an ignored folder it only entered for a tracked one", async () => {
		const fs = new MemoryFs();
		fs.set(".gitignore", "build/\n!build/new.md\n");
		fs.set("build/tracked.md", "t");
		fs.set("build/new.md", "n");
		expect(await scan(fs, ["build/tracked.md"])).toEqual([".gitignore", "build/tracked.md"]);
	});

	it("leaves out iCloud's placeholders for files not downloaded", async () => {
		const fs = new MemoryFs();
		fs.set("notes/.Plan.md.icloud", "placeholder");
		fs.set("notes/Today.md", "t");
		expect(await scan(fs)).toEqual(["notes/Today.md"]);
	});

	it("lists files in path order, however the folders finish", async () => {
		const fs = new MemoryFs();
		for (const path of ["z.md", "b/2.md", "a/1.md", "b/a/0.md", "a.md"]) fs.set(path, path);
		expect(await scan(fs)).toEqual(["a.md", "a/1.md", "b/2.md", "b/a/0.md", "z.md"]);
	});

	it("reuses cached hashes for unchanged files", async () => {
		const fs = new MemoryFs();
		fs.set("a.md", "one");
		const first = await scanLocal(fs, {}, new Set(), STATE);
		let reads = 0;
		const read = fs.read.bind(fs);
		fs.read = (path) => {
			if (path === "a.md") reads++;
			return read(path);
		};
		const second = await scanLocal(fs, first.cache, new Set(), STATE);
		expect(reads).toBe(0);
		expect(second.files.get("a.md")?.sha).toBe(first.files.get("a.md")?.sha);
	});
});
