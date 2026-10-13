import { concatBytes, encodeUtf8, toArrayBuffer } from "./bytes";

export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
	const header = encodeUtf8(`blob ${bytes.length}\0`);
	const digest = await crypto.subtle.digest("SHA-1", toArrayBuffer(concatBytes([header, bytes])));
	return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}
