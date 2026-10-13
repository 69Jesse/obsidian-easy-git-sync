const encoder = new TextEncoder();

// decode then encode must give back the same bytes, or an uploaded blob would not hash to the file
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function encodeUtf8(text: string): Uint8Array {
	return encoder.encode(text);
}

// git's own binary test: a NUL in the first 8000 bytes
const BINARY_PROBE = 8000;

export function decodeText(bytes: Uint8Array): string | null {
	if (bytes.subarray(0, BINARY_PROBE).includes(0)) return null;
	try {
		return strictDecoder.decode(bytes);
	} catch {
		return null;
	}
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// chunked, or a large attachment exceeds the argument limit of fromCharCode
export function toBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
	const binary = atob(base64.replace(/\s/g, ""));
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	if (
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength &&
		bytes.buffer instanceof ArrayBuffer
	) {
		return bytes.buffer;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}
