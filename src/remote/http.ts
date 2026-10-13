export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	body: ArrayBuffer;
}

export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export class OfflineError extends Error {
	constructor(cause: unknown) {
		super(`Could not reach GitHub: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
}

export function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
	return out;
}
