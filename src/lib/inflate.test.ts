import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { concatBytes, encodeUtf8 } from "./bytes";
import { deflate, inflate } from "./inflate";

function random(length: number, seed: number): Uint8Array {
	const out = new Uint8Array(length);
	let x = seed;
	for (let i = 0; i < length; i++) {
		x = (x * 1103515245 + 12345) >>> 0;
		out[i] = x >>> 24;
	}
	return out;
}

const text = encodeUtf8(
	Array.from({ length: 400 }, (_, i) => `- line ${i % 37} of a note about ${i % 5}\n`).join(""),
);

describe("inflate", () => {
	for (const level of [0, 1, 6, 9]) {
		it(`reads what zlib writes at level ${level}`, () => {
			for (const input of [text, random(70_000, level + 1), new Uint8Array(0)]) {
				const packed = deflateSync(input, { level });
				const { data, end } = inflate(packed, 0, input.length);
				expect(Buffer.from(data).equals(Buffer.from(input))).toBe(true);
				expect(end).toBe(packed.length);
			}
		});
	}

	it("says where each of several back-to-back streams ends", () => {
		const parts = [text, random(5000, 7), encodeUtf8("tree"), text.subarray(0, 10)];
		const packed = parts.map((p) => deflateSync(p));
		const all = concatBytes([encodeUtf8("PACK"), ...packed, new Uint8Array(20)]);
		let offset = 4;
		for (const [i, part] of parts.entries()) {
			const { data, end } = inflate(all, offset);
			expect(Buffer.from(data).equals(Buffer.from(part))).toBe(true);
			offset = end;
			expect(offset).toBe(4 + packed.slice(0, i + 1).reduce((n, p) => n + p.length, 0));
		}
	});

	it("rejects a wrong size and a truncated stream", () => {
		const packed = deflateSync(text);
		expect(() => inflate(packed, 0, text.length + 1)).toThrow();
		expect(() => inflate(packed.subarray(0, packed.length - 6))).toThrow();
	});

	it("round-trips its own deflate", async () => {
		const input = random(20_000, 3);
		const { data } = inflate(await deflate(input));
		expect(Buffer.from(data).equals(Buffer.from(input))).toBe(true);
	});
});
