import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanLocal } from "./scan";
import type { LocalFile, LocalFs } from "./types";

const vault = process.env.EASY_GIT_VAULT;

class NodeFs implements LocalFs {
	constructor(private readonly root: string) {}
	async listDir(dir: string): Promise<{ files: LocalFile[]; folders: string[] }> {
		const files: LocalFile[] = [];
		const folders: string[] = [];
		for (const entry of readdirSync(join(this.root, dir), { withFileTypes: true })) {
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
			if (entry.isDirectory()) folders.push(path);
			else if (entry.isFile()) {
				const stat = statSync(join(this.root, path));
				files.push({ path, mtime: stat.mtimeMs, size: stat.size });
			}
		}
		return { files, folders };
	}
	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(readFileSync(join(this.root, path)));
	}
	async write(): Promise<boolean> {
		throw new Error("read-only");
	}
	async remove(): Promise<boolean> {
		throw new Error("read-only");
	}
	async backup(): Promise<void> {
		throw new Error("read-only");
	}
}

describe.skipIf(!vault)("scan, live", () => {
	it("syncs exactly what git tracks or would add", { timeout: 120_000 }, async () => {
		const root = vault ?? "";
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd: root, encoding: "utf8" })
				.split("\n")
				.filter(Boolean);
		const tracked = new Set(git("ls-files"));
		const untracked = git("ls-files", "--others", "--exclude-standard");
		const stateFile = ".obsidian/plugins/easy-git-sync/state.json";
		const expected = new Set([...tracked, ...untracked].filter((p) => p !== stateFile));

		const scan = await scanLocal(new NodeFs(root), {}, tracked, stateFile);
		const got = new Set(scan.files.keys());
		expect([...got].filter((p) => !expected.has(p)).sort()).toEqual([]);
		// tracked files deleted from disk are absent from both, nothing else may be missing
		const missing = [...expected].filter((p) => !got.has(p));
		expect(missing.filter((p) => !git("ls-files", "--deleted").includes(p)).sort()).toEqual([]);
	});
});
