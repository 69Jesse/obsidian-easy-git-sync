import { diffComm } from "node-diff3";

export function similarity(a: string, b: string): number {
	const left = a.split("\n");
	const right = b.split("\n");
	let common = 0;
	for (const part of diffComm(left, right)) {
		if (part.common) common += part.common.length;
	}
	return common / Math.max(left.length, right.length, 1);
}

export const RENAME_SIMILARITY = 0.5;
