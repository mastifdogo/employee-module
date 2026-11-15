// Small client for the timesheet.io REST API (https://api.timesheet.io/v1),
// written from the official SDK (github.com/timesheetIO/timesheet-typescript).
// Auth is an API key from my.timesheet.io → Development → API keys.

const BASE = (process.env.TIMESHEET_API_URL || "https://api.timesheet.io").replace(/\/+$/, "");
const KEY_FORMAT = /^ts_[A-Za-z0-9]+\.[A-Za-z0-9]+$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // 10,000 time entries per sync

export class TimesheetError extends Error {
	/** @param {number} status @param {string} message */
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** @param {unknown} key */
export function checkKey(key) {
	if (typeof key !== "string" || key.trim() === "") throw new TimesheetError(409, "Enter the timesheet.io API key under Settings → Employees → timesheet.io.");
	if (!KEY_FORMAT.test(key.trim())) throw new TimesheetError(409, "The timesheet.io API key under Settings → Employees → timesheet.io doesn't look right: it should be like ts_xxxx.yyyy.");
	return key.trim();
}

/** @param {string} key @param {string} path @param {any} [body] @param {string} [method] */
async function call(key, path, body, method = body === undefined ? "GET" : "POST") {
	let res;
	try {
		res = await fetch(`${BASE}${path}`, {
			method,
			headers: { Authorization: `ApiKey ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
	} catch (e) {
		throw new TimesheetError(502, `Could not reach timesheet.io (${e?.name === "TimeoutError" ? "timed out" : (e?.cause?.code ?? e?.message ?? "network error")}).`);
	}
	if (res.status === 401 || res.status === 403) throw new TimesheetError(409, "timesheet.io refused the API key. Check it under Settings → Employees → timesheet.io.");
	if (res.status === 404) throw new TimesheetError(404, `timesheet.io has no ${path}.`);
	if (res.status === 429) throw new TimesheetError(503, "timesheet.io is rate-limiting requests. Try again in a minute.");
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		let message = "";
		try {
			const j = JSON.parse(detail);
			message = typeof j?.message === "string" ? j.message : typeof j?.error === "string" ? j.error : "";
		} catch {}
		throw new TimesheetError(res.status >= 500 ? 502 : 422, `timesheet.io answered ${res.status} for ${method} ${path}${message ? `: ${message.slice(0, 300)}` : "."}`);
	}
	const raw = await res.text();
	if (raw.trim() === "") return null;
	try {
		return JSON.parse(raw);
	} catch {
		throw new TimesheetError(502, `timesheet.io sent an answer that isn't JSON for ${path}.`);
	}
}

/** Who the key belongs to: { email, displayName, ... } */
export function profile(key) {
	return call(key, "/v1/profiles/me");
}

/** Creates a task: { projectId, userId, startDateTime, endDateTime, description, billable, billed, paid } → the task. */
export async function createTask(key, fields) {
	const task = await call(key, "/v1/tasks", { typeId: 0, ...fields });
	if (!task || typeof task.id !== "string") throw new TimesheetError(502, "timesheet.io didn't say which task it created.");
	return task;
}

/** Changes the fields given (a partial update) → the task. 404 when timesheet.io has no such task. */
export async function updateTask(key, id, fields) {
	const task = await call(key, `/v1/tasks/${encodeURIComponent(id)}`, fields, "PUT");
	return task && typeof task === "object" ? task : { id };
}

/** Deletes a task; one that is already gone counts as deleted. */
export async function deleteTask(key, id) {
	try {
		await call(key, `/v1/tasks/${encodeURIComponent(id)}`, undefined, "DELETE");
	} catch (e) {
		if (!(e instanceof TimesheetError && e.status === 404)) throw e;
	}
}

// ---- times: timesheet.io wants "2026-11-12T09:00:00+02:00" (an offset, no Z, no milliseconds)
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** A timesheet.io time as "YYYY-MM-DDTHH:MM:SS±HH:MM", or null. */
export function normalStamp(v) {
	const m = typeof v === "string" ? STAMP.exec(v) : null;
	return m ? `${m[1]}T${m[2]}${m[3] === "Z" ? "+00:00" : m[3]}` : null;
}

const offsetMinutes = (stamp) => {
	const o = stamp.slice(19);
	return (o[0] === "-" ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6)));
};

/** The same offset, `seconds` later. */
export function addSeconds(stamp, seconds) {
	const off = offsetMinutes(stamp);
	const local = new Date(Date.parse(stamp) + seconds * 1000 + off * 60_000).toISOString().slice(0, 19);
	return `${local}${stamp.slice(19)}`;
}

/** "±HH:MM" of a time zone (e.g. "America/Toronto") on a day; throws on an unknown zone. */
export function zoneOffset(timeZone, date) {
	const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
	const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
	return m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "+00:00";
}

/** Seconds between two timesheet.io times. */
export const spanSeconds = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / 1000);

/**
 * Every work task (not mileage or calls) starting on or after startDate (YYYY-MM-DD).
 * → { tasks, complete }; complete is false if the page cap was reached.
 */
export async function tasksSince(key, startDate) {
	const tasks = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const r = await call(key, "/v1/tasks/search", { startDate, type: "task", sort: "dateTime", order: "desc", page, limit: PAGE_SIZE });
		const items = Array.isArray(r?.items) ? r.items : [];
		tasks.push(...items);
		const limit = Number(r?.params?.limit) || PAGE_SIZE;
		const count = Number(r?.params?.count);
		if (items.length === 0 || (Number.isFinite(count) ? page * limit >= count : items.length < limit)) return { tasks, complete: true };
	}
	return { tasks, complete: false };
}

/**
 * What Ledger keeps of a timesheet.io task, or null for one it can't use
 * (still running, no end, zero length).
 */
export function readTask(task) {
	if (!task || typeof task.id !== "string" || task.running || typeof task.startDateTime !== "string" || typeof task.endDateTime !== "string") return null;
	const start = Date.parse(task.startDateTime);
	const end = Date.parse(task.endDateTime);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !/^\d{4}-\d{2}-\d{2}/.test(task.startDateTime)) return null;
	const span = (end - start) / 1000;
	// Breaks are in seconds; tolerate milliseconds.
	let breaks = Number(task.durationBreak) || 0;
	if (breaks > span) breaks /= 1000;
	if (breaks < 0 || breaks > span) breaks = 0;
	const minutes = Math.round((span - breaks) / 60);
	if (minutes < 1 || minutes > 100000) return null;
	const member = task.member && typeof task.member === "object" ? task.member : {};
	const userId = typeof task.user === "string" && task.user ? task.user : typeof member.uid === "string" ? member.uid : "";
	if (!userId) return null;
	const project = task.project && typeof task.project === "object" && typeof task.project.id === "string" ? task.project : null;
	const rate = project ? Math.round(parseFloat(project.salary) * 100) : NaN;
	const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
	const startStamp = normalStamp(task.startDateTime);
	const endStamp = normalStamp(task.endDateTime);
	return {
		id: task.id.slice(0, 200),
		start: startStamp,
		end: endStamp,
		break_seconds: Math.round(breaks),
		deleted: task.deleted === true,
		work_date: task.startDateTime.slice(0, 10), // the day in the tracker's own time zone
		minutes,
		description: text(task.description, 2000),
		billable: task.billable === true,
		last_update_ms: Number.isFinite(Number(task.lastUpdate)) ? Math.trunc(Number(task.lastUpdate)) : null,
		user: {
			id: userId.slice(0, 200),
			email: text(member.email, 200).toLowerCase(),
			name: text(member.displayName, 200) || text(`${member.firstname ?? ""} ${member.lastname ?? ""}`, 200) || text(member.email, 200),
			number: text(member.employeeId, 100),
		},
		project: project && {
			id: project.id.slice(0, 200),
			name: text(project.title, 200) || "Untitled project",
			client: text(project.employer, 200),
			rate_cents: Number.isFinite(rate) && rate > 0 && rate < 1e9 ? rate : null,
		},
	};
}
