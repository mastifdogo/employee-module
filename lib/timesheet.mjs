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
	if (typeof key !== "string" || key.trim() === "") throw new TimesheetError(409, "Enter the timesheet.io API key under Settings → Employees.");
	if (!KEY_FORMAT.test(key.trim())) throw new TimesheetError(409, "The timesheet.io API key under Settings → Employees doesn't look right: it should be like ts_xxxx.yyyy.");
	return key.trim();
}

/** @param {string} key @param {string} path @param {any} [body] */
async function call(key, path, body) {
	let res;
	try {
		res = await fetch(`${BASE}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `ApiKey ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(20_000),
		});
	} catch (e) {
		throw new TimesheetError(502, `Could not reach timesheet.io (${e?.name === "TimeoutError" ? "timed out" : (e?.cause?.code ?? e?.message ?? "network error")}).`);
	}
	if (res.status === 401 || res.status === 403) throw new TimesheetError(409, "timesheet.io refused the API key. Check it under Settings → Employees.");
	if (res.status === 429) throw new TimesheetError(503, "timesheet.io is rate-limiting requests. Try again in a minute.");
	if (!res.ok) throw new TimesheetError(502, `timesheet.io answered ${res.status} for ${path}.`);
	try {
		return await res.json();
	} catch {
		throw new TimesheetError(502, `timesheet.io sent an answer that isn't JSON for ${path}.`);
	}
}

/** Who the key belongs to: { email, displayName, ... } */
export function profile(key) {
	return call(key, "/v1/profiles/me");
}

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
	return {
		id: task.id.slice(0, 200),
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
