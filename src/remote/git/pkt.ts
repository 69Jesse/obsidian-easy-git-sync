import { concatBytes, encodeUtf8 } from "../../lib/bytes";

export const FLUSH = encodeUtf8("0000");
export const DELIM = encodeUtf8("0001");

const decoder = new TextDecoder();

export function pkt(line: string | Uint8Array): Uint8Array {
	const data = typeof line === "string" ? encodeUtf8(line) : line;
	return concatBytes([encodeUtf8((data.length + 4).toString(16).padStart(4, "0")), data]);
}

export function pktLines(lines: readonly string[]): Uint8Array {
	return concatBytes(lines.map((line) => pkt(`${line}\n`)));
}

export type Packet =
	| { kind: "data"; data: Uint8Array }
	| { kind: "flush" }
	| { kind: "delim" }
	| { kind: "end-response" };

export class PktReader {
	constructor(
		private readonly bytes: Uint8Array,
		public pos = 0,
	) {}

	done(): boolean {
		return this.pos >= this.bytes.length;
	}

	next(): Packet | null {
		if (this.pos + 4 > this.bytes.length) return null;
		const length = Number.parseInt(decoder.decode(this.bytes.subarray(this.pos, this.pos + 4)), 16);
		if (Number.isNaN(length)) throw new Error("malformed response from the git server");
		this.pos += 4;
		if (length === 0) return { kind: "flush" };
		if (length === 1) return { kind: "delim" };
		if (length === 2) return { kind: "end-response" };
		if (length < 4 || this.pos + length - 4 > this.bytes.length)
			throw new Error("truncated response from the git server");
		const data = this.bytes.subarray(this.pos, this.pos + length - 4);
		this.pos += length - 4;
		return { kind: "data", data };
	}

	// a text line without its newline, or null at a flush or delimiter
	line(): string | null {
		const packet = this.next();
		if (!packet || packet.kind !== "data") return null;
		const text = decoder.decode(packet.data);
		return text.endsWith("\n") ? text.slice(0, -1) : text;
	}

	lines(): string[] {
		const out: string[] = [];
		for (let line = this.line(); line !== null; line = this.line()) out.push(line);
		return out;
	}

	// band 1 is the payload, 2 progress, 3 a fatal error; read up to the flush
	sideBand(): Uint8Array {
		const parts: Uint8Array[] = [];
		for (;;) {
			const packet = this.next();
			if (!packet || packet.kind !== "data") break;
			const band = packet.data[0];
			const payload = packet.data.subarray(1);
			if (band === 1) parts.push(payload);
			else if (band === 3) throw new Error(`the git server reported: ${decoder.decode(payload).trim()}`);
		}
		return concatBytes(parts);
	}
}
