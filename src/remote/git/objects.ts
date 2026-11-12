import { concatBytes, encodeUtf8, toArrayBuffer } from "../../lib/bytes";

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export interface GitObject {
	type: ObjectType;
	data: Uint8Array;
}

export const ZERO_SHA = "0".repeat(40);
export const TREE_MODE = "40000";

const decoder = new TextDecoder();

export async function sha1(bytes: Uint8Array): Promise<string> {
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-1", toArrayBuffer(bytes))));
}

export async function hashObject(object: GitObject): Promise<string> {
	return sha1(concatBytes([encodeUtf8(`${object.type} ${object.data.length}\0`), object.data]));
}

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

export interface TreeEntry {
	mode: string;
	name: string;
	sha: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
	const entries: TreeEntry[] = [];
	let pos = 0;
	while (pos < data.length) {
		const space = data.indexOf(0x20, pos);
		const nul = data.indexOf(0, space);
		if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error("corrupt tree object");
		entries.push({
			mode: decoder.decode(data.subarray(pos, space)),
			name: decoder.decode(data.subarray(space + 1, nul)),
			sha: toHex(data.subarray(nul + 1, nul + 21)),
		});
		pos = nul + 21;
	}
	return entries;
}

// git orders by bytes, comparing a folder as if its name ended in "/"
function sortKey(entry: TreeEntry): Uint8Array {
	return encodeUtf8(entry.mode === TREE_MODE ? `${entry.name}/` : entry.name);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return a.length - b.length;
}

export function writeTree(entries: readonly TreeEntry[]): Uint8Array {
	const sorted = entries
		.map((entry) => ({ entry, key: sortKey(entry) }))
		.sort((a, b) => compareBytes(a.key, b.key));
	return concatBytes(
		sorted.flatMap(({ entry }) => [
			encodeUtf8(`${entry.mode} ${entry.name}\0`),
			fromHex(entry.sha),
		]),
	);
}

export interface Signature {
	name: string;
	email: string;
	// seconds since the epoch, and the offset as git writes it, such as +0200
	time: number;
	offset: string;
}

export interface Commit {
	tree: string;
	parents: string[];
	author: Signature;
	committer: Signature;
	message: string;
}

export function signature(name: string, email: string, date: Date): Signature {
	const minutes = -date.getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	const abs = Math.abs(minutes);
	const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
	// names and addresses cannot hold the characters that delimit them
	const clean = (s: string) => s.replace(/[<>\n]/g, "").trim();
	return {
		name: clean(name),
		email: clean(email),
		time: Math.floor(date.getTime() / 1000),
		offset,
	};
}

export function signatureDate(sig: Signature): Date {
	return new Date(sig.time * 1000);
}

function parseSignature(text: string): Signature {
	const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(text);
	if (!match) return { name: text, email: "", time: 0, offset: "+0000" };
	return {
		name: match[1] ?? "",
		email: match[2] ?? "",
		time: Number(match[3]),
		offset: match[4] ?? "+0000",
	};
}

function formatSignature(sig: Signature): string {
	return `${sig.name} <${sig.email}> ${sig.time} ${sig.offset}`;
}

export function parseCommit(data: Uint8Array): Commit {
	const text = decoder.decode(data);
	const split = text.indexOf("\n\n");
	const head = split < 0 ? text : text.slice(0, split);
	const message = split < 0 ? "" : text.slice(split + 2);
	const commit: Commit = {
		tree: "",
		parents: [],
		author: parseSignature(""),
		committer: parseSignature(""),
		message,
	};
	for (const line of head.split("\n")) {
		// continuation lines of a multi-line header, such as a signature
		if (line.startsWith(" ")) continue;
		const space = line.indexOf(" ");
		const key = line.slice(0, space);
		const value = line.slice(space + 1);
		if (key === "tree") commit.tree = value;
		else if (key === "parent") commit.parents.push(value);
		else if (key === "author") commit.author = parseSignature(value);
		else if (key === "committer") commit.committer = parseSignature(value);
	}
	return commit;
}

export function writeCommit(commit: Commit): Uint8Array {
	const lines = [
		`tree ${commit.tree}`,
		...commit.parents.map((parent) => `parent ${parent}`),
		`author ${formatSignature(commit.author)}`,
		`committer ${formatSignature(commit.committer)}`,
	];
	const message = commit.message.endsWith("\n") ? commit.message : `${commit.message}\n`;
	return encodeUtf8(`${lines.join("\n")}\n\n${message}`);
}
