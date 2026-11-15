// Employees: time entries, billable hours and payroll, with time pulled from timesheet.io.
// Ledger loads this file at startup and calls register(ctx).
import { TimesheetError, addSeconds, checkKey, createTask, deleteTask, profile, readTask, spanSeconds, tasksSince, updateTask, zoneOffset } from "./lib/timesheet.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,15}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_CENTS = 100_000_000_00;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const hours = (minutes) => (Number(minutes) / 60).toFixed(2);

/** @param {any} ctx */
export default async function register(ctx) {
	const S = ctx.schema;
	const q = (sql, params) => ctx.db.query(sql, params);
	const bad = (message) => new ctx.HttpError(422, message);

	// ---- input checks -----------------------------------------------------
	const isDate = (v) => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
	const reqDate = (v, name) => {
		if (!isDate(v)) throw bad(`${name} must be a date (YYYY-MM-DD)`);
		return v;
	};
	const text = (v, name, max, required = false) => {
		if (v === undefined || v === null) v = "";
		if (typeof v !== "string") throw bad(`${name} must be text`);
		v = v.trim();
		if (v.length > max) throw bad(`${name} must be at most ${max} characters`);
		if (required && v === "") throw bad(`${name} is required`);
		return v;
	};
	const cents = (v, name) => {
		if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
		if (!Number.isInteger(v) || v < 0 || v > MAX_CENTS) throw bad(`${name} must be a whole number of cents, 0 or more`);
		return v;
	};
	const percent = (v, name) => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw bad(`${name} must be a number from 0 to 100`);
		return Math.round(v * 100) / 100;
	};
	const bool = (v, name) => {
		if (typeof v !== "boolean") throw bad(`${name} must be true or false`);
		return v;
	};
	const idOf = (v, name) => {
		if (typeof v === "number" && Number.isInteger(v) && v > 0) v = String(v);
		if (typeof v !== "string" || !ID.test(v)) throw bad(`${name} must be an id`);
		return v;
	};
	const paramId = (req, what) => {
		if (!ID.test(req.params.id)) throw new ctx.HttpError(404, `no such ${what}`);
		return req.params.id;
	};
	const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});
	const account = (v, name) => {
		if (typeof v !== "string" || !CODE.test(v.trim())) throw bad(`Choose the ${name}.`);
		return v.trim();
	};
	/** The account to post to: what the request chose, else the setting. A first choice is remembered. */
	async function pickAccounts(b, settings, wanted) {
		const out = {};
		const remember = {};
		for (const [key, name] of Object.entries(wanted)) {
			out[key] = account(b[key] ?? settings[key], name);
			if (!settings[key]) remember[key] = out[key];
		}
		if (Object.keys(remember).length) await ctx.settings.set(remember).catch((e) => ctx.log.warn("could not remember accounts", { error: String(e?.message ?? e) }));
		return out;
	}
	const currencyOf = (settings) => (settings.currency === "USD" ? "USD" : "CAD");

	// ---- employees --------------------------------------------------------
	const EMP = `id, name, email, employee_number, pay_type, pay_rate_cents, bill_rate_cents, withholding_percent::float8 AS withholding_percent,
		employer_cost_percent::float8 AS employer_cost_percent, timesheet_user_id, is_active, notes, created_at, updated_at`;

	function employeeFields(b, partial) {
		const f = {};
		if (!partial || b.name !== undefined) f.name = text(b.name, "name", 200, true);
		if (b.email !== undefined) f.email = text(b.email, "email", 200);
		if (b.employee_number !== undefined) f.employee_number = text(b.employee_number, "employee number", 100);
		if (b.pay_type !== undefined) {
			if (b.pay_type !== "hourly" && b.pay_type !== "salary") throw bad("pay type must be hourly or salary");
			f.pay_type = b.pay_type;
		}
		if (b.pay_rate_cents !== undefined) f.pay_rate_cents = cents(b.pay_rate_cents, "pay rate");
		if (b.bill_rate_cents !== undefined) f.bill_rate_cents = cents(b.bill_rate_cents, "billing rate");
		if (b.withholding_percent !== undefined) f.withholding_percent = percent(b.withholding_percent, "withholding %");
		if (b.employer_cost_percent !== undefined) f.employer_cost_percent = percent(b.employer_cost_percent, "employer cost %");
		if (b.is_active !== undefined) f.is_active = bool(b.is_active, "active");
		if (b.notes !== undefined) f.notes = text(b.notes, "notes", 2000);
		return f;
	}
	const nameTaken = (e) => (e?.code === "23505" ? new ctx.HttpError(409, "An employee with that name already exists.") : e);

	ctx.route("GET", "/employees", async () => {
		const { rows } = await q(`SELECT ${EMP} FROM ${S}.employees ORDER BY is_active DESC, lower(name)`);
		return { data: rows };
	});

	ctx.route("POST", "/employees", async (req) => {
		const f = employeeFields(body(req), false);
		const keys = Object.keys(f);
		try {
			const { rows } = await q(
				`INSERT INTO ${S}.employees (${keys.join(", ")}, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}) RETURNING ${EMP}`,
				[...keys.map((k) => f[k]), req.user.username],
			);
			return ctx.response(201, rows[0]);
		} catch (e) {
			throw nameTaken(e);
		}
	});

	ctx.route("PATCH", "/employees/:id", async (req) => {
		const id = paramId(req, "employee");
		const f = employeeFields(body(req), true);
		const keys = Object.keys(f);
		if (keys.length === 0) throw bad("nothing to change");
		try {
			const { rows } = await q(`UPDATE ${S}.employees SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 RETURNING ${EMP}`, [
				id,
				...keys.map((k) => f[k]),
			]);
			if (rows.length === 0) throw new ctx.HttpError(404, "no such employee");
			await refreshTodos();
			return rows[0];
		} catch (e) {
			throw nameTaken(e);
		}
	});

	// ---- customers (Ledger's shared entity list) and projects ----------------
	async function customerNames() {
		const list = await ctx.entities.list({ role: "customer", includeInactive: true });
		return new Map(list.map((c) => [String(c.id), c]));
	}
	async function customer(id) {
		try {
			return await ctx.entities.get(Number(id));
		} catch {
			throw bad("That customer isn't in Ledger's entity list any more. Choose another.");
		}
	}

	ctx.route("GET", "/customers", async () => {
		const list = await ctx.entities.list({ role: "customer" });
		return { data: list.map((c) => ({ id: c.id, name: c.name })) };
	});

	ctx.route("POST", "/customers", async (req) => {
		const name = text(body(req).name, "customer name", 200, true);
		const c = await ctx.entities.ensure(name, "customer");
		return ctx.response(201, { id: c.id, name: c.name });
	});

	const PROJ = `id, name, customer_entity_id, bill_rate_cents, timesheet_project_id, timesheet_client_name, is_active, created_at`;

	async function projectFields(b, partial) {
		const f = {};
		if (!partial || b.name !== undefined) f.name = text(b.name, "name", 200, true);
		if (b.customer_entity_id !== undefined) f.customer_entity_id = b.customer_entity_id === null ? null : (await customer(idOf(b.customer_entity_id, "customer"))).id;
		if (b.bill_rate_cents !== undefined) f.bill_rate_cents = b.bill_rate_cents === null ? null : cents(b.bill_rate_cents, "billing rate");
		if (b.is_active !== undefined) f.is_active = bool(b.is_active, "active");
		return f;
	}

	ctx.route("GET", "/projects", async () => {
		const [{ rows }, names] = await Promise.all([q(`SELECT ${PROJ} FROM ${S}.projects ORDER BY is_active DESC, lower(name), id`), customerNames()]);
		// A customer id that a restore left pointing nowhere shows as no customer.
		return { data: rows.map((p) => ({ ...p, customer_name: names.get(String(p.customer_entity_id))?.name ?? null })) };
	});

	ctx.route("POST", "/projects", async (req) => {
		const f = await projectFields(body(req), false);
		const keys = Object.keys(f);
		const { rows } = await q(
			`INSERT INTO ${S}.projects (${keys.join(", ")}, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}) RETURNING ${PROJ}`,
			[...keys.map((k) => f[k]), req.user.username],
		);
		return ctx.response(201, rows[0]);
	});

	ctx.route("PATCH", "/projects/:id", async (req) => {
		const id = paramId(req, "project");
		const f = await projectFields(body(req), true);
		const keys = Object.keys(f);
		if (keys.length === 0) throw bad("nothing to change");
		const { rows } = await q(`UPDATE ${S}.projects SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING ${PROJ}`, [id, ...keys.map((k) => f[k])]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such project");
		await refreshTodos();
		return rows[0];
	});

	// ---- time entries -------------------------------------------------------
	// What an hour of this entry is charged at: its own rate, else the project's, else the employee's.
	const RATE = `COALESCE(t.bill_rate_cents, p.bill_rate_cents, e.bill_rate_cents, 0)`;
	const TIME = `t.id, t.employee_id, e.name AS employee_name, t.project_id, p.name AS project_name, p.customer_entity_id, t.work_date, t.minutes,
		t.description, t.billable, t.bill_rate_cents, t.source, t.billing_id, t.pay_run_id, t.push_status, t.push_error, t.timesheet_task_id IS NOT NULL AS in_timesheet, t.billing_journal_entry_id,
		COALESCE(t.billed_rate_cents, ${RATE}) AS rate_cents,
		COALESCE(t.billed_amount_cents, round(t.minutes * ${RATE} / 60.0)::bigint) AS amount_cents
		FROM ${S}.time_entries t JOIN ${S}.employees e ON e.id = t.employee_id LEFT JOIN ${S}.projects p ON p.id = t.project_id`;

	ctx.route("GET", "/time", async (req) => {
		const where = [];
		const params = [];
		const add = (sql, v) => {
			params.push(v);
			where.push(sql.replace("?", `$${params.length}`));
		};
		const g = (k) => req.query.get(k);
		if (g("from")) add("t.work_date >= ?", reqDate(g("from"), "from"));
		if (g("to")) add("t.work_date <= ?", reqDate(g("to"), "to"));
		if (g("employee_id")) add("t.employee_id = ?", idOf(g("employee_id"), "employee"));
		if (g("show") === "billable") where.push("t.billable AND t.billing_id IS NULL");
		if (g("show") === "unpaid") where.push("t.pay_run_id IS NULL");
		if (g("show") === "billed") where.push("t.billing_id IS NOT NULL");
		const { rows } = await q(`SELECT ${TIME} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.work_date DESC, t.id DESC LIMIT 1000`, params);
		return { data: rows };
	});

	// Hours per day and employee, for the calendar.
	ctx.route("GET", "/calendar", async (req) => {
		const from = req.query.get("from") ? reqDate(req.query.get("from"), "from") : daysAgo(31);
		const to = req.query.get("to") ? reqDate(req.query.get("to"), "to") : today();
		if (to < from || Date.parse(to) - Date.parse(from) > 800 * 86_400_000) throw bad("choose up to 800 days, from before to");
		const params = [from, to];
		if (req.query.get("employee_id")) params.push(idOf(req.query.get("employee_id"), "employee"));
		const { rows } = await q(
			`SELECT t.work_date, t.employee_id, e.name AS employee_name, sum(t.minutes)::int AS minutes, COALESCE(sum(t.minutes) FILTER (WHERE t.billable), 0)::int AS billable_minutes
			FROM ${S}.time_entries t JOIN ${S}.employees e ON e.id = t.employee_id
			WHERE t.work_date BETWEEN $1 AND $2 ${params.length === 3 ? "AND t.employee_id = $3" : ""}
			GROUP BY t.work_date, t.employee_id, e.name ORDER BY t.work_date, sum(t.minutes) DESC, e.name`,
			params,
		);
		return { data: rows };
	});

	async function timeFields(b, partial) {
		const f = {};
		if (!partial || b.employee_id !== undefined) {
			f.employee_id = idOf(b.employee_id, "employee");
			const { rowCount } = await q(`SELECT 1 FROM ${S}.employees WHERE id = $1`, [f.employee_id]);
			if (!rowCount) throw bad("no such employee");
		}
		if (b.project_id !== undefined && b.project_id !== null && b.project_id !== "") {
			f.project_id = idOf(b.project_id, "project");
			const { rowCount } = await q(`SELECT 1 FROM ${S}.projects WHERE id = $1`, [f.project_id]);
			if (!rowCount) throw bad("no such project");
		} else if (b.project_id !== undefined) f.project_id = null;
		if (!partial || b.work_date !== undefined) f.work_date = reqDate(b.work_date, "date");
		if (!partial || b.minutes !== undefined) {
			if (!Number.isInteger(b.minutes) || b.minutes < 1 || b.minutes > 100000) throw bad("time must be between 1 minute and 100000 minutes");
			f.minutes = b.minutes;
		}
		if (b.description !== undefined) f.description = text(b.description, "description", 2000);
		if (b.billable !== undefined) f.billable = bool(b.billable, "billable");
		if (b.bill_rate_cents !== undefined) f.bill_rate_cents = b.bill_rate_cents === null ? null : cents(b.bill_rate_cents, "billing rate");
		return f;
	}

	ctx.route("POST", "/time", async (req) => {
		const f = await timeFields(body(req), false);
		const keys = Object.keys(f);
		const { rows } = await q(
			`INSERT INTO ${S}.time_entries (${keys.join(", ")}, created_by, push_status) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, 'pending') RETURNING id`,
			[...keys.map((k) => f[k]), req.user.username],
		);
		pushSoon(req);
		return ctx.response(201, { id: rows[0].id });
	});

	async function openEntry(id) {
		const { rows } = await q(`SELECT id, source, billing_id, pay_run_id, timesheet_task_id FROM ${S}.time_entries WHERE id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such time entry");
		if (rows[0].billing_id !== null) throw new ctx.HttpError(409, "This time is already billed. Reverse the billing to change it.");
		if (rows[0].pay_run_id !== null) throw new ctx.HttpError(409, "This time is on a pay run. Delete or reverse the pay run to change it.");
		return rows[0];
	}

	ctx.route("PATCH", "/time/:id", async (req) => {
		const id = paramId(req, "time entry");
		const entry = await openEntry(id);
		const f = await timeFields(body(req), true);
		const keys = Object.keys(f);
		if (keys.length === 0) throw bad("nothing to change");
		// The billing rate is Ledger's own; anything else is sent to timesheet.io (Ledger wins).
		const send = keys.some((k) => k !== "bill_rate_cents");
		const { rowCount } = await q(
			`UPDATE ${S}.time_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, ${send ? "push_status = 'pending', push_error = '', " : ""}updated_at = now()
			WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL`,
			[id, ...keys.map((k) => f[k])],
		);
		if (rowCount === 0) throw new ctx.HttpError(409, "This time entry was just billed or paid.");
		if (send) pushSoon(req);
		return { id: entry.id };
	});

	ctx.route("DELETE", "/time/:id", async (req) => {
		const id = paramId(req, "time entry");
		const entry = await openEntry(id);
		// Its task in timesheet.io is deleted too (queued, so a failed call is retried).
		const { rows: gone } = await q(
			`WITH gone AS (DELETE FROM ${S}.time_entries WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL RETURNING timesheet_task_id),
			queued AS (INSERT INTO ${S}.timesheet_deletions (task_id, requested_by) SELECT timesheet_task_id, $2 FROM gone WHERE timesheet_task_id IS NOT NULL ON CONFLICT (task_id) DO NOTHING)
			SELECT timesheet_task_id FROM gone`,
			[id, req.user.username],
		);
		if (gone.length === 0) throw new ctx.HttpError(409, "This time entry was just billed or paid.");
		if (entry.timesheet_task_id) pushSoon(req);
	});

	// ---- billings: bill customers for billable hours ---------------------------------
	// Each billed time entry posts its own journal entry: debit accounts receivable, credit the
	// billable hours account, with the customer as the entry's entity. Other modules find it by its
	// tag, a link on the entry with ref "billed" (label "Billed"), and by the customer on it.
	const BILLED_TAG = { ref: "billed", label: "Billed" };
	const BILL = `id, customer_entity_id, customer_name, period_start, period_end, billing_date, currency, total_minutes, total_cents, status, journal_entry_id, created_by, created_at, reversed_by, reversed_at`;
	const idList = (v, name) => {
		if (!Array.isArray(v) || v.length === 0) throw bad(`choose at least one ${name}`);
		if (v.length > 2000) throw bad(`choose at most 2000 ${name}s at a time`);
		return [...new Set(v.map((x) => idOf(x, name)))];
	};
	const billingHref = (id) => `/apps/employees?billing=${id}`;

	/** Frees time entries from their billing: they are billable again (and timesheet.io is told). */
	const unclaim = (ids) =>
		q(
			`UPDATE ${S}.time_entries SET billing_id = NULL, billed_rate_cents = NULL, billed_amount_cents = NULL, billing_journal_entry_id = NULL,
				push_status = 'pending', push_error = '', updated_at = now()
			WHERE id = ANY($1::bigint[])`,
			[ids],
		);

	/** A billing's totals from the time entries still on it; one with none left is reversed. */
	const retotal = (billingId, who) =>
		q(
			`UPDATE ${S}.billings b SET
				total_minutes = CASE WHEN x.n > 0 THEN x.minutes ELSE b.total_minutes END,
				total_cents = CASE WHEN x.n > 0 THEN x.cents ELSE b.total_cents END,
				status = CASE WHEN x.n = 0 THEN 'reversed' ELSE b.status END,
				reversed_by = CASE WHEN x.n = 0 THEN COALESCE(b.reversed_by, $2) ELSE b.reversed_by END,
				reversed_at = CASE WHEN x.n = 0 THEN COALESCE(b.reversed_at, now()) ELSE b.reversed_at END
			FROM (SELECT count(*)::int AS n, COALESCE(sum(minutes), 0)::int AS minutes, COALESCE(sum(billed_amount_cents), 0)::bigint AS cents
				FROM ${S}.time_entries WHERE billing_id = $1) x
			WHERE b.id = $1`,
			[billingId, who],
		);

	/** A posting the server didn't finish (it stopped half-way): keep it if its entry exists, else undo it. */
	async function settle(table, prefix, undo) {
		const { rows } = await q(`SELECT id FROM ${S}.${table} WHERE status = 'posting' AND created_at < now() - interval '2 minutes'`);
		for (const r of rows) {
			const linked = (await ctx.ledger.linkedEntries(`${prefix}:${r.id}`)).find((l) => !l.reversed);
			if (linked) await q(`UPDATE ${S}.${table} SET status = 'posted', journal_entry_id = $2 WHERE id = $1 AND status = 'posting'`, [r.id, linked.entry_id]);
			else await undo(r.id);
		}
	}

	/** A batch the server didn't finish: time entries whose journal entry exists keep it, the rest are billable again. */
	async function settleBillings() {
		const { rows } = await q(`SELECT id FROM ${S}.billings WHERE status = 'posting' AND created_at < now() - interval '2 minutes'`);
		for (const r of rows) {
			const lost = [];
			for (const t of (await q(`SELECT id FROM ${S}.time_entries WHERE billing_id = $1 AND billing_journal_entry_id IS NULL`, [r.id])).rows) {
				const linked = (await ctx.ledger.linkedEntries(`time:${t.id}`)).find((l) => !l.reversed);
				if (linked) await q(`UPDATE ${S}.time_entries SET billing_journal_entry_id = $2 WHERE id = $1`, [t.id, linked.entry_id]);
				else lost.push(t.id);
			}
			if (lost.length) await unclaim(lost);
			const { rows: left } = await q(`SELECT count(*)::int AS n FROM ${S}.time_entries WHERE billing_id = $1`, [r.id]);
			if (left[0].n === 0) await q(`DELETE FROM ${S}.billings WHERE id = $1 AND status = 'posting'`, [r.id]);
			else {
				await q(`UPDATE ${S}.billings SET status = 'posted' WHERE id = $1 AND status = 'posting'`, [r.id]);
				await retotal(r.id, "recovery");
			}
		}
	}

	/**
	 * Bills time entries: one billing per customer, one journal entry per time entry.
	 * → { billings, billed, total_cents, skipped: [{ id, reason }] }. Throws only when nothing could be billed.
	 */
	async function billEntries(ids, { billingDate, acc, currency, user }) {
		const { rows } = await q(
			`SELECT t.id, t.work_date, t.minutes, t.description, t.billable, t.billing_id, e.name AS employee_name, p.name AS project_name, p.customer_entity_id,
				${RATE} AS rate, round(t.minutes * ${RATE} / 60.0)::bigint AS amount
			FROM ${S}.time_entries t JOIN ${S}.employees e ON e.id = t.employee_id LEFT JOIN ${S}.projects p ON p.id = t.project_id
			WHERE t.id = ANY($1::bigint[]) ORDER BY t.work_date, t.id`,
			[ids],
		);
		const skipped = [];
		const found = new Set(rows.map((r) => String(r.id)));
		for (const id of ids) if (!found.has(String(id))) skipped.push({ id: Number(id), reason: "no such time entry" });
		const byCustomer = new Map();
		for (const r of rows) {
			const reason =
				r.billing_id !== null ? "already billed"
				: !r.billable ? "not billable"
				: r.customer_entity_id === null ? (r.project_name ? `the project ${r.project_name} has no customer` : "no project, so no customer")
				: r.rate <= 0n ? "no billing rate"
				: r.amount <= 0n ? "its amount rounds to 0.00"
				: null;
			if (reason) skipped.push({ id: Number(r.id), reason });
			else {
				const key = String(r.customer_entity_id);
				if (!byCustomer.has(key)) byCustomer.set(key, []);
				byCustomer.get(key).push(r);
			}
		}

		const billings = [];
		let billed = 0;
		let total = 0n;
		let failure = null;
		for (const [customerId, list] of byCustomer) {
			if (failure) {
				for (const r of list) skipped.push({ id: Number(r.id), reason: `not billed: ${failure.message}` });
				continue;
			}
			let entity;
			try {
				entity = await ctx.entities.get(Number(customerId));
			} catch {
				for (const r of list) skipped.push({ id: Number(r.id), reason: "its customer isn't in Ledger's entity list any more" });
				continue;
			}
			const dates = list.map((r) => r.work_date).sort();
			const { rows: made } = await q(
				`INSERT INTO ${S}.billings (customer_entity_id, customer_name, period_start, period_end, billing_date, currency, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				[entity.id, entity.name, dates[0], dates[dates.length - 1], billingDate, currency, user.username],
			);
			const billingId = made[0].id;
			// Claimed in one statement, so a second batch can't bill the same time twice.
			const { rows: claimed } = await q(
				`UPDATE ${S}.time_entries t
				SET billing_id = $2, billed_rate_cents = r.rate, billed_amount_cents = round(t.minutes * r.rate / 60.0)::bigint, push_status = 'pending', push_error = '', updated_at = now()
				FROM ${S}.time_entries t2
				JOIN ${S}.employees e ON e.id = t2.employee_id
				JOIN ${S}.projects p ON p.id = t2.project_id
				CROSS JOIN LATERAL (SELECT COALESCE(t2.bill_rate_cents, p.bill_rate_cents, e.bill_rate_cents, 0) AS rate) r
				WHERE t2.id = t.id AND t.id = ANY($1::bigint[]) AND p.customer_entity_id = $3 AND t.billable AND t.billing_id IS NULL AND r.rate > 0
				RETURNING t.id, t.minutes, t.billed_amount_cents AS amount`,
				[list.map((r) => r.id), billingId, entity.id],
			);
			const info = new Map(list.map((r) => [String(r.id), r]));
			for (const r of list) if (!claimed.some((c) => String(c.id) === String(r.id))) skipped.push({ id: Number(r.id), reason: "billed or changed by someone else meanwhile" });
			const posted = [];
			for (let i = 0; i < claimed.length; i++) {
				const c = claimed[i];
				const t = info.get(String(c.id));
				try {
					const entry = await ctx.ledger.createJournalEntry(
						{
							entry_date: billingDate,
							description: `Billable hours: ${entity.name} · ${t.employee_name} · ${t.work_date} (${hours(c.minutes)} h)`.slice(0, 500),
							reference: `HOURS-${c.id}`,
							entity_id: entity.id,
							lines: [
								{ account_code: acc.receivable_account, debit_cents: c.amount },
								{ account_code: acc.revenue_account, credit_cents: c.amount, memo: [t.project_name, t.description].filter(Boolean).join(": ").slice(0, 500) || undefined },
							],
							links: [
								{ ref: `time:${c.id}`, label: `Hours ${t.work_date} · ${t.employee_name} · ${hours(c.minutes)} h`.slice(0, 200), href: billingHref(billingId) },
								{ ...BILLED_TAG, href: billingHref(billingId) },
							],
						},
						user,
					);
					await q(`UPDATE ${S}.time_entries SET billing_journal_entry_id = $2 WHERE id = $1`, [c.id, entry.id]);
					posted.push(c);
				} catch (e) {
					// Stop here (the same accounts would fail again); the rest become billable again.
					failure = e;
					const rest = claimed.slice(i).map((x) => x.id);
					await unclaim(rest);
					for (const id of rest) skipped.push({ id: Number(id), reason: `not billed: ${e?.message ?? e}` });
					break;
				}
			}
			if (posted.length === 0) {
				await q(`DELETE FROM ${S}.billings WHERE id = $1`, [billingId]);
				continue;
			}
			await q(`UPDATE ${S}.billings SET status = 'posted' WHERE id = $1`, [billingId]);
			await retotal(billingId, user.username);
			billings.push((await q(`SELECT ${BILL} FROM ${S}.billings WHERE id = $1`, [billingId])).rows[0]);
			billed += posted.length;
			total += posted.reduce((a, c) => a + BigInt(c.amount), 0n);
		}
		if (billed === 0) {
			if (failure) throw failure;
			const reasons = [...new Set(skipped.map((s) => s.reason))].slice(0, 3).join("; ");
			throw bad(`Nothing to bill: ${reasons || "no time chosen"}.`);
		}
		return { billings, billed, total_cents: total, skipped };
	}

	async function billingSetup(b) {
		const settings = await ctx.settings.get();
		return {
			billingDate: b.billing_date === undefined ? today() : reqDate(b.billing_date, "billing date"),
			acc: await pickAccounts(b, settings, { receivable_account: "accounts receivable account", revenue_account: "billable hours account" }),
			currency: currencyOf(settings),
		};
	}

	ctx.route("GET", "/billings", async () => {
		await settleBillings();
		const { rows } = await q(`SELECT ${BILL} FROM ${S}.billings ORDER BY id DESC LIMIT 200`);
		return { data: rows };
	});

	ctx.route("GET", "/billings/:id", async (req) => {
		const id = paramId(req, "billing");
		const { rows } = await q(`SELECT ${BILL} FROM ${S}.billings WHERE id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such billing");
		const lines = await q(`SELECT ${TIME} WHERE t.billing_id = $1 ORDER BY t.work_date, t.id`, [id]);
		return { ...rows[0], lines: lines.rows };
	});

	// Bill one customer's unbilled billable hours in a period.
	ctx.route("POST", "/billings", async (req) => {
		const b = body(req);
		const entity = await customer(idOf(b.customer_entity_id, "customer"));
		const from = reqDate(b.period_start, "from");
		const to = reqDate(b.period_end, "to");
		if (to < from) throw bad("the period ends before it starts");
		const setup = await billingSetup(b);
		const { rows } = await q(
			`SELECT t.id FROM ${S}.time_entries t JOIN ${S}.projects p ON p.id = t.project_id
			WHERE p.customer_entity_id = $1 AND t.billable AND t.billing_id IS NULL AND t.work_date BETWEEN $2 AND $3`,
			[entity.id, from, to],
		);
		if (rows.length === 0) throw bad(`${entity.name} has no unbilled billable hours from ${from} to ${to}.`);
		const r = await billEntries(rows.map((x) => x.id), { ...setup, user: req.user });
		pushSoon(req);
		return ctx.response(201, { ...r.billings[0], skipped: r.skipped });
	});

	// Batch: bill the chosen time entries, for any number of customers.
	ctx.route("POST", "/billings/batch", async (req) => {
		const b = body(req);
		const ids = idList(b.entry_ids, "time entry");
		const r = await billEntries(ids, { ...(await billingSetup(b)), user: req.user });
		pushSoon(req);
		return ctx.response(201, r);
	});

	/** Billed time entries with their own journal entry; the others are skipped with a reason. */
	async function billedEntries(ids) {
		const { rows } = await q(
			`SELECT t.id, t.billing_id, t.billing_journal_entry_id FROM ${S}.time_entries t WHERE t.id = ANY($1::bigint[])`,
			[ids],
		);
		const skipped = [];
		const ok = [];
		const found = new Set(rows.map((r) => String(r.id)));
		for (const id of ids) if (!found.has(String(id))) skipped.push({ id: Number(id), reason: "no such time entry" });
		for (const r of rows) {
			if (r.billing_id === null) skipped.push({ id: Number(r.id), reason: "not billed" });
			else if (r.billing_journal_entry_id === null) skipped.push({ id: Number(r.id), reason: "billed before each time entry had its own transaction: reverse its whole billing instead" });
			else ok.push(r);
		}
		return { ok, skipped };
	}

	/** Reverses a record's journal entry unless it already is (or a restore left none). */
	async function reverseEntryOf(entryId, description, user) {
		if (entryId === null) return;
		let entry;
		try {
			entry = await ctx.ledger.getJournalEntry(entryId);
		} catch {
			return; // the books have no such entry (restored from elsewhere): nothing to reverse
		}
		if (entry.reversed_by_id === null) await ctx.ledger.reverseJournalEntry(entryId, { description }, user);
	}

	/** Reverses billed time entries' own journal entries and drops their Billed tag; the time is billable again. */
	async function unbill(rows, user) {
		const billingIds = new Set();
		const done = [];
		for (const r of rows) {
			if (r.billing_journal_entry_id !== null) {
				await reverseEntryOf(r.billing_journal_entry_id, `Reversal: billable hours (time entry ${r.id})`, user);
				await ctx.ledger.unlinkJournalEntry(r.billing_journal_entry_id, BILLED_TAG.ref).catch(() => false);
			}
			done.push(r.id);
			billingIds.add(String(r.billing_id));
		}
		if (done.length) await unclaim(done);
		for (const id of billingIds) await retotal(id, user.username);
		return done.length;
	}

	// Batch: unbill chosen time entries.
	ctx.route("POST", "/billed/unbill", async (req) => {
		const ids = idList(body(req).entry_ids, "time entry");
		const { ok, skipped } = await billedEntries(ids);
		if (ok.length === 0) throw bad(`Nothing to unbill: ${[...new Set(skipped.map((s) => s.reason))].slice(0, 3).join("; ")}.`);
		const unbilled = await unbill(ok, req.user);
		pushSoon(req);
		return { unbilled, skipped };
	});

	ctx.route("POST", "/billings/:id/reverse", async (req) => {
		const id = paramId(req, "billing");
		const { rows } = await q(`SELECT ${BILL} FROM ${S}.billings WHERE id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such billing");
		if (rows[0].status !== "posted") throw new ctx.HttpError(409, `This billing is ${rows[0].status}, not posted.`);
		// A billing from before 0.4.0 has one journal entry for all its time.
		await reverseEntryOf(rows[0].journal_entry_id, `Reversal: billed hours ${id} · ${rows[0].customer_name}`, req.user);
		const { rows: entries } = await q(`SELECT id, billing_id, billing_journal_entry_id FROM ${S}.time_entries WHERE billing_id = $1`, [id]);
		await unbill(entries, req.user);
		await q(`UPDATE ${S}.billings SET status = 'reversed', reversed_by = COALESCE(reversed_by, $2), reversed_at = COALESCE(reversed_at, now()) WHERE id = $1`, [id, req.user.username]);
		pushSoon(req);
		return { id: rows[0].id, status: "reversed" };
	});

	// ---- pay runs -------------------------------------------------------------
	const RUN = `r.id, r.period_start, r.period_end, r.pay_date, r.currency, r.status, r.paid_from_account, r.journal_entry_id, r.created_by, r.created_at, r.posted_by, r.posted_at, r.reversed_by, r.reversed_at`;
	const RUN_TOTALS = `(SELECT count(*)::int FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS employees,
		(SELECT COALESCE(sum(l.gross_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS gross_cents,
		(SELECT COALESCE(sum(l.deductions_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS deductions_cents,
		(SELECT COALESCE(sum(l.employer_cost_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS employer_cost_cents,
		(SELECT COALESCE(sum(l.gross_cents - l.deductions_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS net_cents`;
	const releaseRun = (id) => q(`UPDATE ${S}.time_entries SET pay_run_id = NULL, push_status = 'pending', push_error = '', updated_at = now() WHERE pay_run_id = $1`, [id]);

	async function getRun(id) {
		const { rows } = await q(`SELECT ${RUN}, ${RUN_TOTALS} FROM ${S}.pay_runs r WHERE r.id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such pay run");
		const lines = await q(
			`SELECT id, employee_id, employee_name, pay_type, minutes, rate_cents, gross_cents, deductions_cents, employer_cost_cents, gross_cents - deductions_cents AS net_cents
			FROM ${S}.pay_run_lines WHERE pay_run_id = $1 ORDER BY lower(employee_name)`,
			[id],
		);
		return { ...rows[0], lines: lines.rows };
	}

	ctx.route("GET", "/pay-runs", async () => {
		await settle("pay_runs", "payrun", (id) => q(`UPDATE ${S}.pay_runs SET status = 'draft' WHERE id = $1 AND status = 'posting'`, [id]));
		const { rows } = await q(`SELECT ${RUN}, ${RUN_TOTALS} FROM ${S}.pay_runs r ORDER BY r.id DESC LIMIT 200`);
		return { data: rows };
	});

	ctx.route("GET", "/pay-runs/:id", async (req) => getRun(paramId(req, "pay run")));

	ctx.route("POST", "/pay-runs", async (req) => {
		const b = body(req);
		const from = reqDate(b.period_start, "from");
		const to = reqDate(b.period_end, "to");
		if (to < from) throw bad("the period ends before it starts");
		const payDate = b.pay_date === undefined ? today() : reqDate(b.pay_date, "pay date");
		const currency = currencyOf(await ctx.settings.get());
		// One statement: the run, the hourly time it pays (claimed so no other run takes it) and a line per employee.
		const { rows } = await q(
			`WITH run AS (
				INSERT INTO ${S}.pay_runs (period_start, period_end, pay_date, currency, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id
			), claimed AS (
				UPDATE ${S}.time_entries t SET pay_run_id = (SELECT id FROM run), updated_at = now()
				FROM ${S}.employees e
				WHERE e.id = t.employee_id AND e.pay_type = 'hourly' AND t.pay_run_id IS NULL AND t.work_date BETWEEN $1 AND $2
				RETURNING t.employee_id, t.minutes
			), worked AS (
				SELECT employee_id, sum(minutes)::int AS minutes FROM claimed GROUP BY employee_id
			), lines AS (
				INSERT INTO ${S}.pay_run_lines (pay_run_id, employee_id, employee_name, pay_type, minutes, rate_cents, gross_cents, deductions_cents, employer_cost_cents)
				SELECT (SELECT id FROM run), e.id, e.name, e.pay_type, COALESCE(w.minutes, 0), e.pay_rate_cents, g.gross,
					round(g.gross * e.withholding_percent / 100)::bigint, round(g.gross * e.employer_cost_percent / 100)::bigint
				FROM ${S}.employees e
				LEFT JOIN worked w ON w.employee_id = e.id
				CROSS JOIN LATERAL (SELECT CASE WHEN e.pay_type = 'salary' THEN e.pay_rate_cents ELSE round(COALESCE(w.minutes, 0) * e.pay_rate_cents / 60.0)::bigint END AS gross) g
				WHERE (e.pay_type = 'salary' AND e.is_active AND e.pay_rate_cents > 0) OR w.minutes > 0
				RETURNING 1
			)
			SELECT (SELECT id FROM run) AS id, (SELECT count(*)::int FROM lines) AS lines`,
			[from, to, payDate, currency, req.user.username],
		);
		if (rows[0].lines === 0) {
			await q(`DELETE FROM ${S}.pay_runs WHERE id = $1`, [rows[0].id]);
			throw bad(`Nothing to pay from ${from} to ${to}: no unpaid hours for hourly employees and no salaried employees.`);
		}
		return ctx.response(201, await getRun(rows[0].id));
	});

	ctx.route("PATCH", "/pay-runs/:id/lines/:line", async (req) => {
		const id = paramId(req, "pay run");
		if (!ID.test(req.params.line)) throw new ctx.HttpError(404, "no such line");
		const b = body(req);
		const f = {};
		for (const [k, name] of [
			["gross_cents", "gross pay"],
			["deductions_cents", "deductions"],
			["employer_cost_cents", "employer cost"],
		])
			if (b[k] !== undefined) f[k] = cents(b[k], name);
		const keys = Object.keys(f);
		if (keys.length === 0) throw bad("nothing to change");
		try {
			const { rowCount } = await q(
				`UPDATE ${S}.pay_run_lines l SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")}
				FROM ${S}.pay_runs r WHERE l.id = $2 AND l.pay_run_id = $1 AND r.id = l.pay_run_id AND r.status = 'draft'`,
				[id, req.params.line, ...keys.map((k) => f[k])],
			);
			if (rowCount === 0) throw new ctx.HttpError(409, "Only lines of a draft pay run can be changed.");
		} catch (e) {
			if (e?.code === "23514") throw bad("Deductions can't be more than gross pay.");
			throw e;
		}
		return getRun(id);
	});

	ctx.route("DELETE", "/pay-runs/:id", async (req) => {
		const id = paramId(req, "pay run");
		// Lines go with the run and its time entries become unpaid again (foreign keys).
		const { rowCount } = await q(`DELETE FROM ${S}.pay_runs WHERE id = $1 AND status = 'draft'`, [id]);
		if (rowCount === 0) throw new ctx.HttpError(409, "Only a draft pay run can be deleted. Reverse a posted one.");
	});

	ctx.route("POST", "/pay-runs/:id/post", async (req) => {
		const id = paramId(req, "pay run");
		const b = body(req);
		const run = await getRun(id);
		if (run.status !== "draft") throw new ctx.HttpError(409, `This pay run is ${run.status}, not a draft.`);
		const settings = await ctx.settings.get();
		const paidFrom = account(b.paid_from_account, "account the pay comes from");
		const wanted = { wages_expense_account: "wages expense account" };
		const withheld = run.deductions_cents + run.employer_cost_cents;
		if (withheld > 0n) wanted.payroll_liabilities_account = "payroll liabilities account";
		if (run.employer_cost_cents > 0n) wanted.employer_cost_account = "employer payroll cost account";
		const acc = await pickAccounts(b, settings, wanted);
		if (run.gross_cents <= 0n) throw bad("This pay run has no pay on it.");

		const claim = await q(`UPDATE ${S}.pay_runs SET status = 'posting' WHERE id = $1 AND status = 'draft'`, [id]);
		if (claim.rowCount === 0) throw new ctx.HttpError(409, "Someone else is posting this pay run.");
		const lines = [{ account_code: acc.wages_expense_account, debit_cents: run.gross_cents, memo: "Gross pay" }];
		if (run.employer_cost_cents > 0n) lines.push({ account_code: acc.employer_cost_account, debit_cents: run.employer_cost_cents, memo: "Employer's share" });
		if (withheld > 0n) lines.push({ account_code: acc.payroll_liabilities_account, credit_cents: withheld, memo: "Withheld from pay and employer's share, to remit" });
		if (run.net_cents > 0n) lines.push({ account_code: paidFrom, credit_cents: run.net_cents, memo: "Net pay" });
		let entry;
		try {
			entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: run.pay_date,
					description: `Payroll ${run.period_start} to ${run.period_end} (${run.employees} ${run.employees === 1 ? "employee" : "employees"})`,
					reference: `PAYRUN-${id}`,
					lines,
					links: [{ ref: `payrun:${id}`, label: `Pay run ${id} · ${run.period_start} to ${run.period_end}`, href: `/apps/employees?payrun=${id}` }],
				},
				req.user,
			);
		} catch (e) {
			await q(`UPDATE ${S}.pay_runs SET status = 'draft' WHERE id = $1 AND status = 'posting'`, [id]);
			throw e;
		}
		await q(`UPDATE ${S}.pay_runs SET status = 'posted', journal_entry_id = $2, paid_from_account = $3, posted_by = $4, posted_at = now() WHERE id = $1`, [
			id,
			entry.id,
			paidFrom,
			req.user.username,
		]);
		// Its hours are now paid: say so in timesheet.io.
		await q(`UPDATE ${S}.time_entries SET push_status = 'pending', push_error = '', updated_at = now() WHERE pay_run_id = $1`, [id]);
		pushSoon(req);
		return getRun(id);
	});

	ctx.route("POST", "/pay-runs/:id/reverse", async (req) => {
		const id = paramId(req, "pay run");
		const run = await getRun(id);
		if (run.status !== "posted") throw new ctx.HttpError(409, `This pay run is ${run.status}, not posted.`);
		await reverseEntryOf(run.journal_entry_id, `Reversal: pay run ${id}`, req.user);
		await q(`UPDATE ${S}.pay_runs SET status = 'reversed', reversed_by = $2, reversed_at = now() WHERE id = $1`, [id, req.user.username]);
		await releaseRun(id);
		pushSoon(req);
		return getRun(id);
	});

	// ---- timesheet.io ---------------------------------------------------------
	const asHttp = (e) => (e instanceof TimesheetError ? new ctx.HttpError(e.status, e.message) : e);

	// One timesheet.io job at a time per organization (this process): a sync or a push waits for the one before it.
	const chains = new Map();
	const queuedPush = new Set();
	function serial(orgId, fn) {
		const run = (chains.get(orgId) ?? Promise.resolve()).then(fn);
		chains.set(
			orgId,
			run.catch(() => {}),
		);
		return run;
	}
	/** Sends Ledger's changes to timesheet.io after the request answers (one queued push per organization). */
	function pushSoon(req) {
		const orgId = req.user.organization?.id ?? 1;
		if (queuedPush.has(orgId)) return;
		queuedPush.add(orgId);
		serial(orgId, async () => {
			queuedPush.delete(orgId);
			const s = await ctx.settings.get();
			if (s.timesheet_api_key) await push(s);
		}).catch((e) => ctx.log.warn("sending to timesheet.io failed", { error: String(e?.message ?? e) }));
	}

	async function lastSync() {
		const { rows } = await q(`SELECT id, started_at, finished_at, started_by, succeeded, summary FROM ${S}.timesheet_syncs ORDER BY id DESC LIMIT 1`);
		return rows[0] ?? null;
	}

	/** Start and end to send: the task's own when Ledger didn't change its day or length, else rebuilt from Ledger's. */
	function timesFor(row, timeZone) {
		const breaks = row.timesheet_break_seconds ?? 0;
		if (row.timesheet_start && row.timesheet_end && row.timesheet_start.slice(0, 10) === row.work_date && Math.round((spanSeconds(row.timesheet_start, row.timesheet_end) - breaks) / 60) === row.minutes)
			return { start: row.timesheet_start, end: row.timesheet_end, breaks };
		// Keep the time of day and offset timesheet.io had; a new entry starts at 9:00 in the chosen time zone.
		const start = row.timesheet_start ? `${row.work_date}${row.timesheet_start.slice(10)}` : `${row.work_date}T09:00:00${zoneOffset(timeZone, row.work_date)}`;
		return { start, end: addSeconds(start, row.minutes * 60 + breaks), breaks };
	}

	/**
	 * Sends Ledger's changes to timesheet.io (Ledger wins): new and changed time entries, billed and
	 * paid state, and deletions. Each entry records how it went; nothing here throws for one entry.
	 */
	async function push(settings) {
		const key = checkKey(settings.timesheet_api_key);
		const timeZone = typeof settings.timesheet_time_zone === "string" && settings.timesheet_time_zone.trim() ? settings.timesheet_time_zone.trim() : "UTC";
		try {
			zoneOffset(timeZone, today());
		} catch {
			throw new TimesheetError(409, `The time zone "${timeZone}" under Settings → Employees isn't one timesheet.io times can use (try e.g. America/Toronto).`);
		}
		const n = { sent: 0, failed: 0, ledger_only: 0, deleted: 0 };

		for (const d of (await q(`SELECT task_id FROM ${S}.timesheet_deletions ORDER BY requested_at LIMIT 500`)).rows) {
			try {
				await deleteTask(key, d.task_id);
				await q(`DELETE FROM ${S}.timesheet_deletions WHERE task_id = $1`, [d.task_id]);
				n.deleted++;
			} catch (e) {
				if (e instanceof TimesheetError && e.status === 409) throw e; // the key: stop here
				await q(`UPDATE ${S}.timesheet_deletions SET last_error = $2 WHERE task_id = $1`, [d.task_id, String(e?.message ?? e).slice(0, 1000)]);
				n.failed++;
			}
		}

		const { rows } = await q(
			`SELECT t.id, t.work_date, t.minutes, t.description, t.billable, t.updated_at::text AS updated_stamp, t.timesheet_task_id, t.timesheet_task_user_id,
				t.timesheet_start, t.timesheet_end, t.timesheet_break_seconds, t.push_status,
				e.name AS employee_name, e.timesheet_user_id, p.name AS project_name, p.timesheet_project_id,
				(t.billing_id IS NOT NULL) AS billed, COALESCE(r.status = 'posted', false) AS paid
			FROM ${S}.time_entries t JOIN ${S}.employees e ON e.id = t.employee_id
			LEFT JOIN ${S}.projects p ON p.id = t.project_id LEFT JOIN ${S}.pay_runs r ON r.id = t.pay_run_id
			WHERE t.push_status IN ('pending', 'failed')
				OR (t.push_status = 'ledger_only' AND e.timesheet_user_id IS NOT NULL AND p.timesheet_project_id IS NOT NULL)
			ORDER BY t.id LIMIT 500`,
		);
		for (const row of rows) {
			const done = (status, error, extra = {}) =>
				q(
					// The task id is kept whatever happens; the entry is only "synced" if nobody changed it meanwhile.
					`UPDATE ${S}.time_entries SET timesheet_task_id = COALESCE($3, timesheet_task_id), timesheet_task_user_id = COALESCE($4, timesheet_task_user_id),
						timesheet_start = COALESCE($5, timesheet_start), timesheet_end = COALESCE($6, timesheet_end), timesheet_break_seconds = COALESCE($7, timesheet_break_seconds),
						timesheet_last_update_ms = COALESCE($8, timesheet_last_update_ms),
						push_status = CASE WHEN updated_at::text = $2 THEN $9 ELSE push_status END, push_error = CASE WHEN updated_at::text = $2 THEN $10 ELSE push_error END,
						pushed_at = CASE WHEN $9 = 'synced' THEN now() ELSE pushed_at END
					WHERE id = $1`,
					[row.id, row.updated_stamp, extra.task_id ?? null, extra.user ?? null, extra.start ?? null, extra.end ?? null, extra.breaks ?? null, extra.last_update ?? null, status, error.slice(0, 1000)],
				);
			if (!row.timesheet_project_id) {
				await done("ledger_only", row.project_name ? `The project ${row.project_name} isn't in timesheet.io, so this time stays in Ledger.` : "No project: timesheet.io needs one, so this time stays in Ledger.");
				n.ledger_only++;
				continue;
			}
			if (!row.timesheet_user_id) {
				await done("ledger_only", `${row.employee_name} isn't linked to a timesheet.io account yet (they are linked by email once they track time there), so this time stays in Ledger.`);
				n.ledger_only++;
				continue;
			}
			try {
				const t = timesFor(row, timeZone);
				const fields = { projectId: row.timesheet_project_id, description: row.description, startDateTime: t.start, endDateTime: t.end, billable: row.billable, billed: row.billed, paid: row.paid };
				let task = null;
				if (row.timesheet_task_id && row.timesheet_task_user_id && row.timesheet_task_user_id !== row.timesheet_user_id) {
					// Moved to another person: timesheet.io can't change a task's owner, so it is made again under them.
					await deleteTask(key, row.timesheet_task_id);
				} else if (row.timesheet_task_id) {
					try {
						task = await updateTask(key, row.timesheet_task_id, { ...fields, deleted: false });
					} catch (e) {
						if (!(e instanceof TimesheetError && e.status === 404)) throw e; // deleted there: made again
					}
				}
				task ??= await createTask(key, { ...fields, userId: row.timesheet_user_id });
				const last = Number(task.lastUpdate);
				await done("synced", "", { task_id: String(task.id ?? row.timesheet_task_id), user: row.timesheet_user_id, start: t.start, end: t.end, breaks: t.breaks, last_update: Number.isFinite(last) ? Math.trunc(last) : null });
				n.sent++;
			} catch (e) {
				if (e instanceof TimesheetError && e.status === 409) throw e; // the key: stop here
				await done("failed", String(e?.message ?? e));
				n.failed++;
			}
		}
		if (n.failed) await ctx.dashboard.notify({ key: "timesheet-push", title: `${n.failed} time ${n.failed === 1 ? "change" : "changes"} couldn't be sent to timesheet.io`, body: "They are tried again on the next sync. The Time tab shows why.", level: "warning", link: "/apps/employees" }).catch(() => {});
		else if (n.sent || n.deleted) await ctx.dashboard.dismiss("timesheet-push").catch(() => {});
		return n;
	}

	/**
	 * Sends Ledger's changes, pulls timesheet.io's, then sends what the pull found Ledger must win.
	 * Ledger wins: a change made in Ledger and not yet sent, and any billed or paid entry, is never
	 * overwritten by timesheet.io; Ledger's version is sent back instead.
	 */
	function sync(settings, who, orgId) {
		return serial(orgId, () => syncNow(settings, who));
	}

	async function syncNow(settings, who) {
		const key = checkKey(settings.timesheet_api_key);
		const log = await q(`INSERT INTO ${S}.timesheet_syncs (started_by) VALUES ($1) RETURNING id`, [who]);
		const finish = (ok, summary) => q(`UPDATE ${S}.timesheet_syncs SET finished_at = now(), succeeded = $2, summary = $3 WHERE id = $1`, [log.rows[0].id, ok, summary.slice(0, 2000)]);
		try {
			const sent = await push(settings);
			const days = Number.isInteger(settings.timesheet_sync_days) ? settings.timesheet_sync_days : 60;
			const since = daysAgo(days);
			const { tasks, complete } = await tasksSince(key, since);

			const known = new Map(); // timesheet task id → our entry
			for (const r of (
				await q(
					`SELECT id, timesheet_task_id, timesheet_last_update_ms, work_date, push_status, (billing_id IS NOT NULL OR pay_run_id IS NOT NULL) AS locked
					FROM ${S}.time_entries WHERE timesheet_task_id IS NOT NULL`,
				)
			).rows)
				known.set(r.timesheet_task_id, r);
			const deleting = new Set((await q(`SELECT task_id FROM ${S}.timesheet_deletions`)).rows.map((r) => r.task_id));
			const employees = new Map();
			const byEmail = new Map();
			for (const r of (await q(`SELECT id, lower(email) AS email, timesheet_user_id FROM ${S}.employees`)).rows) {
				if (r.timesheet_user_id) employees.set(r.timesheet_user_id, r.id);
				else if (r.email) byEmail.set(r.email, r.id);
			}
			const projects = new Map();
			for (const r of (await q(`SELECT id, name, timesheet_project_id, timesheet_client_name FROM ${S}.projects WHERE timesheet_project_id IS NOT NULL`)).rows) projects.set(r.timesheet_project_id, r);

			const n = { added: 0, updated: 0, removed: 0, kept: 0, skipped: 0, employees: 0, projects: 0 };
			const seen = new Set();
			// Ledger wins: send Ledger's version back on the push after the pull.
			const keep = async (have) => {
				await q(`UPDATE ${S}.time_entries SET push_status = 'pending', push_error = '' WHERE id = $1 AND push_status IN ('synced', 'failed')`, [have.id]);
				n.kept++;
			};
			const mine = (have) => have.locked || have.push_status === "pending" || have.push_status === "failed";

			async function employeeFor(u) {
				if (employees.has(u.id)) return employees.get(u.id);
				let id = u.email ? byEmail.get(u.email) : undefined;
				if (id !== undefined) {
					await q(`UPDATE ${S}.employees SET timesheet_user_id = $2, updated_at = now() WHERE id = $1`, [id, u.id]);
				} else {
					const name = u.name || `timesheet.io user ${u.id.slice(0, 8)}`;
					for (const candidate of [name, `${name} (timesheet.io)`.slice(0, 200), `${name.slice(0, 150)} (timesheet.io ${u.id.slice(0, 8)})`]) {
						const r = await q(
							`INSERT INTO ${S}.employees (name, email, employee_number, timesheet_user_id, created_by) VALUES ($1, $2, $3, $4, $5)
							ON CONFLICT DO NOTHING RETURNING id`,
							[candidate, u.email, u.number, u.id, who],
						);
						if (r.rows.length) {
							id = r.rows[0].id;
							break;
						}
					}
					if (id === undefined) id = (await q(`SELECT id FROM ${S}.employees WHERE timesheet_user_id = $1`, [u.id])).rows[0]?.id;
					if (id === undefined) throw new TimesheetError(500, `Could not add the employee ${name}.`);
					n.employees++;
				}
				employees.set(u.id, id);
				return id;
			}

			async function projectFor(p) {
				if (!p) return null;
				const have = projects.get(p.id);
				if (have) {
					if (have.name !== p.name || have.timesheet_client_name !== p.client) {
						await q(`UPDATE ${S}.projects SET name = $2, timesheet_client_name = $3 WHERE id = $1`, [have.id, p.name, p.client]);
						have.name = p.name;
						have.timesheet_client_name = p.client;
					}
					return have.id;
				}
				// The customer is only matched to one that already exists; a person assigns the rest on the Projects tab.
				const match = p.client ? await ctx.entities.find(p.client) : null;
				const r = await q(
					`INSERT INTO ${S}.projects (name, customer_entity_id, bill_rate_cents, timesheet_project_id, timesheet_client_name, created_by) VALUES ($1, $2, $3, $4, $5, $6)
					ON CONFLICT (timesheet_project_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
					[p.name, match?.is_customer ? match.id : null, p.rate_cents, p.id, p.client, who],
				);
				projects.set(p.id, { id: r.rows[0].id, name: p.name, timesheet_client_name: p.client });
				n.projects++;
				return r.rows[0].id;
			}

			for (const raw of tasks) {
				const t = readTask(raw);
				if (!t) {
					n.skipped++;
					continue;
				}
				seen.add(t.id);
				if (deleting.has(t.id)) continue; // deleted in Ledger; the deletion is on its way
				const have = known.get(t.id);
				if (t.deleted) {
					if (!have) continue;
					if (mine(have)) await keep(have); // made again in timesheet.io
					else {
						await q(`DELETE FROM ${S}.time_entries WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL AND push_status = 'synced'`, [have.id]);
						n.removed++;
					}
					continue;
				}
				if (have && t.last_update_ms !== null && have.timesheet_last_update_ms !== null && BigInt(t.last_update_ms) === have.timesheet_last_update_ms) continue; // unchanged
				if (have && mine(have)) {
					await keep(have);
					continue;
				}
				const employeeId = await employeeFor(t.user);
				const projectId = await projectFor(t.project);
				const r = await q(
					`INSERT INTO ${S}.time_entries (employee_id, project_id, work_date, minutes, description, billable, source, timesheet_task_id, timesheet_last_update_ms,
						timesheet_task_user_id, timesheet_start, timesheet_end, timesheet_break_seconds, push_status, created_by)
					VALUES ($1, $2, $3, $4, $5, $6, 'timesheet', $7, $8, $9, $10, $11, $12, 'synced', $13)
					ON CONFLICT (timesheet_task_id) DO UPDATE SET employee_id = EXCLUDED.employee_id, project_id = EXCLUDED.project_id, work_date = EXCLUDED.work_date,
						minutes = EXCLUDED.minutes, description = EXCLUDED.description, billable = EXCLUDED.billable,
						timesheet_last_update_ms = EXCLUDED.timesheet_last_update_ms, timesheet_task_user_id = EXCLUDED.timesheet_task_user_id,
						timesheet_start = EXCLUDED.timesheet_start, timesheet_end = EXCLUDED.timesheet_end, timesheet_break_seconds = EXCLUDED.timesheet_break_seconds, updated_at = now()
					WHERE ${S}.time_entries.billing_id IS NULL AND ${S}.time_entries.pay_run_id IS NULL AND ${S}.time_entries.push_status = 'synced'
					RETURNING (xmax = 0) AS inserted`,
					[employeeId, projectId, t.work_date, t.minutes, t.description, t.billable, t.id, t.last_update_ms, t.user.id, t.start, t.end, t.break_seconds, who],
				);
				if (r.rows.length === 0) {
					// Changed in Ledger meanwhile: Ledger wins.
					const now = (await q(`SELECT id, push_status, (billing_id IS NOT NULL OR pay_run_id IS NOT NULL) AS locked FROM ${S}.time_entries WHERE timesheet_task_id = $1`, [t.id])).rows[0];
					if (now) await keep(now);
				} else if (r.rows[0].inserted) n.added++;
				else n.updated++;
			}
			// Entries whose task is gone from timesheet.io (only when the whole window was read).
			if (complete && tasks.length > 0)
				for (const [taskId, have] of known)
					if (!seen.has(taskId) && have.work_date > since) {
						if (mine(have)) await keep(have);
						else {
							await q(`DELETE FROM ${S}.time_entries WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL AND push_status = 'synced'`, [have.id]);
							n.removed++;
						}
					}

			const after = n.kept ? await push(settings) : { sent: 0, failed: 0, ledger_only: 0, deleted: 0 };
			const out = { sent: sent.sent + after.sent, failed: after.failed || sent.failed, deleted: sent.deleted + after.deleted, ledger_only: sent.ledger_only };
			const parts = [`${tasks.length} entries read since ${since}: ${n.added} added, ${n.updated} updated, ${n.removed} removed`];
			if (out.sent || out.deleted) parts.push(`${out.sent} sent to timesheet.io${out.deleted ? `, ${out.deleted} deleted there` : ""}`);
			if (n.kept) parts.push(`${n.kept} changed in both places: Ledger's version kept and sent back`);
			if (out.failed) parts.push(`${out.failed} couldn't be sent (tried again next time)`);
			if (n.employees) parts.push(`${n.employees} new employees (set their pay rates)`);
			if (n.projects) parts.push(`${n.projects} new projects`);
			if (n.skipped) parts.push(`${n.skipped} skipped (still running or no length)`);
			if (!complete) parts.push("stopped at 10,000 entries: lower the days to pull");
			const summary = `${parts.join("; ")}.`;
			await finish(true, summary);
			await refreshTodos();
			return { summary, ...n, ...out };
		} catch (e) {
			await finish(false, String(e?.message ?? e)).catch(() => {});
			throw e;
		}
	}

	async function pushCounts() {
		const { rows } = await q(
			`SELECT count(*) FILTER (WHERE push_status = 'pending')::int AS to_send, count(*) FILTER (WHERE push_status = 'failed')::int AS not_sent,
				count(*) FILTER (WHERE push_status = 'ledger_only')::int AS ledger_only, (SELECT count(*)::int FROM ${S}.timesheet_deletions) AS deletions
			FROM ${S}.time_entries`,
		);
		return rows[0];
	}

	ctx.route("GET", "/timesheet/status", async () => {
		const s = await ctx.settings.get();
		return { configured: Boolean(s.timesheet_api_key), auto_sync: s.timesheet_auto_sync === true, on_sign_in: s.timesheet_sync_on_login !== false, days: s.timesheet_sync_days ?? 60, last_sync: await lastSync(), ...(await pushCounts()) };
	});

	ctx.route("POST", "/timesheet/test", async () => {
		try {
			const me = await profile(checkKey((await ctx.settings.get()).timesheet_api_key));
			const name = [me?.displayName, me?.email].filter((v) => typeof v === "string" && v).join(" · ").slice(0, 300);
			return { ok: true, account: name || "connected" };
		} catch (e) {
			throw asHttp(e);
		}
	});

	ctx.route("POST", "/timesheet/sync", async (req) => {
		try {
			return await sync(await ctx.settings.get(), req.user.username, req.user.organization?.id ?? 1);
		} catch (e) {
			throw asHttp(e);
		}
	});

	// ---- overview, to-dos, search, import ---------------------------------------
	ctx.route("GET", "/accounts", async () => {
		const list = await ctx.ledger.listAccounts();
		return { data: list.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency, kind: a.kind ?? null, parent_code: a.parent_code ?? null })) };
	});

	ctx.route("GET", "/summary", async (req) => {
		const s = await ctx.settings.get();
		const { rows } = await q(
			`SELECT
				(SELECT count(*)::int FROM ${S}.employees WHERE is_active) AS employees,
				(SELECT COALESCE(sum(t.minutes), 0)::int FROM ${S}.time_entries t WHERE t.pay_run_id IS NULL) AS unpaid_minutes,
				(SELECT COALESCE(sum(t.minutes), 0)::int FROM ${S}.time_entries t WHERE t.billable AND t.billing_id IS NULL) AS unbilled_minutes,
				(SELECT COALESCE(sum(round(t.minutes * ${RATE} / 60.0)), 0)::bigint FROM ${S}.time_entries t JOIN ${S}.employees e ON e.id = t.employee_id
					LEFT JOIN ${S}.projects p ON p.id = t.project_id WHERE t.billable AND t.billing_id IS NULL) AS unbilled_cents`,
		);
		return {
			...rows[0],
			role: req.user.role,
			currency: currencyOf(s),
			accounts: Object.fromEntries(["wages_expense_account", "employer_cost_account", "payroll_liabilities_account", "receivable_account", "revenue_account"].map((k) => [k, s[k] || null])),
			timesheet: { configured: Boolean(s.timesheet_api_key), auto_sync: s.timesheet_auto_sync === true, last_sync: await lastSync() },
		};
	});

	async function refreshTodos() {
		try {
			const { rows } = await q(
				`SELECT (SELECT count(*)::int FROM ${S}.employees WHERE is_active AND pay_rate_cents = 0) AS no_rate,
					(SELECT count(DISTINCT p.id)::int FROM ${S}.projects p JOIN ${S}.time_entries t ON t.project_id = p.id
						WHERE p.customer_entity_id IS NULL AND t.billable AND t.billing_id IS NULL) AS no_customer`,
			);
			const todo = async (key, count, title) => {
				if (count > 0) {
					await ctx.dashboard.todo({ key, title, link: "/apps/employees" });
					await ctx.dashboard.reopen(key);
				} else await ctx.dashboard.complete(key);
			};
			await todo("pay-rates", rows[0].no_rate, `Set the pay rate of ${rows[0].no_rate} ${rows[0].no_rate === 1 ? "employee" : "employees"}`);
			await todo("project-customers", rows[0].no_customer, `Choose the customer for ${rows[0].no_customer} ${rows[0].no_customer === 1 ? "project" : "projects"} with billable hours`);
		} catch (e) {
			ctx.log.warn("could not update the dashboard", { error: String(e?.message ?? e) });
		}
	}

	ctx.search.provide(async (query, { limit }) => {
		const { rows } = await q(`SELECT id, name, email, pay_type FROM ${S}.employees WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY lower(name) LIMIT $2`, [
			`%${query.replace(/[\\%_]/g, "\\$&")}%`,
			Math.min(limit, 10),
		]);
		return rows.map((r) => ({ title: r.name, subtitle: ["Employee", r.pay_type, r.email].filter(Boolean).join(" · "), href: `/apps/employees?employee=${r.id}` }));
	});

	ctx.imports.provide({
		label: "Employees",
		description: "People and their pay and billing rates. Names already here are skipped.",
		fields: [
			{ key: "name", label: "Name", required: true },
			{ key: "email", label: "Email" },
			{ key: "employee_number", label: "Employee number" },
			{ key: "pay_type", label: "Pay type", help: "hourly or salary (hourly when empty)" },
			{ key: "pay_rate", label: "Pay rate", type: "money", help: "Per hour, or per pay run for salary" },
			{ key: "bill_rate", label: "Billing rate per hour", type: "money" },
			{ key: "withholding_percent", label: "Withholding %", type: "number" },
			{ key: "employer_cost_percent", label: "Employer cost %", type: "number" },
		],
		async handler(rows, { dryRun, user }) {
			const errors = [];
			const have = new Set((await q(`SELECT lower(name) AS name FROM ${S}.employees`)).rows.map((r) => r.name));
			const add = [];
			let skipped = 0;
			for (const r of rows) {
				const name = String(r.name ?? "").trim();
				const fail = (message) => errors.push({ row: r._row, message });
				const payType = String(r.pay_type ?? "hourly").trim().toLowerCase() || "hourly";
				const pct = (v) => (v === null || v === undefined ? 0 : Number(v));
				const money = (v) => (v === null || v === undefined ? 0 : Number(v));
				if (name === "" || name.length > 200) fail("the name must be 1 to 200 characters");
				else if (payType !== "hourly" && payType !== "salary") fail(`pay type "${payType}" must be hourly or salary`);
				else if ([money(r.pay_rate), money(r.bill_rate)].some((v) => !Number.isInteger(v) || v < 0 || v > MAX_CENTS)) fail("rates must be 0 or more");
				else if ([pct(r.withholding_percent), pct(r.employer_cost_percent)].some((v) => !Number.isFinite(v) || v < 0 || v > 100)) fail("percentages must be from 0 to 100");
				else if (have.has(name.toLowerCase())) skipped++;
				else {
					have.add(name.toLowerCase());
					add.push([name, String(r.email ?? "").trim().slice(0, 200), String(r.employee_number ?? "").trim().slice(0, 100), payType, money(r.pay_rate), money(r.bill_rate), pct(r.withholding_percent), pct(r.employer_cost_percent)]);
				}
			}
			const tail = skipped ? ` ${skipped} already here, skipped.` : "";
			if (dryRun) return { summary: `Would add ${add.length} ${add.length === 1 ? "employee" : "employees"}.${tail}`, errors };
			if (errors.length) return { summary: "Nothing imported.", errors };
			if (add.length)
				await q(
					`INSERT INTO ${S}.employees (name, email, employee_number, pay_type, pay_rate_cents, bill_rate_cents, withholding_percent, employer_cost_percent, created_by)
					SELECT v->>0, v->>1, v->>2, v->>3, (v->>4)::bigint, (v->>5)::bigint, (v->>6)::numeric, (v->>7)::numeric, $2
					FROM jsonb_array_elements($1::jsonb) AS v ON CONFLICT DO NOTHING`,
					[JSON.stringify(add), user?.username ?? "import"],
				);
			return { summary: `Added ${add.length} ${add.length === 1 ? "employee" : "employees"}.${tail}` };
		},
	});

	/** A pull nobody pressed a button for, in the organizations wanted(org, settings) picks; a failure goes to the dashboard. */
	const pullInBackground = (who, wanted) =>
		ctx.orgs
			.forEach(async (org) => {
				const s = await ctx.settings.get();
				if (!s.timesheet_api_key || !wanted(org, s)) return;
				try {
					await sync(s, who, org.id);
					await ctx.dashboard.dismiss("timesheet-sync");
				} catch (e) {
					await ctx.dashboard.notify({ key: "timesheet-sync", title: "Pulling hours from timesheet.io failed", body: String(e?.message ?? e).slice(0, 500), level: "warning", link: "/settings/m/employees" });
				}
			})
			.catch((e) => ctx.log.warn("timesheet.io sync failed", { error: String(e?.message ?? e) }));

	// Billings made before 0.4.0 have one journal entry for the whole billing: tag it Billed too, so other
	// modules find all billed hours the same way (the same ref again only updates the link).
	setTimeout(() => {
		ctx.orgs
			.forEach(async () => {
				const { rows } = await q(`SELECT id, journal_entry_id FROM ${S}.billings WHERE status = 'posted' AND journal_entry_id IS NOT NULL`);
				for (const r of rows) {
					try {
						const entry = await ctx.ledger.getJournalEntry(r.journal_entry_id);
						if (entry.reversed_by_id === null && !entry.links.some((l) => l.module_id === ctx.id && l.ref === BILLED_TAG.ref))
							await ctx.ledger.linkJournalEntry(r.journal_entry_id, { ...BILLED_TAG, href: billingHref(r.id) });
					} catch {
						// the entry is gone (restored from elsewhere): nothing to tag
					}
				}
			})
			.catch((e) => ctx.log.warn("could not tag older billings", { error: String(e?.message ?? e) }));
	}, 5_000).unref();

	// Hourly pull from timesheet.io, in every organization that turned it on.
	setInterval(() => pullInBackground("timesheet.io (hourly)", (_org, s) => s.timesheet_auto_sync === true), 3_600_000).unref();

	// Pull when someone signs in. Modules get no sign-in event, so this watches for new
	// sessions in Ledger's own table (only when they were created and for which organization).
	let signInsSince = new Date();
	let watchSignIns = true;
	setInterval(async () => {
		if (!watchSignIns) return;
		try {
			const { rows } = await q(
				`SELECT COALESCE((to_jsonb(s)->>'org_id')::int, 1) AS org_id, max(date_trunc('milliseconds', s.created_at)) AS at
				FROM public.sessions s WHERE date_trunc('milliseconds', s.created_at) > $1 GROUP BY 1`,
				[signInsSince],
			);
			if (rows.length === 0) return;
			for (const r of rows) if (r.at > signInsSince) signInsSince = r.at;
			const orgs = new Set(rows.map((r) => Number(r.org_id)));
			await pullInBackground("timesheet.io (on sign-in)", (org, s) => orgs.has(Number(org.id)) && s.timesheet_sync_on_login !== false);
		} catch (e) {
			watchSignIns = false;
			ctx.log.warn("can't see sign-ins: timesheet.io won't be pulled on sign-in", { error: String(e?.message ?? e) });
		}
	}, Number(process.env.EMPLOYEES_SIGN_IN_POLL_MS) || 15_000).unref();

	ctx.log.info("employees module ready");
}
