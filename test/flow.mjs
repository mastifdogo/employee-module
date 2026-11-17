// End-to-end test of the real flows against a served Ledger (see README → Testing):
//   node test/flow.mjs http://127.0.0.1:8098 '<ledger_session cookie value>' http://127.0.0.1:8099
import assert from "node:assert/strict";

const [base, cookie, mock] = process.argv.slice(2);
const call = async (method, path, body) => {
	const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json", Cookie: `ledger_session=${cookie}`, Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : null };
};
const m = (method, path, body) => call(method, `/api/v1/m/employees${path}`, body);
const ok = async (p, status = 200) => {
	const r = await p;
	assert.equal(r.status, status, JSON.stringify(r.body));
	return r.body;
};
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const step = (s) => console.log(`  ok    ${s}`);
const mockTasks = async () => (await fetch(`${mock}/__tasks`)).json();
const mt = async (id) => (await mockTasks()).find((t) => t.id === id);
// A sync waits for the pushes queued before it, so after it timesheet.io has every change made so far.
const settle = () => ok(m("POST", "/timesheet/sync"));
// What the Sales module offers a customer as billable items (server/billable.mjs there): debits on a
// billable items account, on entries tagged with the customer, neither reversed nor a reversal.
const BILLABLE = "CLR-EMPLOYEES-BILLABLE"; // the module's clearing account, as Ledger names it
const salesItems = async (entityId, code = BILLABLE) => {
	const r = await ok(call("GET", `/api/v1/journal-entries?account_code=${code}&limit=500`));
	const entries = Array.isArray(r) ? r : r.data;
	return entries
		.filter((e) => String(e.entity?.id ?? "") === String(entityId) && e.reverses_id == null && e.reversed_by_id == null)
		.flatMap((e) => e.lines.filter((l) => l.account_code === code && Number(l.debit_cents) > 0).map((l) => ({ memo: l.memo || e.description, cents: Number(l.debit_cents) })));
};
// Ledger's shared tags on a journal entry (Ledger ≥ 0.23.0), as [tag, who set it, the customer or vendor].
const journal = (id) => ok(call("GET", `/api/v1/journal-entries/${id}`));
const tagsOf = async (id) => (await journal(id)).tags.map((t) => [t.tag, t.module_id, t.entity?.name ?? null]).sort();
// A person tags an entry in Ledger; the module hears of it just after the request answers.
const tagAs = (id, tag) => ok(call("POST", `/api/v1/journal-entries/${id}/tags`, { tag }));
const untagAs = (id, tag) => ok(call("DELETE", `/api/v1/journal-entries/${id}/tags/${tag}`));
const until = async (what, test) => {
	for (let i = 0; i < 50; i++) {
		if (await test()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.fail(`still not so after 5 s: ${what}`);
};
const billableIds = async () => (await ok(m("GET", "/time?show=billable"))).data.map((t) => t.id);
const entryBy = async (pred, qs = "from=2000-01-01") => (await ok(m("GET", `/time?${qs}`))).data.find(pred);

for (const [code, name, type, kind] of [["1000", "Chequing", "asset", "chequing"], ["1200", "Accounts receivable", "asset"], ["2300", "Payroll liabilities", "liability"], ["4100", "Service revenue", "revenue"], ["5200", "Wages", "expense"], ["5210", "Employer payroll costs", "expense"]]) {
	const r = await call("POST", "/api/v1/accounts", { code, name, type, currency: "CAD", ...(kind ? { kind } : {}) });
	assert.ok(r.status === 201 || r.status === 409, JSON.stringify(r.body));
}

// Employees, a customer, a project, manual time
const cleo = await ok(m("POST", "/employees", { name: "Cleo Park", pay_type: "salary", pay_rate_cents: 300000, withholding_percent: 20, employer_cost_percent: 5 }), 201);
await ok(m("POST", "/employees", { name: "cleo park" }), 409);
const ana = await ok(m("POST", "/employees", { name: "Ana S.", email: "ANA@example.com", pay_rate_cents: 4000, bill_rate_cents: 9000, withholding_percent: 10.5 }), 201);
const cust = await ok(m("POST", "/customers", { name: "Globex" }), 201);
const proj = await ok(m("POST", "/projects", { name: "Audit", customer_entity_id: cust.id, bill_rate_cents: 15000 }), 201);
await ok(m("POST", "/projects", { name: "X", customer_entity_id: 999999 }), 422);
const e1 = await ok(m("POST", "/time", { employee_id: ana.id, project_id: proj.id, work_date: day(4), minutes: 90, billable: true, description: "Review" }), 201);
await ok(m("POST", "/time", { employee_id: ana.id, work_date: "2026-13-40", minutes: 90 }), 422);
for (const d of ["2026-02-31", "0000-01-01"]) assert.match((await ok(m("POST", "/time", { employee_id: ana.id, work_date: d, minutes: 90 }), 422)).error.message, /^date must be a date/); // a day that doesn't exist
assert.match((await ok(m("GET", "/time?from=2026-04-31"), 422)).error.message, /^from must be a date/);
await ok(m("POST", "/time", { employee_id: ana.id, work_date: day(4), minutes: 0 }), 422);
await ok(m("PATCH", `/time/${e1.id}`, { minutes: 120 }));
step("employees, customer, project and manual time");

// timesheet.io: no key, bad key, sync
await ok(m("POST", "/timesheet/sync"), 409);
await ok(call("PUT", "/api/v1/modules/employees/settings", { values: { timesheet_api_key: "ts_wrong.key1" } }));
await ok(m("POST", "/timesheet/test"), 409);
await ok(call("PUT", "/api/v1/modules/employees/settings", { values: { timesheet_api_key: "ts_test.secret123", timesheet_time_zone: "Europe/Berlin" } }));
assert.equal((await ok(m("POST", "/timesheet/test"))).account, "Ana Silva · ana@example.com");
const s1 = await ok(m("POST", "/timesheet/sync"));
assert.equal(s1.added, 124, s1.summary);
assert.equal(s1.skipped, 1);
assert.equal(s1.employees, 1); // Ben is new; Ana matched by email
assert.equal(s1.projects, 2);
assert.equal(s1.ledger_only, 1); // the hand-entered time on Audit, a project timesheet.io doesn't have
assert.match((await entryBy((t) => t.id === e1.id)).push_error, /Audit isn't in timesheet.io/);
const s2 = await ok(m("POST", "/timesheet/sync"));
assert.deepEqual([s2.added, s2.updated, s2.removed, s2.sent], [0, 0, 0, 0], s2.summary);
const emps = (await ok(m("GET", "/employees"))).data;
assert.equal(emps.find((e) => e.id === ana.id).timesheet_user_id, "u-ana");
const ben = emps.find((e) => e.name === "Ben Okafor");
assert.equal(ben.pay_rate_cents, 0);
await ok(m("PATCH", `/employees/${ben.id}`, { pay_rate_cents: 5000 }));
const web = (await ok(m("GET", "/projects"))).data.find((p) => p.timesheet_project_id === "p-web");
assert.equal(web.bill_rate_cents, 12000);
assert.equal(web.customer_entity_id, null); // "Acme Corp" isn't a customer yet: a person assigns it
const acme = await ok(m("POST", "/customers", { name: "Acme Corp" }), 201);
await ok(m("PATCH", `/projects/${web.id}`, { customer_entity_id: acme.id }));
const t2 = (await ok(m("GET", `/time?from=${day(3)}`))).data.find((t) => t.description === "Task t2");
assert.equal(t2.minutes, 420); // 8 h minus a 1 h break
const calDays = (await ok(m("GET", `/calendar?from=${day(3)}&to=${day(3)}`))).data;
assert.deepEqual(calDays.map((r) => [r.employee_name, r.minutes, r.billable_minutes]), [["Ana S.", 180, 180]]);
await ok(m("GET", "/calendar?from=2020-01-01&to=2026-01-01"), 422);
step("timesheet.io sync (2 pages, idempotent, matches people by email)");

// Option 3: entries from timesheet.io are edited and deleted in Ledger, and the change is sent there
await ok(m("PATCH", `/time/${t2.id}`, { description: "Edited in Ledger" }));
const b5 = await entryBy((t) => t.description === "Task bulk5");
await ok(m("PATCH", `/time/${b5.id}`, { work_date: day(30) }));
const b7 = await entryBy((t) => t.description === "Task bulk7");
await ok(m("DELETE", `/time/${b7.id}`), 204);
await settle();
const mt2 = await mt("t2");
assert.equal(mt2.description, "Edited in Ledger");
assert.deepEqual([mt2.startDateTime, mt2.endDateTime], [`${day(2)}T09:00:00+02:00`, `${day(2)}T17:00:00+02:00`]); // times kept as they were
assert.equal((await mt("bulk5")).startDateTime, `${day(30)}T06:00:00+02:00`);
assert.equal((await mt("bulk5")).endDateTime, `${day(30)}T06:30:00+02:00`);
assert.equal((await mt("bulk7")).deleted, true);
assert.equal((await entryBy((t) => t.id === t2.id)).push_status, "synced");
step("Ledger edits and deletions of timesheet.io time are sent there");

// Option 1: time entered in Ledger becomes a task in timesheet.io, for the right person
const ops = (await ok(m("GET", "/projects"))).data.find((p) => p.timesheet_project_id === "p-ops");
const hand = await ok(m("POST", "/time", { employee_id: ana.id, project_id: ops.id, work_date: day(6), minutes: 60, description: "Hand-entered" }), 201);
await settle();
let made = (await mockTasks()).find((t) => t.description === "Hand-entered" && !t.deleted);
assert.equal(made.user, "u-ana");
assert.equal(made.project.id, "p-ops");
assert.deepEqual([made.startDateTime, made.endDateTime], [`${day(6)}T09:00:00+01:00`, `${day(6)}T10:00:00+01:00`]); // 9:00 in Europe/Berlin
const s2b = await settle();
assert.deepEqual([s2b.added, s2b.sent], [0, 0], s2b.summary); // its own task isn't pulled back as new
await ok(m("PATCH", `/time/${hand.id}`, { employee_id: ben.id })); // moved: made again under Ben
await settle();
assert.equal((await mockTasks()).find((t) => t.id === made.id).deleted, true);
made = (await mockTasks()).find((t) => t.description === "Hand-entered" && !t.deleted);
assert.equal(made.user, "u-ben");
step("hand-entered time sent to timesheet.io (and moved between people)");

// Billable hours go to the clearing account by themselves: one transaction per time entry, tagged customer, employee and project
const sortCents = async (id) => (await salesItems(id)).map((x) => x.cents).sort((a, b) => a - b);
const t2c = await entryBy((t) => t.id === t2.id);
assert.equal(t2c.clearing_status, "posted");
const entry = await journal(t2c.clearing_entry_id);
assert.equal(entry.entity?.name, "Acme Corp");
assert.deepEqual(entry.lines.map((l) => [l.account_code, Number(l.debit_cents), Number(l.credit_cents)]), [[BILLABLE, 84000, 0], [BILLABLE, 0, 84000]]); // 7 h at 120.00, debit and offset
assert.equal(entry.lines[0].memo, `${day(2)} · Ana S. · 7.00 h × 120.00 · Website rebuild: Edited in Ledger`);
assert.equal(entry.entry_date, day(2)); // the day the work was done
const billAcct = await ok(call("GET", `/api/v1/accounts/${BILLABLE}`));
assert.deepEqual([billAcct.name, billAcct.type, billAcct.kind, billAcct.currency, Number(billAcct.balance_cents)], ["Billable hours", "asset", "clearing", "CAD", 0]);
assert.equal(Number((await ok(call("GET", "/api/v1/accounts/4100"))).balance_cents), 0); // nothing is revenue yet
assert.equal((await ok(m("GET", "/accounts"))).data.some((x) => x.code === BILLABLE), false); // hidden clearing account: not in pickers
assert.equal((await ok(m("GET", "/summary"))).billable_hours.code, BILLABLE);
assert.deepEqual(await tagsOf(entry.id), [["ana-s", "employees", null], ["customer", "employees", "Acme Corp"], ["employee", "employees", null], ["project", "employees", null]]); // "Ana S." as a tag of its own
assert.ok((await tagsOf((await entryBy((t) => t.description === "Task t4")).clearing_entry_id)).some(([tag]) => tag === "ben-okafor"));
assert.deepEqual(entry.tags.filter((t) => t.tag !== "customer").map((t) => [t.tag, t.note]).sort(), [["ana-s", "Ana S."], ["employee", "Ana S."], ["project", "Website rebuild"]]);
assert.deepEqual(await sortCents(acme.id), [24000, 36000, 84000]); // t4, t1, t2: one item per time entry, for Sales to invoice
assert.deepEqual(await salesItems(cust.id), [{ memo: `${day(4)} · Ana S. · 2.00 h × 150.00 · Audit: Review`, cents: 30000 }]);
// Changed: the old transaction is reversed (its tags come off) and a new one posted
const t4 = await entryBy((t) => t.description === "Task t4");
await ok(m("PATCH", `/time/${t4.id}`, { minutes: 150 }));
const t4b = await entryBy((t) => t.id === t4.id);
assert.notEqual(String(t4b.clearing_entry_id), String(t4.clearing_entry_id));
assert.notEqual((await journal(t4.clearing_entry_id)).reversed_by_id, null);
assert.deepEqual(await tagsOf(t4.clearing_entry_id), []);
assert.deepEqual(await sortCents(acme.id), [30000, 36000, 84000]);
await ok(m("PATCH", `/time/${t4.id}`, { minutes: 120 }));
// A new project rate reprices its hours; a new customer moves them
await ok(m("PATCH", `/projects/${web.id}`, { bill_rate_cents: 13000 }));
assert.deepEqual(await sortCents(acme.id), [26000, 39000, 91000]);
await ok(m("PATCH", `/projects/${web.id}`, { customer_entity_id: cust.id }));
assert.deepEqual([await sortCents(acme.id), (await sortCents(cust.id)).length], [[], 4]);
await ok(m("PATCH", `/projects/${web.id}`, { customer_entity_id: acme.id, bill_rate_cents: 12000 }));
assert.deepEqual(await sortCents(acme.id), [24000, 36000, 84000]);
// Not billable: out of the clearing account; billable again: back in
const t1 = await entryBy((t) => t.description === "Task t1");
await ok(m("PATCH", `/time/${t1.id}`, { billable: false }));
assert.deepEqual([(await entryBy((t) => t.id === t1.id)).clearing_status, (await entryBy((t) => t.id === t1.id)).clearing_entry_id], ["none", null]);
assert.deepEqual(await sortCents(acme.id), [24000, 84000]);
await ok(m("PATCH", `/time/${t1.id}`, { billable: true }));
assert.deepEqual(await sortCents(acme.id), [24000, 36000, 84000]);
// Billable without a customer: stays out, and says why
const noCustomer = await ok(m("POST", "/time", { employee_id: ana.id, project_id: ops.id, work_date: day(7), minutes: 30, billable: true, description: "Billable, no customer" }), 201);
const nc = await entryBy((t) => t.id === noCustomer.id);
assert.deepEqual([nc.clearing_status, nc.clearing_error], ["none", "the project Internal ops has no customer"]);
await ok(m("DELETE", `/time/${noCustomer.id}`), 204);
// Deleted: its transaction is reversed
const extra = await ok(m("POST", "/time", { employee_id: ana.id, project_id: web.id, work_date: day(7), minutes: 60, billable: true, description: "Deleted again" }), 201);
const extraEntry = (await entryBy((t) => t.id === extra.id)).clearing_entry_id;
assert.deepEqual(await sortCents(acme.id), [12000, 24000, 36000, 84000]);
await ok(m("DELETE", `/time/${extra.id}`), 204);
assert.notEqual((await journal(extraEntry)).reversed_by_id, null);
assert.deepEqual(await sortCents(acme.id), [24000, 36000, 84000]);
assert.equal(Number((await ok(call("GET", `/api/v1/accounts/${BILLABLE}`))).balance_cents), 0);
await settle();
step("billable hours go to the clearing account by themselves, tagged customer, employee and project, and follow every change");

// Sales invoices them: it tags their transactions "billed" (a person does the same here); "paid" follows too
const t1c = (await entryBy((t) => t.id === t1.id)).clearing_entry_id;
await tagAs(t1c, "billed");
await until("tagged hours are billed", async () => String((await entryBy((t) => t.id === t1.id)).billed_tag_entry_id) === String(t1c));
await ok(m("PATCH", `/time/${t1.id}`, { minutes: 200 }), 409); // billed: locked
await ok(m("DELETE", `/time/${t1.id}`), 409);
assert.ok((await ok(m("GET", "/time?show=billed"))).data.some((t) => t.id === t1.id));
assert.equal((await ok(m("GET", "/time?show=in_clearing"))).data.some((t) => t.id === t1.id), false);
assert.equal((await ok(m("GET", `/calendar?from=${day(3)}&to=${day(3)}&show=billed`))).data.length, 1);
await tagAs(t1c, "paid");
await until("paid shows on the hours", async () => (await entryBy((t) => t.id === t1.id)).billing_paid === true);
await untagAs(t1c, "paid");
await until("and goes again", async () => (await entryBy((t) => t.id === t1.id)).billing_paid === false);
await settle();
assert.equal((await mt("t1")).billed, true);
step("tagged billed (an invoice bills them): hours billed and locked, billed in timesheet.io; paid follows its tag");

// Ledger wins: a change not yet sent (timesheet.io refuses the key meanwhile) and billed time keep Ledger's version
const b9 = await entryBy((t) => t.description === "Task bulk9");
await ok(call("PUT", "/api/v1/modules/employees/settings", { values: { timesheet_api_key: "ts_wrong.key1" } }));
await ok(m("PATCH", `/time/${b9.id}`, { description: "Ledger wins" }));
await ok(m("POST", "/timesheet/sync"), 409);
assert.equal((await entryBy((t) => t.id === b9.id)).push_status, "pending");
const changed = (await mockTasks())
	.map((t) =>
		t.id === "t1" ? { ...t, description: "changed in timesheet.io", lastUpdate: 999901 }
		: t.id === "t3" ? { ...t, endDateTime: t.endDateTime.replace("11:30", "12:30"), lastUpdate: 999902 }
		: t.id === "bulk9" ? { ...t, description: "changed in timesheet.io", lastUpdate: 999903 }
		: t,
	)
	.filter((t) => t.id !== "bulk0");
await fetch(`${mock}/__tasks`, { method: "POST", body: JSON.stringify(changed) });
await ok(call("PUT", "/api/v1/modules/employees/settings", { values: { timesheet_api_key: "ts_test.secret123" } }));
const s3 = await settle();
assert.deepEqual([s3.added, s3.updated, s3.removed, s3.kept, s3.sent], [0, 1, 1, 1, 2], s3.summary);
assert.equal((await mt("t1")).description, "Task t1"); // billed: Ledger's version sent back
assert.equal((await mt("bulk9")).description, "Ledger wins");
assert.equal((await entryBy((t) => t.description === "Task t3")).minutes, 150); // only changed there: taken
step("changed in both places: Ledger wins; changed only in timesheet.io: taken");

// The invoice is voided: "billed" comes off, the hours are open again (nothing is posted for a tag)
await untagAs(t1c, "billed");
await until("untagged hours are open again", async () => (await entryBy((t) => t.id === t1.id)).billed_tag_entry_id === null);
assert.equal((await journal(t1c)).reversed_by_id, null);
assert.equal(String((await entryBy((t) => t.id === t1.id)).clearing_entry_id), String(t1c));
await settle();
assert.equal((await mt("t1")).billed, false);
step("billed taken off: hours open again, billed no more in timesheet.io");

// Payroll
await ok(m("POST", "/pay-runs", { period_start: "2020-01-01", period_end: "2019-01-01" }), 422);
const run = await ok(m("POST", "/pay-runs", { period_start: day(40), period_end: day(0), pay_date: day(0) }), 201);
const line = (n) => run.lines.find((l) => l.employee_name === n);
// Ana: 2 h manual + 3 h + 7 h + 118 × 0.5 h = 71 h at 40.00; Ben: 2.5 h + 2 h + the 1 h moved to him
assert.equal(line("Ana S.").minutes, 71 * 60);
assert.equal(line("Ana S.").gross_cents, 284000);
assert.equal(line("Ana S.").deductions_cents, 29820);
assert.equal(line("Ben Okafor").gross_cents, 5.5 * 5000);
assert.equal(line("Cleo Park").gross_cents, 300000);
assert.equal(line("Cleo Park").employer_cost_cents, 15000);
await ok(m("POST", "/pay-runs", { period_start: day(40), period_end: day(0) }), 201).then((r) => assert.equal(r.lines.length, 1) || ok(m("DELETE", `/pay-runs/${r.id}`), 204)); // only the salary again: hours are claimed
await ok(m("PATCH", `/pay-runs/${run.id}/lines/${line("Ben Okafor").id}`, { deductions_cents: 99999999 }), 422);
const edited = await ok(m("PATCH", `/pay-runs/${run.id}/lines/${line("Ben Okafor").id}`, { deductions_cents: 2500 }));
await ok(m("POST", `/pay-runs/${run.id}/post`, {}), 422);
await ok(m("POST", `/pay-runs/${run.id}/post`, { paid_from_account: "1000", wages_expense_account: "5200", payroll_liabilities_account: "2300", employer_cost_account: "nope!" }), 422);
const posted = await ok(m("POST", `/pay-runs/${run.id}/post`, { paid_from_account: "1000", wages_expense_account: "5200", payroll_liabilities_account: "2300", employer_cost_account: "5210" }));
assert.equal(posted.status, "posted");
const WAGES = "CLR-EMPLOYEES-WAGES"; // the Wages payable clearing account
const amt = (e, code, side) => e.lines.filter((l) => l.account_code === code).reduce((a, l) => a + Number(l[side]), 0);
const pe = await journal(posted.journal_entry_id);
assert.equal(amt(pe, WAGES, "debit_cents"), Number(edited.gross_cents) + 15000);
assert.equal(amt(pe, "2300", "credit_cents"), Number(edited.deductions_cents) + 15000);
assert.equal(amt(pe, "1000", "credit_cents"), Number(edited.net_cents));
// The cost per project: hourly pay split by the hours on the run, salaries apart
// Ana 71 h: Audit 2 h, Website rebuild 10 h, Internal ops 59 h; Ben 5.5 h: Website rebuild 2 h, Internal ops 3.5 h; Cleo: salary
const byProject = Object.fromEntries((await ok(m("GET", `/pay-runs/${run.id}`))).costs.map((c) => [c.project_name ?? "-", [Number(c.gross_cents), Number(c.employer_cost_cents)]]));
assert.deepEqual(byProject, { Audit: [8000, 0], "Internal ops": [253500, 0], "Website rebuild": [50000, 0], "-": [300000, 15000] });
const costEntries = (await ok(call("GET", "/api/v1/journal-entries?account_code=5200&limit=50"))).data.filter((e) => e.reference === `PAYRUN-${run.id}`);
assert.equal(costEntries.length, 4);
assert.equal(costEntries.reduce((a, e) => a + amt(e, "5200", "debit_cents"), 0), Number(edited.gross_cents));
const costOf = (what) => costEntries.find((e) => e.description.endsWith(`· ${what}`));
assert.deepEqual(await tagsOf(costOf("Website rebuild").id), [["customer", "employees", "Acme Corp"], ["project", "employees", null]]);
assert.equal(costOf("Website rebuild").entity?.name, "Acme Corp");
assert.deepEqual(await tagsOf(costOf("Audit").id), [["customer", "employees", "Globex"], ["project", "employees", null]]);
assert.deepEqual(await tagsOf(costOf("Internal ops").id), [["project", "employees", null]]); // no customer
assert.deepEqual(await tagsOf(costOf("no project").id), []);
assert.equal(amt(costOf("no project"), "5210", "debit_cents"), 15000);
assert.equal(Number((await ok(call("GET", `/api/v1/accounts/${WAGES}`))).balance_cents), 0); // cleared by the pay run's own entry
await ok(m("POST", `/pay-runs/${run.id}/post`, { paid_from_account: "1000" }), 409);
await ok(m("DELETE", `/pay-runs/${run.id}`), 409);
assert.equal((await ok(m("GET", "/time?show=unpaid"))).data.length, 0);
await settle();
assert.equal((await mt("bulk3")).paid, true);
assert.equal(made.id && (await mt(made.id)).paid, true);
await ok(m("POST", `/pay-runs/${run.id}/reverse`));
assert.ok((await ok(m("GET", "/time?show=unpaid"))).data.length > 100);
for (const e of costEntries) assert.notEqual((await journal(e.id)).reversed_by_id, null); // every entry of it
assert.equal(Number((await ok(call("GET", "/api/v1/accounts/5200"))).balance_cents), 0);
await settle();
assert.equal((await mt("bulk3")).paid, false);
step("pay run drafted, edited, posted (balanced entry) and reversed; paid in timesheet.io and back");

// Root mode: any record, through ctx.root (kept by Ledger, reversible); the books and timesheet.io are left alone
await ok(m("DELETE", "/billings/999"), 403); // not in root mode
const e1c = (await entryBy((t) => t.id === e1.id)).clearing_entry_id;
await tagAs(e1c, "billed"); // an invoice bills it: locked
await until("e1 is billed", async () => (await entryBy((t) => t.id === e1.id)).billed_tag_entry_id !== null);
await ok(m("PATCH", `/time/${e1.id}`, { description: "x" }), 409);
await ok(m("PATCH", `/time/${e1.id}/root`, { description: "x" }), 403);
assert.equal((await ok(m("GET", "/summary"))).root, false);
await ok(call("POST", "/api/v1/auth/root", { on: true }));
assert.equal((await ok(m("GET", "/summary"))).root, true);
await ok(m("PATCH", `/time/${e1.id}/root`, { description: "Changed in root mode" }));
assert.equal((await entryBy((t) => t.id === e1.id)).description, "Changed in root mode");
await ok(m("DELETE", "/billings/999"), 404);
assert.equal((await journal(e1c)).reversed_by_id, null); // the books are left alone
const run2 = await ok(m("POST", "/pay-runs", { period_start: day(40), period_end: day(0), pay_date: day(0) }), 201);
await ok(m("POST", `/pay-runs/${run2.id}/post`, { paid_from_account: "1000", wages_expense_account: "5200", payroll_liabilities_account: "2300", employer_cost_account: "5210" }));
const benLine = run2.lines.find((l) => l.employee_name === "Ben Okafor");
await ok(m("PATCH", `/pay-runs/${run2.id}/lines/${benLine.id}`, { gross_cents: 1000, deductions_cents: 2000 }), 422);
const fixedRun = await ok(m("PATCH", `/pay-runs/${run2.id}/lines/${benLine.id}`, { gross_cents: 30000 })); // posted, changed in root mode
assert.deepEqual([fixedRun.status, Number(fixedRun.lines.find((l) => l.id === benLine.id).gross_cents)], ["posted", 30000]);
assert.equal((await ok(call("GET", "/api/v1/root/check"))).intact, true);
await ok(m("DELETE", `/pay-runs/${run2.id}`));
await ok(m("GET", `/pay-runs/${run2.id}`), 404);
assert.ok((await ok(m("GET", "/time?show=unpaid"))).data.length > 100); // its hours are unpaid again
const log = await ok(call("GET", "/api/v1/root-actions"));
const logText = JSON.stringify(log);
for (const want of [`deleted posted pay run ${run2.id}`, `changed time entry ${e1.id}`]) assert.ok(logText.includes(want), want);
await ok(call("POST", "/api/v1/auth/root", { on: false }));
assert.equal((await ok(m("GET", "/summary"))).root, false);
step("root mode: billed time changed and a posted pay run deleted, all logged by Ledger");

const sum = await ok(m("GET", "/summary"));
assert.equal(sum.accounts.wages_expense_account, "5200");
assert.equal(JSON.stringify(sum).includes("ts_test"), false);
console.log("All flows passed.");
