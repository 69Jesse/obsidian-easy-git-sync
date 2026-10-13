import { describe, expect, it } from "vitest";
import { findConflicts } from "../merge/conflict";
import { MassDeleteError } from "./engine";
import { Device, MemoryRemote } from "./fixtures";

const GITIGNORE = ".gitignore";

function content(files: Record<string, string>): Record<string, string> {
	const { [GITIGNORE]: _, ...rest } = files;
	return rest;
}

async function setup(files: Record<string, string>) {
	const remote = new MemoryRemote();
	const mac = new Device("MacBook", remote);
	const phone = new Device("iPhone", remote);
	for (const [path, text] of Object.entries(files)) mac.fs.set(path, text);
	await mac.sync();
	await phone.sync();
	return { remote, mac, phone };
}

describe("first sync", () => {
	it("gives an empty repository a .gitignore and uploads the vault", async () => {
		const remote = new MemoryRemote();
		const mac = new Device("MacBook", remote);
		mac.fs.set("a.md", "hello\n");
		mac.fs.set(".obsidian/app.json", "{}\n");
		const report = await mac.sync();
		expect(report.initialized).toBe(true);
		const snap = remote.snapshot();
		expect(Object.keys(snap).sort()).toEqual([GITIGNORE, ".obsidian/app.json", "a.md"]);
		expect(snap[GITIGNORE]).toContain(".obsidian/workspace.json");
		expect(mac.fs.get(GITIGNORE)).toBe(snap[GITIGNORE]);
		expect(remote.commits.get(remote.headSha ?? "")?.message).toMatch(
			/^MacBook: \.obsidian\/app\.json, a\.md\n\nSynced-From: MacBook$/,
		);
	});

	it("counts a vault with only config files as having no notes", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ "a.md": "a\n", ".obsidian/app.json": "{}\n" });
		const phone = new Device("iPhone", remote);
		phone.fs.set(".obsidian/app.json", '{"theme":"dark"}\n');
		phone.fs.set(".obsidian/plugins/easy-git-sync/main.js", "plugin\n");
		expect((await phone.preview()).notes).toEqual({ here: 0, there: 1, differ: 1 });
	});

	it("counts notes that differ on both sides", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ "a.md": "a\n", "b.md": "b\n" });
		const phone = new Device("iPhone", remote);
		phone.fs.set("a.md", "a\n");
		phone.fs.set("c.md", "c\n");
		expect((await phone.preview()).notes).toEqual({ here: 2, there: 2, differ: 2 });
	});

	it("downloads everything into an empty vault", async () => {
		const { mac, phone } = await setup({ "a.md": "a\n", "folder/b.md": "b\n" });
		expect(phone.fs.text()).toEqual(mac.fs.text());
	});

	it("adopts a vault that already matches without committing", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ "a.md": "same\n" });
		const head = remote.headSha;
		const mac = new Device("MacBook", remote);
		mac.fs.set("a.md", "same\n");
		const report = await mac.sync();
		expect(report.commit).toBeNull();
		expect(remote.headSha).toBe(head);
	});

	it("merges a vault and a repository that both have content", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ "shared.md": "# Day\n- from mac\n", "only-remote.md": "r\n" });
		const phone = new Device("iPhone", remote);
		phone.fs.set("shared.md", "# Day\n- from phone\n");
		phone.fs.set("only-local.md", "l\n");
		await phone.sync();
		expect(Object.keys(remote.snapshot()).sort()).toEqual([
			"only-local.md",
			"only-remote.md",
			"shared.md",
		]);
		const lines = (phone.fs.get("shared.md") ?? "").split("\n");
		expect(lines[0]).toBe("# Day");
		expect(findConflicts(lines)[0]?.sides.map((s) => s.lines)).toEqual([
			["- from mac"],
			["- from phone"],
		]);
	});
});

describe("steady state", () => {
	it("costs one request when nothing changed anywhere", async () => {
		const { remote, phone } = await setup({ "a.md": "a\n" });
		remote.requests = 0;
		const report = await phone.sync();
		expect(report.commit).toBeNull();
		expect(remote.requests).toBe(1);
	});

	it("merges edits to different lines silently, and both devices converge", async () => {
		const { remote, mac, phone } = await setup({ "n.md": "one\ntwo\nthree\nfour\n" });
		mac.fs.set("n.md", "ONE\ntwo\nthree\nfour\n");
		phone.fs.set("n.md", "one\nTWO\nthree\nfour\n");
		await mac.sync();
		const report = await phone.sync();
		expect(report.merged).toEqual(["n.md"]);
		expect(report.conflicts).toEqual([]);
		await mac.sync();
		expect(mac.fs.get("n.md")).toBe("ONE\nTWO\nthree\nfour\n");
		expect(phone.fs.get("n.md")).toBe("ONE\nTWO\nthree\nfour\n");
		expect(remote.snapshot()["n.md"]).toBe("ONE\nTWO\nthree\nfour\n");
	});

	it("writes a conflict block for the same line edited on both, labelled by device", async () => {
		const { mac, phone } = await setup({ "n.md": "Meeting on Monday.\n" });
		mac.fs.set("n.md", "Meeting on Friday.\n");
		phone.fs.set("n.md", "Meeting on Thursday.\n");
		await mac.sync();
		const report = await phone.sync();
		expect(report.conflicts).toEqual([{ path: "n.md", count: 1 }]);
		await mac.sync();
		expect(mac.fs.get("n.md")).toBe(phone.fs.get("n.md"));
		const [conflict] = findConflicts((phone.fs.get("n.md") ?? "").split("\n"));
		expect(conflict?.sides.map((s) => s.label.split(", ")[0])).toEqual(["MacBook", "iPhone"]);
		expect(conflict?.sides.map((s) => s.lines)).toEqual([
			["Meeting on Friday."],
			["Meeting on Thursday."],
		]);
		expect(phone.state.conflicts).toEqual(["n.md"]);
	});

	it("labels the other side GitHub when the change came from outside the plugin", async () => {
		const { remote, phone } = await setup({ "n.md": "x\n" });
		await remote.pushDirect({ "n.md": "from cli\n" });
		phone.fs.set("n.md", "from phone\n");
		await phone.sync();
		const [conflict] = findConflicts((phone.fs.get("n.md") ?? "").split("\n"));
		expect(conflict?.sides[0]?.label).toMatch(/^GitHub, /);
	});

	it("keeps both files for a binary changed on both sides", async () => {
		const { remote, mac, phone } = await setup({ "a.png": "\u0000base" });
		mac.fs.set("a.png", new Uint8Array([0, 1]));
		phone.fs.set("a.png", new Uint8Array([0, 2]));
		await mac.sync();
		const report = await phone.sync();
		expect(report.keptBoth).toEqual([
			{ path: "a.png", copy: "a (conflict MacBook 2026-10-06 1431).png" },
		]);
		await mac.sync();
		const files = Object.keys(remote.snapshot()).sort();
		expect(files).toContain("a (conflict MacBook 2026-10-06 1431).png");
		expect(Object.keys(mac.fs.text()).sort()).toEqual(Object.keys(phone.fs.text()).sort());
		expect(phone.fs.files.get("a.png")?.data).toEqual(new Uint8Array([0, 2]));
	});
});

describe("keeping the newer version", () => {
	const at = (minute: number) => new Date(2026, 9, 6, 13, minute);

	it("records when the newest edit in a commit was made as its author date", async () => {
		const { remote, mac } = await setup({ "n.md": "a\n" });
		mac.fs.set("n.md", "b\n", at(5));
		await mac.sync();
		expect(remote.commits.get(remote.headSha ?? "")?.authored).toEqual(at(5));
	});

	it("takes the newer side where both changed the same line, and merges the rest", async () => {
		const { remote, mac, phone } = await setup({ "n.md": "one\ntwo\nthree\n" });
		mac.fs.set("n.md", "ONE mac\ntwo\nTHREE\n", at(10));
		phone.fs.set("n.md", "ONE phone\ntwo\nthree\n", at(5));
		await mac.sync();
		const report = await phone.sync({ conflicts: "newest" });
		expect(report.conflicts).toEqual([]);
		expect(report.newer).toEqual([{ path: "n.md", from: "MacBook", places: 1 }]);
		expect(phone.fs.get("n.md")).toBe("ONE mac\ntwo\nTHREE\n");
		expect(phone.state.conflicts).toEqual([]);

		// the phone's version, which lost, is a second parent of the sync commit
		const head = remote.commits.get(remote.headSha ?? "");
		const kept = remote.commits.get(head?.merged ?? "");
		const sha = kept?.files.get("n.md")?.sha ?? "";
		expect(new TextDecoder().decode(remote.blobs.get(sha))).toBe("ONE phone\ntwo\nthree\n");
		expect(kept?.message).toMatch(/^iPhone: n\.md\n[\s\S]*Superseded-By: /);
		expect(phone.state.kept).toBeUndefined();
	});

	it("keeps this device's side when it is the newer one", async () => {
		const { remote, mac, phone } = await setup({ "n.md": "one\ntwo\n" });
		mac.fs.set("n.md", "ONE mac\ntwo\n", at(5));
		phone.fs.set("n.md", "ONE phone\ntwo\n", at(10));
		await mac.sync();
		const report = await phone.sync({ conflicts: "newest" });
		expect(report.newer).toEqual([{ path: "n.md", from: "iPhone", places: 1 }]);
		expect(remote.snapshot()["n.md"]).toBe("ONE phone\ntwo\n");
		// nothing of this device's lost, and the Mac's version is already in the history
		expect(remote.commits.get(remote.headSha ?? "")?.merged).toBeNull();
	});

	it("judges the other side by when it was edited, not when it synced", async () => {
		const { remote, mac, phone } = await setup({ "n.md": "one\n" });
		// the Mac edited at 11:00 and synced after noon, the phone edited at 11:30
		mac.fs.set("n.md", "mac\n", new Date(2026, 9, 6, 11, 0));
		await mac.sync();
		const synced = remote.commits.get(remote.headSha ?? "")?.date ?? new Date(0);
		phone.fs.set("n.md", "phone\n", new Date(2026, 9, 6, 11, 30));
		expect(synced.getTime()).toBeGreaterThan(new Date(2026, 9, 6, 11, 30).getTime());
		await phone.sync({ conflicts: "newest" });
		expect(phone.fs.get("n.md")).toBe("phone\n");
	});

	it("takes the newer file whole when it cannot be merged, keeping the other in the history", async () => {
		const { remote, mac, phone } = await setup({ "a.png": "\u0000base" });
		mac.fs.set("a.png", new Uint8Array([0, 1]), at(10));
		phone.fs.set("a.png", new Uint8Array([0, 2]), at(5));
		await mac.sync();
		const report = await phone.sync({ conflicts: "newest" });
		expect(report.keptBoth).toEqual([]);
		expect(report.newer).toEqual([{ path: "a.png", from: "MacBook", places: 0 }]);
		expect(phone.fs.files.get("a.png")?.data).toEqual(new Uint8Array([0, 1]));
		const kept = remote.commits.get(remote.commits.get(remote.headSha ?? "")?.merged ?? "");
		expect(remote.blobs.get(kept?.files.get("a.png")?.sha ?? "")).toEqual(new Uint8Array([0, 2]));
	});

	it("still marks both versions when a side's time is unknown", async () => {
		const { remote, phone } = await setup({ "n.md": "x\n" });
		remote.lastChange = async () => null;
		remote.commitsSince = async () => [];
		await remote.pushDirect({ "n.md": "from cli\n" });
		phone.fs.set("n.md", "from phone\n");
		const report = await phone.sync({ conflicts: "newest" });
		expect(report.conflicts).toEqual([{ path: "n.md", count: 1 }]);
	});
});

describe("first sync of a vault that already has notes", () => {
	async function repoAndPhone() {
		const remote = new MemoryRemote();
		await remote.pushDirect({
			".gitignore": "ignored.md\n",
			"shared.md": "remote\n",
			"r.md": "r\n",
		});
		const phone = new Device("iPhone", remote);
		phone.fs.set("shared.md", "local\n");
		phone.fs.set("l.md", "l\n");
		phone.fs.set("ignored.md", "never\n");
		phone.fs.set(".obsidian/plugins/easy-git-sync/main.js", "plugin\n");
		return { remote, phone };
	}

	it("can make this vault a copy of GitHub's, with what it replaces in the trash", async () => {
		const { remote, phone } = await repoAndPhone();
		await phone.sync({ firstSync: "use-remote" });
		expect(phone.fs.text()).toEqual({
			".gitignore": "ignored.md\n",
			".obsidian/plugins/easy-git-sync/main.js": "plugin\n",
			"ignored.md": "never\n",
			"r.md": "r\n",
			"shared.md": "remote\n",
		});
		expect(phone.fs.trash).toEqual(["l.md"]);
		expect(new TextDecoder().decode(phone.fs.backups.get("shared.md"))).toBe("local\n");
		// the plugin's own folder is never deleted, it goes up instead
		expect(remote.snapshot()[".obsidian/plugins/easy-git-sync/main.js"]).toBe("plugin\n");
	});

	it("can make GitHub's a copy of this vault, in one commit", async () => {
		const { remote, phone } = await repoAndPhone();
		const before = remote.headSha;
		await phone.sync({ firstSync: "use-local" });
		expect(remote.snapshot()).toEqual({
			".gitignore": "ignored.md\n",
			".obsidian/plugins/easy-git-sync/main.js": "plugin\n",
			"l.md": "l\n",
			"shared.md": "local\n",
		});
		expect(remote.commits.get(remote.headSha ?? "")?.parent).toBe(before);
		expect(phone.fs.get("r.md")).toBeUndefined();
	});

	it("applies GitHub's .gitignore before it has been downloaded", async () => {
		const { remote, phone } = await repoAndPhone();
		await phone.sync();
		expect(remote.snapshot()["ignored.md"]).toBeUndefined();
	});

	it("updates an old copy of a note instead of merging it with itself", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ "n.md": "# Plan\n- one\n- two\n" });
		await remote.pushDirect({ "n.md": "# Plan\n- one\n- two (done)\n- three\n" });
		const phone = new Device("iPhone", remote);
		phone.fs.set("n.md", "# Plan\n- one\n- two\n");
		const report = await phone.sync();
		expect(report.conflicts).toEqual([]);
		expect(phone.fs.get("n.md")).toBe("# Plan\n- one\n- two (done)\n- three\n");
	});
});

describe("deletions and renames", () => {
	it("deletes on the other device a file deleted here", async () => {
		const { remote, mac, phone } = await setup({ "a.md": "a\n", "b.md": "b\n" });
		mac.fs.delete("a.md");
		await mac.sync();
		await phone.sync();
		expect(phone.fs.get("a.md")).toBeUndefined();
		expect(phone.fs.trash).toEqual(["a.md"]);
		expect(remote.snapshot()["a.md"]).toBeUndefined();
	});

	it("brings back a file deleted on one device and edited on the other", async () => {
		const { mac, phone } = await setup({ "a.md": "a\n" });
		mac.fs.delete("a.md");
		phone.fs.set("a.md", "a\nedited\n");
		await mac.sync();
		const report = await phone.sync();
		expect(report.restored).toEqual(["a.md"]);
		await mac.sync();
		expect(mac.fs.get("a.md")).toBe("a\nedited\n");
	});

	it("restores here a file deleted here but edited elsewhere", async () => {
		const { mac, phone } = await setup({ "a.md": "a\n" });
		mac.fs.set("a.md", "a\nedited\n");
		phone.fs.delete("a.md");
		await mac.sync();
		const report = await phone.sync();
		expect(report.restored).toEqual(["a.md"]);
		expect(phone.fs.get("a.md")).toBe("a\nedited\n");
	});

	it("moves an edit to the new name when the other device renamed the note", async () => {
		const { remote, mac, phone } = await setup({ "old.md": "text\n" });
		mac.fs.delete("old.md");
		mac.fs.set("new.md", "text\n");
		phone.fs.set("old.md", "text\nmore\n");
		await mac.sync();
		await phone.sync();
		await mac.sync();
		expect(content(remote.snapshot())).toEqual({ "new.md": "text\nmore\n" });
		expect(content(phone.fs.text())).toEqual({ "new.md": "text\nmore\n" });
		expect(content(mac.fs.text())).toEqual({ "new.md": "text\nmore\n" });
	});

	it("puts the other device's edit under the new name when renamed here", async () => {
		const { remote, mac, phone } = await setup({ "old.md": "text\n" });
		mac.fs.set("old.md", "text\nmore\n");
		phone.fs.delete("old.md");
		phone.fs.set("new.md", "text\n");
		await mac.sync();
		await phone.sync();
		await mac.sync();
		expect(content(remote.snapshot())).toEqual({ "new.md": "text\nmore\n" });
		expect(content(mac.fs.text())).toEqual({ "new.md": "text\nmore\n" });
	});

	it("merges an edit into a note the other device renamed and edited", async () => {
		const note = "# Plan\n\nmonday\ntuesday\nwednesday\nthursday\n";
		const { remote, mac, phone } = await setup({ "Plan.md": note });
		// the Mac changes the heading, and filename-from-content renames the note to match
		mac.fs.delete("Plan.md");
		mac.fs.set("Week plan.md", "# Week plan\n\nmonday\ntuesday\nwednesday\nthursday\n");
		phone.fs.set("Plan.md", "# Plan\n\nmonday\ntuesday\nwednesday\nthursday\nfriday\n");
		await mac.sync();
		const report = await phone.sync();
		expect(report.merged).toEqual(["Week plan.md"]);
		await mac.sync();
		const merged = "# Week plan\n\nmonday\ntuesday\nwednesday\nthursday\nfriday\n";
		expect(content(remote.snapshot())).toEqual({ "Week plan.md": merged });
		expect(content(phone.fs.text())).toEqual({ "Week plan.md": merged });
		expect(content(mac.fs.text())).toEqual({ "Week plan.md": merged });
	});

	it("merges the other device's edit into a note renamed and edited here", async () => {
		const note = "# Plan\n\nmonday\ntuesday\nwednesday\nthursday\n";
		const { remote, mac, phone } = await setup({ "Plan.md": note });
		mac.fs.set("Plan.md", "# Plan\n\nmonday\ntuesday\nwednesday\nthursday\nfriday\n");
		phone.fs.delete("Plan.md");
		phone.fs.set("Week plan.md", "# Week plan\n\nmonday\ntuesday\nwednesday\nthursday\n");
		await mac.sync();
		await phone.sync();
		await mac.sync();
		const merged = "# Week plan\n\nmonday\ntuesday\nwednesday\nthursday\nfriday\n";
		expect(content(remote.snapshot())).toEqual({ "Week plan.md": merged });
		expect(content(mac.fs.text())).toEqual({ "Week plan.md": merged });
	});

	it("keeps an unrelated new note and the edited old one apart", async () => {
		const { remote, mac, phone } = await setup({ "Plan.md": "# Plan\none\ntwo\n" });
		mac.fs.delete("Plan.md");
		mac.fs.set("Shopping.md", "# Shopping\nmilk\neggs\nbread\n");
		phone.fs.set("Plan.md", "# Plan\none\ntwo\nthree\n");
		await mac.sync();
		await phone.sync();
		expect(Object.keys(content(remote.snapshot())).sort()).toEqual(["Plan.md", "Shopping.md"]);
	});

	it("refuses to delete most of the vault without confirmation", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 30; i++) files[`n${i}.md`] = `${i}\n`;
		const { remote, mac } = await setup(files);
		for (const path of Object.keys(files)) mac.fs.delete(path);
		await expect(mac.sync()).rejects.toBeInstanceOf(MassDeleteError);
		expect(Object.keys(content(remote.snapshot()))).toHaveLength(30);
		await mac.sync({ allowMassDelete: true });
		expect(Object.keys(content(remote.snapshot()))).toHaveLength(0);
	});
});

describe(".gitignore", () => {
	it("skips ignored paths unless they are already tracked, and never syncs .git or state", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ ".gitignore": "secret/\n*.log\n", "tracked.log": "old\n" });
		const mac = new Device("MacBook", remote);
		await mac.sync();
		mac.fs.set("secret/key.md", "k\n");
		mac.fs.set("x.log", "x\n");
		mac.fs.set("tracked.log", "new\n");
		mac.fs.set(".git/HEAD", "ref\n");
		mac.fs.set(".obsidian/plugins/easy-git-sync/state.json", "{}\n");
		mac.fs.set(".trash/old.md", "t\n");
		await mac.sync();
		expect(remote.snapshot()).toEqual({ ".gitignore": "secret/\n*.log\n", "tracked.log": "new\n" });
	});

	it("matches a folder whose letter case differs to the tracked one", async () => {
		const remote = new MemoryRemote();
		await remote.pushDirect({ "Notes/a.md": "a\n" });
		const mac = new Device("MacBook", remote);
		mac.fs.set("notes/a.md", "a\n");
		await mac.sync();
		expect(remote.snapshot()).toEqual({ "Notes/a.md": "a\n" });
		expect(mac.fs.text()).toEqual({ "notes/a.md": "a\n" });
	});
});

describe("races", () => {
	it("starts over when another device pushes mid-sync, without merging twice", async () => {
		const { remote, mac, phone } = await setup({ "n.md": "a\nb\nc\nd\ne\n" });
		phone.fs.set("n.md", "A\nb\nc\nd\ne\n");
		mac.fs.set("n.md", "a\nb\nC\nd\ne\n");
		await mac.sync();
		// the Mac pushes again while the phone uploads
		remote.beforeCommit = async () => {
			mac.fs.set("n.md", "a\nb\nC\nd\nE\n");
			await mac.sync();
		};
		await phone.sync();
		expect(remote.snapshot()["n.md"]).toBe("A\nb\nC\nd\nE\n");
		expect(phone.fs.get("n.md")).toBe("A\nb\nC\nd\nE\n");
	});

	it("never overwrites a note edited while the sync was running", async () => {
		const { remote, mac, phone } = await setup({ "n.md": "a\nb\nc\n" });
		mac.fs.set("n.md", "A\nb\nc\n");
		await mac.sync();
		phone.fs.beforeWrite.set("n.md", () => phone.fs.set("n.md", "a\nb\nC typed\n"));
		const report = await phone.sync();
		expect(report.deferred).toEqual(["n.md"]);
		expect(phone.fs.get("n.md")).toBe("a\nb\nC typed\n");
		await phone.sync();
		expect(phone.fs.get("n.md")).toBe("A\nb\nC typed\n");
		expect(remote.snapshot()["n.md"]).toBe("A\nb\nC typed\n");
	});
});
