import { concatBytes, encodeUtf8 } from "../../lib/bytes";
import { deflate, inflate } from "../../lib/inflate";
import { fromHex, type GitObject, hashObject, type ObjectType, sha1, toHex } from "./objects";

const TYPES: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OFS_DELTA = 6;
const REF_DELTA = 7;

interface Entry {
	offset: number;
	type: number;
	data: Uint8Array;
	baseOffset?: number;
	baseSha?: string;
}

export class PackError extends Error {}

// `known` supplies delta bases a thin pack leaves out
export async function readPack(
	pack: Uint8Array,
	known: (sha: string) => GitObject | undefined = () => undefined,
): Promise<Map<string, GitObject>> {
	if (pack.length < 12 || new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK")
		throw new PackError("not a pack");
	const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) throw new PackError(`pack version ${version}`);
	const count = view.getUint32(8);

	const entries: Entry[] = [];
	let pos = 12;
	for (let i = 0; i < count; i++) {
		const offset = pos;
		let byte = pack[pos++] ?? 0;
		const type = (byte >> 4) & 7;
		let size = byte & 15;
		let shift = 4;
		while (byte & 0x80) {
			byte = pack[pos++] ?? 0;
			size += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		}
		const entry: Entry = { offset, type, data: new Uint8Array(0) };
		if (type === OFS_DELTA) {
			byte = pack[pos++] ?? 0;
			let distance = byte & 0x7f;
			while (byte & 0x80) {
				byte = pack[pos++] ?? 0;
				distance = (distance + 1) * 128 + (byte & 0x7f);
			}
			entry.baseOffset = offset - distance;
		} else if (type === REF_DELTA) {
			entry.baseSha = toHex(pack.subarray(pos, pos + 20));
			pos += 20;
		} else if (!TYPES[type]) {
			throw new PackError(`unknown object type ${type}`);
		}
		const inflated = inflate(pack, pos, size);
		entry.data = inflated.data;
		pos = inflated.end;
		entries.push(entry);
	}

	const objects = new Map<string, GitObject>();
	const byOffset = new Map<number, GitObject>();
	let pending: Entry[] = [];
	for (const entry of entries) {
		const type = TYPES[entry.type];
		if (!type) {
			pending.push(entry);
			continue;
		}
		const object = { type, data: entry.data };
		objects.set(await hashObject(object), object);
		byOffset.set(entry.offset, object);
	}
	// a delta's base can itself be a delta, so resolve in rounds until nothing is left
	while (pending.length > 0) {
		const waiting: Entry[] = [];
		for (const entry of pending) {
			const base =
				entry.baseOffset !== undefined
					? byOffset.get(entry.baseOffset)
					: (objects.get(entry.baseSha ?? "") ?? known(entry.baseSha ?? ""));
			if (!base) {
				waiting.push(entry);
				continue;
			}
			const object = { type: base.type, data: applyDelta(base.data, entry.data) };
			objects.set(await hashObject(object), object);
			byOffset.set(entry.offset, object);
		}
		if (waiting.length === pending.length) throw new PackError("a delta's base is missing");
		pending = waiting;
	}
	return objects;
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
	let pos = 0;
	const varint = () => {
		let value = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = delta[pos++] ?? 0;
			value += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		return value;
	};
	if (varint() !== base.length) throw new PackError("delta does not fit its base");
	const out = new Uint8Array(varint());
	let length = 0;
	while (pos < delta.length) {
		const op = delta[pos++] ?? 0;
		if (op & 0x80) {
			let offset = 0;
			let size = 0;
			for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += (delta[pos++] ?? 0) * 2 ** (8 * i);
			for (let i = 0; i < 3; i++) if (op & (16 << i)) size += (delta[pos++] ?? 0) * 2 ** (8 * i);
			if (size === 0) size = 0x10000;
			if (offset + size > base.length || length + size > out.length)
				throw new PackError("delta copies out of range");
			out.set(base.subarray(offset, offset + size), length);
			length += size;
		} else if (op > 0) {
			if (length + op > out.length || pos + op > delta.length)
				throw new PackError("delta inserts out of range");
			out.set(delta.subarray(pos, pos + op), length);
			length += op;
			pos += op;
		} else {
			throw new PackError("delta opcode 0");
		}
	}
	if (length !== out.length) throw new PackError("delta is short");
	return out;
}

export async function writePack(objects: readonly GitObject[]): Promise<Uint8Array> {
	const header = new Uint8Array(12);
	header.set(encodeUtf8("PACK"));
	const view = new DataView(header.buffer);
	view.setUint32(4, 2);
	view.setUint32(8, objects.length);
	const parts: Uint8Array[] = [header];
	for (const object of objects) {
		let size = object.data.length;
		const bytes: number[] = [];
		let byte = (NUMBERS[object.type] << 4) | (size & 15);
		size = Math.floor(size / 16);
		while (size > 0) {
			bytes.push(byte | 0x80);
			byte = size & 0x7f;
			size = Math.floor(size / 128);
		}
		bytes.push(byte);
		parts.push(new Uint8Array(bytes), await deflate(object.data));
	}
	const body = concatBytes(parts);
	return concatBytes([body, fromHex(await sha1(body))]);
}
