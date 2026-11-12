// a zlib stream inside a pack has no length, so the decoder must say where it ended,
// which DecompressionStream cannot

const LENGTH_BASE = [
	3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
	163, 195, 227, 258,
];
const LENGTH_EXTRA = [
	0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
	1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
	3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
	0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
	// indexed by the next `bits` input bits; each entry is symbol << 4 | code length
	table: Uint16Array;
	bits: number;
}

function huffman(lengths: ArrayLike<number>): Huffman {
	let bits = 1;
	for (let i = 0; i < lengths.length; i++) bits = Math.max(bits, lengths[i] ?? 0);
	const counts = new Uint16Array(16);
	for (let i = 0; i < lengths.length; i++) counts[lengths[i] ?? 0]++;
	counts[0] = 0;
	const next = new Uint16Array(16);
	let code = 0;
	for (let len = 1; len <= 15; len++) {
		code = (code + (counts[len - 1] ?? 0)) << 1;
		next[len] = code;
	}
	const table = new Uint16Array(1 << bits);
	for (let symbol = 0; symbol < lengths.length; symbol++) {
		const len = lengths[symbol] ?? 0;
		if (len === 0) continue;
		const assigned = next[len] ?? 0;
		next[len] = assigned + 1;
		// codes are packed most significant bit first, the input is read least significant first
		let reversed = 0;
		for (let i = 0; i < len; i++) reversed |= ((assigned >> i) & 1) << (len - 1 - i);
		for (let i = reversed; i < table.length; i += 1 << len) table[i] = (symbol << 4) | len;
	}
	return { table, bits };
}

let fixedLiterals: Huffman | null = null;
let fixedDistances: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
	if (!fixedLiterals || !fixedDistances) {
		const lengths = new Uint8Array(288);
		lengths.fill(8, 0, 144);
		lengths.fill(9, 144, 256);
		lengths.fill(7, 256, 280);
		lengths.fill(8, 280, 288);
		fixedLiterals = huffman(lengths);
		fixedDistances = huffman(new Uint8Array(30).fill(5));
	}
	return [fixedLiterals, fixedDistances];
}

export class InflateError extends Error {}

// inflates the zlib stream at `start`; `end` is just past its checksum
export function inflate(
	input: Uint8Array,
	start = 0,
	size?: number,
): { data: Uint8Array; end: number } {
	let pos = start;
	let bitBuffer = 0;
	let bitCount = 0;

	const cmf = input[pos++] ?? 0;
	const flg = input[pos++] ?? 0;
	if ((cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20)
		throw new InflateError("not a zlib stream");

	// reading past the end feeds zeros, which only ever fill a lookahead that is given back
	const need = (n: number) => {
		while (bitCount < n) {
			if (pos >= input.length + 4) throw new InflateError("truncated stream");
			bitBuffer |= (input[pos++] ?? 0) << bitCount;
			bitCount += 8;
		}
	};
	const take = (n: number): number => {
		need(n);
		const value = bitBuffer & ((1 << n) - 1);
		bitBuffer >>>= n;
		bitCount -= n;
		return value;
	};
	const decode = (h: Huffman): number => {
		need(h.bits);
		const entry = h.table[bitBuffer & ((1 << h.bits) - 1)] ?? 0;
		const len = entry & 15;
		if (len === 0) throw new InflateError("invalid code");
		bitBuffer >>>= len;
		bitCount -= len;
		return entry >> 4;
	};

	let out = new Uint8Array(size ?? Math.max(1024, (input.length - start) * 4));
	let length = 0;
	const room = (n: number) => {
		if (length + n <= out.length) return;
		const grown = new Uint8Array(Math.max(out.length * 2, length + n));
		grown.set(out.subarray(0, length));
		out = grown;
	};

	let last = 0;
	while (!last) {
		last = take(1);
		const type = take(2);
		if (type === 0) {
			// give back whole bytes of lookahead, then read the stored block byte by byte
			pos -= bitCount >> 3;
			bitBuffer = 0;
			bitCount = 0;
			const len = (input[pos] ?? 0) | ((input[pos + 1] ?? 0) << 8);
			const nlen = (input[pos + 2] ?? 0) | ((input[pos + 3] ?? 0) << 8);
			if ((len ^ 0xffff) !== nlen) throw new InflateError("invalid stored block");
			pos += 4;
			if (pos + len > input.length) throw new InflateError("truncated stream");
			room(len);
			out.set(input.subarray(pos, pos + len), length);
			length += len;
			pos += len;
			continue;
		}
		let literals: Huffman;
		let distances: Huffman;
		if (type === 1) {
			[literals, distances] = fixedTables();
		} else if (type === 2) {
			const hlit = take(5) + 257;
			const hdist = take(5) + 1;
			const hclen = take(4) + 4;
			const codeLengths = new Uint8Array(19);
			for (let i = 0; i < hclen; i++) codeLengths[CODE_LENGTH_ORDER[i] ?? 0] = take(3);
			const lengthCode = huffman(codeLengths);
			const lengths = new Uint8Array(hlit + hdist);
			for (let i = 0; i < lengths.length; ) {
				const symbol = decode(lengthCode);
				if (symbol < 16) {
					lengths[i++] = symbol;
					continue;
				}
				let repeat: number;
				let value = 0;
				if (symbol === 16) {
					if (i === 0) throw new InflateError("repeat with nothing before it");
					value = lengths[i - 1] ?? 0;
					repeat = 3 + take(2);
				} else if (symbol === 17) {
					repeat = 3 + take(3);
				} else {
					repeat = 11 + take(7);
				}
				if (i + repeat > lengths.length) throw new InflateError("too many code lengths");
				lengths.fill(value, i, i + repeat);
				i += repeat;
			}
			literals = huffman(lengths.subarray(0, hlit));
			distances = huffman(lengths.subarray(hlit));
		} else {
			throw new InflateError("invalid block type");
		}

		for (;;) {
			const symbol = decode(literals);
			if (symbol < 256) {
				room(1);
				out[length++] = symbol;
				continue;
			}
			if (symbol === 256) break;
			const index = symbol - 257;
			if (index >= 29) throw new InflateError("invalid length");
			const len = (LENGTH_BASE[index] ?? 0) + take(LENGTH_EXTRA[index] ?? 0);
			const code = decode(distances);
			if (code >= 30) throw new InflateError("invalid distance");
			const distance = (DISTANCE_BASE[code] ?? 0) + take(DISTANCE_EXTRA[code] ?? 0);
			if (distance > length) throw new InflateError("distance too far back");
			room(len);
			for (let i = 0; i < len; i++) {
				out[length] = out[length - distance] ?? 0;
				length++;
			}
		}
	}

	// the checksum starts at the next whole byte
	pos -= bitCount >> 3;
	const end = pos + 4;
	if (end > input.length) throw new InflateError("truncated stream");
	if (size !== undefined && length !== size) throw new InflateError("unexpected size");
	return { data: length === out.length ? out : out.subarray(0, length), end };
}

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
