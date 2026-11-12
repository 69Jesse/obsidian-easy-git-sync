import { concatBytes, toArrayBuffer } from "../../lib/bytes";
import {
	basicAuth,
	type Http,
	type HttpResponse,
	lowerCaseHeaders,
	OfflineError,
	RemoteError,
} from "../http";
import type { GitObject } from "./objects";
import { readPack } from "./pack";
import { DELIM, FLUSH, PktReader, pkt, pktLines } from "./pkt";

export interface GitAuth {
	username: string;
	password: string;
}

export interface Refs {
	heads: Map<string, string>;
	// the branch HEAD points at, which is the default branch on a hosted repository
	head: string | null;
}

export interface FetchRequest {
	wants: string[];
	haves?: string[];
	depth?: number;
	blobless?: boolean;
}

export type PushResult = { ok: true } | { ok: false; reason: string };

const AGENT = "agent=easy-git-sync";
const decoder = new TextDecoder();

interface Advertisement {
	version: 0 | 2;
	caps: Set<string>;
	refs: Map<string, string>;
	symrefHead: string | null;
}

// git's smart HTTP protocol, enough to list branches, fetch what changed and push a commit
export class GitHttp {
	private protocol: 0 | 2 | null = null;
	private caps = new Set<string>();

	constructor(
		private readonly http: Http,
		readonly url: string,
		private readonly auth: () => GitAuth | null,
		readonly name: string,
		private readonly sleep: (ms: number) => Promise<void>,
	) {}

	// a server needs filter support to send folders without their files
	get blobless(): boolean {
		return this.caps.has("filter");
	}

	// protocol v2 takes any object as a want; v0 only when the server allows it
	get anyWant(): boolean {
		return (
			this.protocol === 2 ||
			this.caps.has("allow-reachable-sha1-in-want") ||
			this.caps.has("allow-any-sha1-in-want")
		);
	}

	get shallow(): boolean {
		return this.caps.has("shallow");
	}

	private async request(
		method: string,
		path: string,
		body?: Uint8Array,
		service?: string,
		v2 = true,
	): Promise<HttpResponse> {
		const auth = this.auth();
		const headers: Record<string, string> = {
			Accept: service ? `application/x-${service}-result` : "*/*",
			"Cache-Control": "no-cache",
			"User-Agent": "git/2.47.0 (easy-git-sync)",
			...(v2 ? { "Git-Protocol": "version=2" } : {}),
			...(auth ? { Authorization: basicAuth(auth.username, auth.password) } : {}),
			...(service && body ? { "Content-Type": `application/x-${service}-request` } : {}),
		};
		for (let attempt = 0; ; attempt++) {
			let response: HttpResponse;
			try {
				response = await this.http({
					url: `${this.url}/${path}`,
					method,
					headers,
					...(body ? { body: toArrayBuffer(body) } : {}),
				});
			} catch (error) {
				throw new OfflineError(error, this.name);
			}
			response = { ...response, headers: lowerCaseHeaders(response.headers) };
			const { status } = response;
			if (status < 400) return response;
			const wait = retryDelay(response, attempt);
			if (wait !== null && attempt < 3) {
				await this.sleep(wait);
				continue;
			}
			throw this.error(response);
		}
	}

	private error(response: HttpResponse): RemoteError {
		const { status } = response;
		const said = decoder.decode(response.body).trim().split("\n")[0]?.slice(0, 200) ?? "";
		if (status === 401)
			return new RemoteError(status, `${this.name} did not accept the login.`, "auth");
		if (status === 403)
			return new RemoteError(
				status,
				said || `${this.name} refused access to the repository.`,
				"forbidden",
			);
		if (status === 404)
			return new RemoteError(status, `The repository was not found on ${this.name}.`, "not-found");
		if (status === 429)
			return new RemoteError(status, `${this.name}'s rate limit was reached.`, "rate-limit");
		return new RemoteError(status, said || `${this.name} answered ${status}.`, "other");
	}

	private async advertise(service: "git-upload-pack" | "git-receive-pack"): Promise<Advertisement> {
		const response = await this.request(
			"GET",
			`info/refs?service=${service}`,
			undefined,
			undefined,
			service === "git-upload-pack",
		);
		const type = response.headers["content-type"] ?? "";
		if (!type.includes(`application/x-${service}-advertisement`))
			throw new RemoteError(
				response.status,
				`${this.url} is not a git repository served over HTTPS.`,
				"not-found",
			);
		const reader = new PktReader(new Uint8Array(response.body));
		let first = reader.line();
		if (first?.startsWith("# service=")) {
			reader.next();
			first = reader.line();
		}
		if (first === "version 2") {
			const caps = new Set<string>();
			for (const line of reader.lines()) {
				const [key, value] = line.split("=", 2) as [string, string | undefined];
				if (key === "fetch") for (const feature of value?.split(" ") ?? []) caps.add(feature);
				else caps.add(key);
			}
			return { version: 2, caps, refs: new Map(), symrefHead: null };
		}
		const refs = new Map<string, string>();
		const caps = new Set<string>();
		let symrefHead: string | null = null;
		for (let line = first; line !== null; line = reader.line()) {
			const nul = line.indexOf("\0");
			if (nul >= 0) {
				for (const cap of line.slice(nul + 1).split(" ")) {
					if (cap.startsWith("symref=HEAD:")) symrefHead = cap.slice("symref=HEAD:".length);
					caps.add(cap.split("=")[0] ?? cap);
				}
				line = line.slice(0, nul);
			}
			const [sha, name] = line.split(" ");
			if (sha && name && !name.endsWith("^{}") && name !== "capabilities^{}") refs.set(name, sha);
		}
		return { version: 0, caps, refs, symrefHead };
	}

	private async discover(): Promise<Advertisement> {
		const ad = await this.advertise("git-upload-pack");
		this.protocol = ad.version;
		this.caps = ad.caps;
		return ad;
	}

	async refs(): Promise<Refs> {
		let ad: Advertisement | null = null;
		// v0 lists refs in its advertisement, so only v2 can skip it once known
		if (this.protocol !== 2) ad = await this.discover();
		if (this.protocol === 0 && ad) return toRefs(ad.refs, ad.symrefHead);

		const body = concatBytes([
			pkt("command=ls-refs\n"),
			pkt(`${AGENT}\n`),
			DELIM,
			pktLines(["symrefs", "ref-prefix HEAD", "ref-prefix refs/heads/"]),
			FLUSH,
		]);
		const response = await this.request("POST", "git-upload-pack", body, "git-upload-pack");
		const refs = new Map<string, string>();
		let symrefHead: string | null = null;
		for (const line of new PktReader(new Uint8Array(response.body)).lines()) {
			const [sha, name, ...attributes] = line.split(" ");
			if (!sha || !name) continue;
			refs.set(name, sha);
			for (const attribute of attributes) {
				if (name === "HEAD" && attribute.startsWith("symref-target:"))
					symrefHead = attribute.slice("symref-target:".length);
			}
		}
		return toRefs(refs, symrefHead);
	}

	async fetch(
		request: FetchRequest,
		known?: (sha: string) => GitObject | undefined,
	): Promise<Map<string, GitObject>> {
		if (this.protocol === null) await this.discover();
		const depth = request.depth !== undefined && this.shallow ? request.depth : undefined;
		const blobless = request.blobless === true && this.blobless;
		const haves = request.haves ?? [];
		let pack: Uint8Array;

		if (this.protocol === 2) {
			const args = [
				"no-progress",
				"ofs-delta",
				...request.wants.map((sha) => `want ${sha}`),
				...(depth !== undefined ? [`deepen ${depth}`] : []),
				...(blobless ? ["filter blob:none"] : []),
				...haves.map((sha) => `have ${sha}`),
				"done",
			];
			const body = concatBytes([
				pkt("command=fetch\n"),
				pkt(`${AGENT}\n`),
				DELIM,
				pktLines(args),
				FLUSH,
			]);
			const response = await this.request("POST", "git-upload-pack", body, "git-upload-pack");
			const reader = new PktReader(new Uint8Array(response.body));
			pack = new Uint8Array(0);
			for (let section = reader.line(); section !== null; section = reader.line()) {
				if (section === "packfile") {
					pack = reader.sideBand();
					break;
				}
				// acknowledgments, shallow-info, wanted-refs: read up to the delimiter
				reader.lines();
			}
		} else {
			const caps = ["side-band-64k", "ofs-delta", "no-progress", "shallow", "filter"]
				.filter((cap) => this.caps.has(cap))
				.filter((cap) =>
					cap === "shallow" ? depth !== undefined : cap === "filter" ? blobless : true,
				);
			const [first, ...rest] = request.wants;
			const lines = [
				`want ${first} ${[...caps, AGENT].join(" ")}`,
				...rest.map((sha) => `want ${sha}`),
				...(depth !== undefined ? [`deepen ${depth}`] : []),
				...(blobless ? ["filter blob:none"] : []),
			];
			const body = concatBytes([
				pktLines(lines),
				FLUSH,
				pktLines([...haves.map((sha) => `have ${sha}`), "done"]),
			]);
			const response = await this.request(
				"POST",
				"git-upload-pack",
				body,
				"git-upload-pack",
				false,
			);
			const reader = new PktReader(new Uint8Array(response.body));
			// shallow lines up to a flush when deepening, then an ACK or NAK
			if (depth !== undefined) reader.lines();
			for (let line = reader.line(); line !== null; line = reader.line()) {
				if (line === "NAK" || (line.startsWith("ACK ") && !/ (continue|common|ready)$/.test(line)))
					break;
			}
			pack = this.caps.has("side-band-64k")
				? reader.sideBand()
				: new Uint8Array(response.body).subarray(reader.pos);
		}
		if (pack.length === 0) return new Map();
		return readPack(pack, known);
	}

	// write access shows in the receive-pack advertisement: a read-only login is refused there
	async canPush(): Promise<boolean> {
		try {
			await this.advertise("git-receive-pack");
			return true;
		} catch (error) {
			if (error instanceof RemoteError && (error.kind === "forbidden" || error.kind === "auth"))
				return false;
			throw error;
		}
	}

	async push(ref: string, from: string, to: string, pack: Uint8Array): Promise<PushResult> {
		const ad = await this.advertise("git-receive-pack");
		const caps = ["report-status", "side-band-64k"].filter((cap) => ad.caps.has(cap));
		const body = concatBytes([
			pkt(`${from} ${to} ${ref}\0${[...caps, AGENT].join(" ")}`),
			FLUSH,
			pack,
		]);
		const response = await this.request(
			"POST",
			"git-receive-pack",
			body,
			"git-receive-pack",
			false,
		);
		let reader = new PktReader(new Uint8Array(response.body));
		if (ad.caps.has("side-band-64k")) reader = new PktReader(reader.sideBand());
		if (!ad.caps.has("report-status")) return { ok: true };
		let reason: string | null = null;
		for (const line of reader.lines()) {
			if (line.startsWith("unpack ") && line !== "unpack ok") reason = line.slice(7);
			if (line.startsWith(`ng ${ref} `)) reason = line.slice(ref.length + 4);
		}
		return reason === null ? { ok: true } : { ok: false, reason };
	}
}

function toRefs(all: Map<string, string>, symrefHead: string | null): Refs {
	const heads = new Map<string, string>();
	for (const [name, sha] of all) {
		if (name.startsWith("refs/heads/")) heads.set(name.slice("refs/heads/".length), sha);
	}
	const head = symrefHead?.startsWith("refs/heads/")
		? symrefHead.slice("refs/heads/".length)
		: null;
	return { heads, head };
}

function retryDelay(response: HttpResponse, attempt: number): number | null {
	const { status, headers } = response;
	if (status >= 500) return 1000 * 2 ** attempt;
	if (status !== 429) return null;
	const retryAfter = Number(headers["retry-after"]);
	if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 60) return retryAfter * 1000;
	return null;
}
