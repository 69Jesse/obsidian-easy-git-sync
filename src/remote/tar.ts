const BLOCK = 512;
const decoder = new TextDecoder();

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	// some HTTP stacks hand the archive back already decompressed
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// returns views into bytes, not copies: a copy of every file next to the archive is what
// runs a phone out of memory
export function untar(
	bytes: Uint8Array,
	stripFirst = true,
	keep: (path: string) => boolean = () => true,
): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>();
	let offset = 0;
	let longName: string | null = null;
	while (offset + BLOCK <= bytes.length) {
		const header = bytes.subarray(offset, offset + BLOCK);
		if (header.every((b) => b === 0)) break;
		const size = parseOctal(header.subarray(124, 136));
		const type = String.fromCharCode(header[156] ?? 0);
		const dataStart = offset + BLOCK;
		const data = bytes.subarray(dataStart, dataStart + size);
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "x") {
			longName = paxPath(data) ?? longName;
			continue;
		}
		if (type === "L") {
			longName = cString(data);
			continue;
		}
		if (type === "g") continue;
		let name = longName ?? fullName(header);
		longName = null;
		if (type !== "0" && type !== "\0") continue;
		if (stripFirst) {
			const slash = name.indexOf("/");
			if (slash === -1) continue;
			name = name.slice(slash + 1);
		}
		if (name !== "" && keep(name)) files.set(name, data);
	}
	return files;
}

function fullName(header: Uint8Array): string {
	const name = cString(header.subarray(0, 100));
	const magic = cString(header.subarray(257, 263));
	const prefix = magic.startsWith("ustar") ? cString(header.subarray(345, 500)) : "";
	return prefix ? `${prefix}/${name}` : name;
}

function cString(bytes: Uint8Array): string {
	const end = bytes.indexOf(0);
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function parseOctal(bytes: Uint8Array): number {
	const text = cString(bytes).trim();
	return text === "" ? 0 : Number.parseInt(text, 8);
}

// the length in a pax record counts bytes, so walk bytes or a non-ASCII path throws it off
function paxPath(data: Uint8Array): string | null {
	let path: string | null = null;
	let at = 0;
	while (at < data.length) {
		const space = data.indexOf(0x20, at);
		if (space === -1) break;
		const length = Number.parseInt(decoder.decode(data.subarray(at, space)), 10);
		if (!Number.isFinite(length) || length <= 0) break;
		const record = decoder.decode(data.subarray(space + 1, at + length - 1));
		if (record.startsWith("path=")) path = record.slice(5);
		at += length;
	}
	return path;
}
