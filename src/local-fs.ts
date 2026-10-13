import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { type App, MarkdownView, TFile, TFolder } from "obsidian";
import { bytesEqual, decodeText, encodeUtf8, toArrayBuffer } from "./lib/bytes";
import { gitBlobSha } from "./lib/githash";
import type { LocalFile, LocalFs } from "./sync/types";

export class ObsidianFs implements LocalFs {
	private readonly ownWrites = new Map<string, { sha: string | null; at: number }>();

	constructor(private readonly app: App) {}

	private get adapter() {
		return this.app.vault.adapter;
	}

	async listDir(dir: string): Promise<{ files: LocalFile[]; folders: string[] }> {
		const listed = await this.adapter.list(dir === "" ? "/" : dir);
		// not normalizePath: it rewrites U+202F (in macOS screenshot names) and normalizes Unicode
		const clean = (path: string) => path.replace(/^\/+/, "");
		// dot paths are not indexed, and each stat is a native round trip on a phone, so all at once
		const stats = await Promise.all(
			listed.files.map(async (raw): Promise<LocalFile | null> => {
				const path = clean(raw);
				const indexed = this.app.vault.getFileByPath(path);
				if (indexed) return { path, mtime: indexed.stat.mtime, size: indexed.stat.size };
				const stat = await this.adapter.stat(path);
				return stat?.type === "file" ? { path, mtime: stat.mtime, size: stat.size } : null;
			}),
		);
		const files = stats.filter((file): file is LocalFile => file !== null);
		return { files, folders: listed.folders.map(clean) };
	}

	async read(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.adapter.readBinary(path));
	}

	async isOwnEcho(path: string, within: number): Promise<boolean> {
		const own = this.ownWrites.get(path);
		if (!own) return false;
		this.ownWrites.delete(path);
		if (Date.now() - own.at > within) return false;
		if (!(await this.adapter.exists(path))) return own.sha === null;
		return own.sha !== null && (await gitBlobSha(await this.read(path))) === own.sha;
	}

	private remember(path: string, sha: string | null): void {
		const now = Date.now();
		for (const [p, own] of this.ownWrites) if (now - own.at > 60_000) this.ownWrites.delete(p);
		this.ownWrites.set(path, { sha, at: now });
	}

	async write(path: string, data: Uint8Array, expectedSha: string | null): Promise<boolean> {
		const view = openView(this.app, path);
		if (view) return this.writeIntoEditor(view, path, data, expectedSha);

		const current = (await this.adapter.exists(path)) ? await this.read(path) : null;
		if (!(await matches(current, expectedSha))) return false;
		if (current && bytesEqual(current, data)) return true;

		this.remember(path, await gitBlobSha(data));
		const file = this.app.vault.getFileByPath(path);
		if (file) {
			await this.app.vault.modifyBinary(file, toArrayBuffer(data));
		} else if (isDotPath(path)) {
			await this.ensureFolder(parentOf(path), true);
			await this.adapter.writeBinary(path, toArrayBuffer(data));
		} else {
			await this.ensureFolder(parentOf(path), false);
			await this.app.vault.createBinary(path, toArrayBuffer(data));
		}
		return true;
	}

	private async writeIntoEditor(
		view: MarkdownView,
		path: string,
		data: Uint8Array,
		expectedSha: string | null,
	): Promise<boolean> {
		let text = decodeText(data);
		if (text === null) return false;
		const current = view.editor.getValue();
		if (!(await matches(encodeUtf8(current), expectedSha))) {
			// the editor holds CRLF files as LF, so compare against the file on disk instead
			const disk = view.file ? await this.read(view.file.path) : null;
			const diskText = disk ? decodeText(disk) : null;
			const unedited =
				disk !== null &&
				diskText !== null &&
				diskText.replace(/\r\n/g, "\n") === current &&
				(await matches(disk, expectedSha));
			if (!unedited) return false;
			text = text.replace(/\r\n/g, "\n");
		}
		// a keystroke during the awaits above would shift every offset of the change below
		if (view.editor.getValue() !== current) return false;
		this.remember(path, await gitBlobSha(encodeUtf8(text)));
		if (view.editor.getValue() !== current) return false;
		if (current !== text) {
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (cm) {
				// not Editor.transaction, which always scrolls the selection into view, and kept out
				// of undo history so undo cannot revert what came from another device
				cm.dispatch({
					changes: minimalChange(current, text),
					annotations: Transaction.addToHistory.of(false),
				});
			} else {
				view.editor.setValue(text);
			}
		}
		await view.save();
		return true;
	}

	async remove(path: string, expectedSha: string): Promise<boolean> {
		if (!(await this.adapter.exists(path))) return true;
		if (!(await matches(await this.read(path), expectedSha))) return false;
		// typing not yet autosaved is only in the editor, while the file on disk still matches
		const view = openView(this.app, path);
		if (view) {
			const text = view.editor.getValue();
			const disk = decodeText(await this.read(path));
			if (disk === null || disk.replace(/\r\n/g, "\n") !== text) return false;
		}
		this.remember(path, null);
		const file = this.app.vault.getFileByPath(path);
		if (file) {
			await this.app.fileManager.trashFile(file);
		} else if (!(await this.adapter.trashSystem(path))) {
			await this.adapter.trashLocal(path);
		}
		await this.removeEmptyParents(parentOf(path));
		return true;
	}

	// a copy, not a move: the file is replaced in place right after, so its tab stays open
	async backup(path: string): Promise<void> {
		if (!(await this.adapter.exists(path))) return;
		const slash = path.lastIndexOf("/");
		const dot = path.lastIndexOf(".");
		const stem = dot > slash + 1 ? path.slice(0, dot) : path;
		const ext = dot > slash + 1 ? path.slice(dot) : "";
		let target = `.trash/${path}`;
		for (let n = 2; await this.adapter.exists(target); n++) target = `.trash/${stem} ${n}${ext}`;
		await this.ensureFolder(parentOf(target), true);
		await this.adapter.writeBinary(target, toArrayBuffer(await this.read(path)));
	}

	private async removeEmptyParents(dir: string): Promise<void> {
		for (let current = dir; current !== ""; current = parentOf(current)) {
			const listed = await this.adapter.list(current);
			if (listed.files.length > 0 || listed.folders.length > 0) return;
			// not forced, so anything that appeared since the listing makes this fail
			try {
				const folder = this.app.vault.getAbstractFileByPath(current);
				if (folder instanceof TFolder) await this.app.vault.delete(folder, false);
				else await this.adapter.rmdir(current, false);
			} catch {
				return;
			}
		}
	}

	private async ensureFolder(dir: string, dot: boolean): Promise<void> {
		if (dir === "" || (await this.adapter.exists(dir))) return;
		await this.ensureFolder(parentOf(dir), dot);
		if (dot) await this.adapter.mkdir(dir);
		else await this.app.vault.createFolder(dir);
	}
}

async function matches(current: Uint8Array | null, expectedSha: string | null): Promise<boolean> {
	if (current === null) return expectedSha === null;
	return expectedSha !== null && (await gitBlobSha(current)) === expectedSha;
}

function openView(app: App, path: string): MarkdownView | null {
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (view instanceof MarkdownView && view.file instanceof TFile && view.file.path === path)
			return view;
	}
	return null;
}

export function minimalChange(
	from: string,
	to: string,
): { from: number; to: number; insert: string } {
	let start = 0;
	const max = Math.min(from.length, to.length);
	while (start < max && from[start] === to[start]) start++;
	let end = 0;
	while (end < max - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
	return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

function isDotPath(path: string): boolean {
	return path.split("/").some((part) => part.startsWith("."));
}
