// Employees: time entries, billable hours and payroll, with time pulled from timesheet.io.
// Ledger loads this file at startup and calls register(ctx).
import { TimesheetError, checkKey, profile, readTask, tasksSince } from "./lib/timesheet.mjs";

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
		t.description, t.billable, t.bill_rate_cents, t.source, t.billing_id, t.pay_run_id,
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
			`INSERT INTO ${S}.time_entries (${keys.join(", ")}, created_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}) RETURNING id`,
			[...keys.map((k) => f[k]), req.user.username],
		);
		return ctx.response(201, { id: rows[0].id });
	});

	async function openEntry(id) {
		const { rows } = await q(`SELECT id, source, billing_id, pay_run_id FROM ${S}.time_entries WHERE id = $1`, [id]);
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
		if (entry.source === "timesheet" && keys.some((k) => k !== "bill_rate_cents"))
			throw new ctx.HttpError(409, "This entry comes from timesheet.io: change it there and sync. Only its billing rate can be set here.");
		const { rowCount } = await q(
			`UPDATE ${S}.time_entries SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL`,
			[id, ...keys.map((k) => f[k])],
		);
		if (rowCount === 0) throw new ctx.HttpError(409, "This time entry was just billed or paid.");
		return { id: entry.id };
	});

	ctx.route("DELETE", "/time/:id", async (req) => {
		const id = paramId(req, "time entry");
		const entry = await openEntry(id);
		if (entry.source === "timesheet") throw new ctx.HttpError(409, "This entry comes from timesheet.io: delete it there and sync.");
		const { rowCount } = await q(`DELETE FROM ${S}.time_entries WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL`, [id]);
		if (rowCount === 0) throw new ctx.HttpError(409, "This time entry was just billed or paid.");
	});

	// ---- billings: bill a customer for billable hours -----------------------------
	const BILL = `id, customer_entity_id, customer_name, period_start, period_end, billing_date, currency, total_minutes, total_cents, status, journal_entry_id, created_by, created_at, reversed_by, reversed_at`;
	const releaseBilling = (id, drop) =>
		q(
			`WITH freed AS (UPDATE ${S}.time_entries SET billing_id = NULL, billed_rate_cents = NULL, billed_amount_cents = NULL, updated_at = now() WHERE billing_id = $1 RETURNING 1)
			${drop ? `DELETE FROM ${S}.billings WHERE id = $1` : `SELECT count(*) FROM freed`}`,
			[id],
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

	ctx.route("GET", "/billings", async () => {
		await settle("billings", "billing", (id) => releaseBilling(id, true));
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

	ctx.route("POST", "/billings", async (req) => {
		const b = body(req);
		const entity = await customer(idOf(b.customer_entity_id, "customer"));
		const from = reqDate(b.period_start, "from");
		const to = reqDate(b.period_end, "to");
		if (to < from) throw bad("the period ends before it starts");
		const billingDate = b.billing_date === undefined ? today() : reqDate(b.billing_date, "billing date");
		const settings = await ctx.settings.get();
		const acc = await pickAccounts(b, settings, { receivable_account: "accounts receivable account", revenue_account: "revenue account" });
		const currency = currencyOf(settings);

		const { rows } = await q(
			`WITH b AS (
				INSERT INTO ${S}.billings (customer_entity_id, customer_name, period_start, period_end, billing_date, currency, created_by)
				VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
			), claimed AS (
				UPDATE ${S}.time_entries t
				SET billing_id = (SELECT id FROM b), billed_rate_cents = r.rate, billed_amount_cents = round(t.minutes * r.rate / 60.0)::bigint, updated_at = now()
				FROM ${S}.time_entries t2
				JOIN ${S}.employees e ON e.id = t2.employee_id
				JOIN ${S}.projects p ON p.id = t2.project_id
				CROSS JOIN LATERAL (SELECT COALESCE(t2.bill_rate_cents, p.bill_rate_cents, e.bill_rate_cents, 0) AS rate) r
				WHERE t2.id = t.id AND p.customer_entity_id = $1 AND t.billable AND t.billing_id IS NULL AND t.work_date BETWEEN $3 AND $4 AND r.rate > 0
				RETURNING t.minutes, t.billed_amount_cents
			)
			SELECT (SELECT id FROM b) AS id, count(*)::int AS entries, COALESCE(sum(minutes), 0)::int AS minutes, COALESCE(sum(billed_amount_cents), 0)::bigint AS total FROM claimed`,
			[entity.id, entity.name, from, to, billingDate, currency, req.user.username],
		);
		const made = rows[0];
		if (made.entries === 0 || made.total <= 0n) {
			await releaseBilling(made.id, true);
			throw bad(`${entity.name} has no unbilled billable hours with a billing rate from ${from} to ${to}.`);
		}
		let entry;
		try {
			entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: billingDate,
					description: `Billable hours: ${entity.name}, ${from} to ${to} (${hours(made.minutes)} h)`,
					reference: `HOURS-${made.id}`,
					entity_id: entity.id,
					lines: [
						{ account_code: acc.receivable_account, debit_cents: made.total },
						{ account_code: acc.revenue_account, credit_cents: made.total },
					],
					links: [{ ref: `billing:${made.id}`, label: `Billed hours ${made.id} · ${entity.name}`.slice(0, 200), href: `/apps/employees?billing=${made.id}` }],
				},
				req.user,
			);
		} catch (e) {
			await releaseBilling(made.id, true);
			throw e;
		}
		const done = await q(`UPDATE ${S}.billings SET status = 'posted', journal_entry_id = $2, total_minutes = $3, total_cents = $4 WHERE id = $1 RETURNING ${BILL}`, [
			made.id,
			entry.id,
			made.minutes,
			made.total,
		]);
		return ctx.response(201, done.rows[0]);
	});

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

	ctx.route("POST", "/billings/:id/reverse", async (req) => {
		const id = paramId(req, "billing");
		const { rows } = await q(`SELECT ${BILL} FROM ${S}.billings WHERE id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such billing");
		if (rows[0].status !== "posted") throw new ctx.HttpError(409, `This billing is ${rows[0].status}, not posted.`);
		await reverseEntryOf(rows[0].journal_entry_id, `Reversal: billed hours ${id} · ${rows[0].customer_name}`, req.user);
		await q(`UPDATE ${S}.billings SET status = 'reversed', reversed_by = $2, reversed_at = now() WHERE id = $1`, [id, req.user.username]);
		await releaseBilling(id, false);
		return { id: rows[0].id, status: "reversed" };
	});

	// ---- pay runs -------------------------------------------------------------
	const RUN = `r.id, r.period_start, r.period_end, r.pay_date, r.currency, r.status, r.paid_from_account, r.journal_entry_id, r.created_by, r.created_at, r.posted_by, r.posted_at, r.reversed_by, r.reversed_at`;
	const RUN_TOTALS = `(SELECT count(*)::int FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS employees,
		(SELECT COALESCE(sum(l.gross_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS gross_cents,
		(SELECT COALESCE(sum(l.deductions_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS deductions_cents,
		(SELECT COALESCE(sum(l.employer_cost_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS employer_cost_cents,
		(SELECT COALESCE(sum(l.gross_cents - l.deductions_cents), 0)::bigint FROM ${S}.pay_run_lines l WHERE l.pay_run_id = r.id) AS net_cents`;
	const releaseRun = (id) => q(`UPDATE ${S}.time_entries SET pay_run_id = NULL, updated_at = now() WHERE pay_run_id = $1`, [id]);

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
		return getRun(id);
	});

	ctx.route("POST", "/pay-runs/:id/reverse", async (req) => {
		const id = paramId(req, "pay run");
		const run = await getRun(id);
		if (run.status !== "posted") throw new ctx.HttpError(409, `This pay run is ${run.status}, not posted.`);
		await reverseEntryOf(run.journal_entry_id, `Reversal: pay run ${id}`, req.user);
		await q(`UPDATE ${S}.pay_runs SET status = 'reversed', reversed_by = $2, reversed_at = now() WHERE id = $1`, [id, req.user.username]);
		await releaseRun(id);
		return getRun(id);
	});

	// ---- timesheet.io ---------------------------------------------------------
	const asHttp = (e) => (e instanceof TimesheetError ? new ctx.HttpError(e.status, e.message) : e);
	const syncing = new Set(); // organization ids with a sync under way (this process only)

	async function lastSync() {
		const { rows } = await q(`SELECT id, started_at, finished_at, started_by, succeeded, summary FROM ${S}.timesheet_syncs ORDER BY id DESC LIMIT 1`);
		return rows[0] ?? null;
	}

	/** Pulls tasks from timesheet.io into time entries. Entries already billed or paid are never changed. */
	async function sync(settings, who, orgId) {
		const key = checkKey(settings.timesheet_api_key);
		if (syncing.has(orgId)) throw new TimesheetError(409, "A sync is already running.");
		syncing.add(orgId);
		const log = await q(`INSERT INTO ${S}.timesheet_syncs (started_by) VALUES ($1) RETURNING id`, [who]);
		const finish = (ok, summary) => q(`UPDATE ${S}.timesheet_syncs SET finished_at = now(), succeeded = $2, summary = $3 WHERE id = $1`, [log.rows[0].id, ok, summary.slice(0, 2000)]);
		try {
			const days = Number.isInteger(settings.timesheet_sync_days) ? settings.timesheet_sync_days : 60;
			const since = daysAgo(days);
			const { tasks, complete } = await tasksSince(key, since);

			const known = new Map(); // timesheet task id → our entry
			for (const r of (await q(`SELECT id, timesheet_task_id, timesheet_last_update_ms, work_date, (billing_id IS NOT NULL OR pay_run_id IS NOT NULL) AS locked FROM ${S}.time_entries WHERE source = 'timesheet'`)).rows)
				known.set(r.timesheet_task_id, r);
			const employees = new Map();
			const byEmail = new Map();
			for (const r of (await q(`SELECT id, lower(email) AS email, timesheet_user_id FROM ${S}.employees`)).rows) {
				if (r.timesheet_user_id) employees.set(r.timesheet_user_id, r.id);
				else if (r.email) byEmail.set(r.email, r.id);
			}
			const projects = new Map();
			for (const r of (await q(`SELECT id, name, timesheet_project_id, timesheet_client_name FROM ${S}.projects WHERE timesheet_project_id IS NOT NULL`)).rows) projects.set(r.timesheet_project_id, r);

			const n = { added: 0, updated: 0, removed: 0, locked: 0, skipped: 0, employees: 0, projects: 0 };
			const seen = new Set();

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
				const have = known.get(t.id);
				if (t.deleted) {
					if (!have) continue;
					if (have.locked) n.locked++;
					else {
						await q(`DELETE FROM ${S}.time_entries WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL`, [have.id]);
						n.removed++;
					}
					continue;
				}
				if (have && t.last_update_ms !== null && have.timesheet_last_update_ms !== null && BigInt(t.last_update_ms) === have.timesheet_last_update_ms) continue; // unchanged
				if (have?.locked) {
					n.locked++;
					continue;
				}
				const employeeId = await employeeFor(t.user);
				const projectId = await projectFor(t.project);
				const r = await q(
					`INSERT INTO ${S}.time_entries (employee_id, project_id, work_date, minutes, description, billable, source, timesheet_task_id, timesheet_last_update_ms, created_by)
					VALUES ($1, $2, $3, $4, $5, $6, 'timesheet', $7, $8, $9)
					ON CONFLICT (timesheet_task_id) DO UPDATE SET employee_id = EXCLUDED.employee_id, project_id = EXCLUDED.project_id, work_date = EXCLUDED.work_date,
						minutes = EXCLUDED.minutes, description = EXCLUDED.description, billable = EXCLUDED.billable,
						timesheet_last_update_ms = EXCLUDED.timesheet_last_update_ms, updated_at = now()
					WHERE ${S}.time_entries.billing_id IS NULL AND ${S}.time_entries.pay_run_id IS NULL
					RETURNING (xmax = 0) AS inserted`,
					[employeeId, projectId, t.work_date, t.minutes, t.description, t.billable, t.id, t.last_update_ms, who],
				);
				if (r.rows.length === 0) n.locked++;
				else if (r.rows[0].inserted) n.added++;
				else n.updated++;
			}
			// Entries whose task is gone from timesheet.io (only when the whole window was read).
			if (complete && tasks.length > 0)
				for (const [taskId, have] of known)
					if (!seen.has(taskId) && have.work_date > since) {
						if (have.locked) n.locked++;
						else {
							await q(`DELETE FROM ${S}.time_entries WHERE id = $1 AND billing_id IS NULL AND pay_run_id IS NULL`, [have.id]);
							n.removed++;
						}
					}

			const parts = [`${tasks.length} entries read since ${since}: ${n.added} added, ${n.updated} updated, ${n.removed} removed`];
			if (n.employees) parts.push(`${n.employees} new employees (set their pay rates)`);
			if (n.projects) parts.push(`${n.projects} new projects`);
			if (n.locked) parts.push(`${n.locked} changed in timesheet.io after being billed or paid here and left as they were`);
			if (n.skipped) parts.push(`${n.skipped} skipped (still running or no length)`);
			if (!complete) parts.push("stopped at 10,000 entries: lower the days to pull");
			const summary = `${parts.join("; ")}.`;
			await finish(true, summary);
			await refreshTodos();
			return { summary, ...n };
		} catch (e) {
			await finish(false, String(e?.message ?? e)).catch(() => {});
			throw e;
		} finally {
			syncing.delete(orgId);
		}
	}

	ctx.route("GET", "/timesheet/status", async () => {
		const s = await ctx.settings.get();
		return { configured: Boolean(s.timesheet_api_key), auto_sync: s.timesheet_auto_sync === true, days: s.timesheet_sync_days ?? 60, last_sync: await lastSync() };
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

	// Hourly pull from timesheet.io, in every organization that turned it on.
	setInterval(() => {
		ctx.orgs
			.forEach(async (org) => {
				const s = await ctx.settings.get();
				if (s.timesheet_auto_sync !== true || !s.timesheet_api_key) return;
				try {
					await sync(s, "timesheet.io (hourly)", org.id);
					await ctx.dashboard.dismiss("timesheet-sync");
				} catch (e) {
					await ctx.dashboard.notify({ key: "timesheet-sync", title: "The hourly timesheet.io sync failed", body: String(e?.message ?? e).slice(0, 500), level: "warning", link: "/settings/m/employees" });
				}
			})
			.catch((e) => ctx.log.warn("timesheet.io sync failed", { error: String(e?.message ?? e) }));
	}, 3_600_000).unref();

	ctx.log.info("employees module ready");
}
