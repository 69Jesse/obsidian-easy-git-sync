const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(date: Date, pattern = "YYYY-MM-DD HH:mm:ss"): string {
	const tokens: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		MM: pad(date.getMonth() + 1),
		DD: pad(date.getDate()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
		ss: pad(date.getSeconds()),
	};
	return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => tokens[token] ?? token);
}

const SUMMARY_LENGTH = 72;
const BODY_FILES = 200;

const DEVICE_TRAILER = "Synced-From";
const SUPERSEDED_TRAILER = "Superseded-By";

export function commitMessage(values: {
	device: string;
	files: string[];
	deleted?: ReadonlySet<string>;
	superseded?: boolean;
}): string {
	const deleted = values.deleted ?? new Set<string>();
	const device = oneLine(values.device);
	const summary = summarize(values.files, deleted);
	const parts = [`${device}: ${summary}`];
	let trailer = `${DEVICE_TRAILER}: ${device}`;
	if (values.superseded) {
		parts.push(
			"This device's version, before a newer one from another device replaced the places where the two clashed. Kept here so it stays in the history.",
		);
		trailer += `\n${SUPERSEDED_TRAILER}: newer version`;
	}
	if (values.files.length > 0 && summary !== listed(values.files, deleted)) {
		parts.push(fileList(values.files, deleted));
	}
	parts.push(trailer);
	return parts.join("\n\n");
}

export function isSuperseded(message: string): boolean {
	return new RegExp(`^${SUPERSEDED_TRAILER}: `, "m").test(message);
}

function fileList(files: string[], deleted: ReadonlySet<string>): string {
	const lines = files
		.slice(0, BODY_FILES)
		.map((p) => (deleted.has(p) ? `- deleted ${p}` : `- ${p}`));
	if (files.length > BODY_FILES) lines.push(`- and ${files.length - BODY_FILES} more`);
	return lines.join("\n");
}

function listed(files: string[], deleted: ReadonlySet<string>): string {
	return files.map((p) => (deleted.has(p) ? `deleted ${p}` : p)).join(", ");
}

export function summarize(files: string[], deleted: ReadonlySet<string>): string {
	if (files.length === 0) return "no changes";
	if (files.length === 1) return listed(files, deleted);
	if (files.length <= 3) {
		const list = listed(files, deleted);
		if (list.length <= SUMMARY_LENGTH) return list;
	}
	const folders = [
		...new Set(
			files.map((p) => (p.includes("/") ? `${p.slice(0, p.indexOf("/"))}/` : "top level")),
		),
	];
	const shown =
		folders.slice(0, 3).join(", ") + (folders.length > 3 ? `, ${folders.length - 3} more` : "");
	const verb = files.every((p) => deleted.has(p)) ? "deleted " : "";
	return `${verb}${files.length} files (${shown})`;
}

export function deviceFromMessage(message: string): string | null {
	const match = new RegExp(`^${DEVICE_TRAILER}: (.+)$`, "m").exec(message);
	return match?.[1]?.trim() || null;
}

function oneLine(text: string): string {
	return text.replace(/[\r\n]+/g, " ").trim() || "unknown device";
}

export function sideLabel(device: string, date: Date | null): string {
	return date ? `${device}, ${formatDate(date, "YYYY-MM-DD HH:mm")}` : device;
}

export function conflictCopyPath(
	path: string,
	device: string,
	date: Date,
	exists: (p: string) => boolean,
): string {
	const slash = path.lastIndexOf("/");
	const dir = path.slice(0, slash + 1);
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	// characters Windows or Android refuse in a file name
	const who = device.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "other device";
	const tag = `conflict ${who} ${formatDate(date, "YYYY-MM-DD HHmm")}`;
	let candidate = `${dir}${stem} (${tag})${ext}`;
	for (let n = 2; exists(candidate); n++) candidate = `${dir}${stem} (${tag} ${n})${ext}`;
	return candidate;
}
