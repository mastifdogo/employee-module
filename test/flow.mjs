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

// Billing
await ok(call("GET", `/api/v1/accounts/${BILLABLE}`), 404); // no clearing account yet: billing makes it
const bill = await ok(m("POST", "/billings", { customer_entity_id: acme.id, period_start: day(30), period_end: day(0) }), 201);
assert.equal(bill.total_minutes, 180 + 420 + 120);
assert.equal(bill.total_cents, 12 * 12000);
assert.equal(bill.status, "posted");
assert.equal(bill.journal_entry_id, null); // one journal entry per time entry, not one per billing
const billedT2 = await entryBy((t) => t.id === t2.id);
assert.ok(billedT2.billing_journal_entry_id);
const entry = await ok(call("GET", `/api/v1/journal-entries/${billedT2.billing_journal_entry_id}`));
assert.equal(entry.entity?.name, "Acme Corp");
assert.deepEqual(entry.lines.map((l) => [l.account_code, Number(l.debit_cents), Number(l.credit_cents)]), [[BILLABLE, 84000, 0], [BILLABLE, 0, 84000]]); // 7 h at 120.00, debit and offset in the clearing account
const billAcct = await ok(call("GET", `/api/v1/accounts/${BILLABLE}`));
assert.deepEqual([billAcct.name, billAcct.type, billAcct.kind, billAcct.currency, Number(billAcct.balance_cents)], ["Billable hours", "asset", "clearing", "CAD", 0]);
assert.equal(Number((await ok(call("GET", "/api/v1/accounts/4100"))).balance_cents), 0); // nothing is revenue yet
assert.equal((await ok(m("GET", "/summary"))).billable_hours.code, BILLABLE);
assert.equal(entry.lines[0].memo, `${day(2)} · Ana S. · 7.00 h × 120.00 · Website rebuild: Edited in Ledger`);
const acmeItems = await salesItems(acme.id);
assert.deepEqual(acmeItems.map((i) => i.cents).sort(), [24000, 36000, 84000]); // one item per time entry, for Sales to invoice
assert.deepEqual(entry.links.map((l) => [l.module_id, l.ref, l.label]).sort(), [["employees", "billed", "Billed"], ["employees", `time:${t2.id}`, `Hours ${day(2)} · Ana S. · 7.00 h`]]);
await ok(m("POST", "/billings", { customer_entity_id: acme.id, period_start: day(30), period_end: day(0) }), 422); // nothing left (accounts now remembered)
await ok(m("PATCH", `/time/${t2.id}`, { bill_rate_cents: 1 }), 409);
const globex = await ok(m("POST", "/billings", { customer_entity_id: cust.id, period_start: day(30), period_end: day(0) }), 201);
assert.equal(globex.total_cents, 30000); // 2 h at the project's 150.00
assert.deepEqual(await salesItems(cust.id), [{ memo: `${day(4)} · Ana S. · 2.00 h × 150.00 · Audit: Review`, cents: 30000 }]);
assert.equal((await ok(m("GET", `/billings/${bill.id}`))).lines.length, 3);
await settle();
for (const id of ["t1", "t2", "t4"]) assert.equal((await mt(id)).billed, true, id);
assert.equal((await mt("t3")).billed, false);
step("billable hours billed and posted, linked to the customer; billed in timesheet.io");

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
assert.equal((await mt("t1")).description, "Task t1"); // billed here: Ledger's version sent back
assert.equal((await mt("bulk9")).description, "Ledger wins");
assert.equal((await entryBy((t) => t.description === "Task t3")).minutes, 150); // only changed there: taken
step("changed in both places: Ledger wins; changed only in timesheet.io: taken");

await ok(m("POST", `/billings/${bill.id}/reverse`));
await ok(m("POST", `/billings/${bill.id}/reverse`), 409);
assert.notEqual((await ok(call("GET", `/api/v1/journal-entries/${billedT2.billing_journal_entry_id}`))).reversed_by_id, null);
assert.equal((await ok(m("GET", "/time?show=billable"))).data.length, 3);
await settle();
assert.equal((await mt("t1")).billed, false);
assert.equal((await ok(call("GET", `/api/v1/journal-entries/${billedT2.billing_journal_entry_id}`))).links.some((l) => l.ref === "billed"), false); // reversed: no longer tagged Billed
assert.deepEqual(await salesItems(acme.id), []); // reversed: no longer offered for invoicing
step("billing reversed; hours billable again, and not billed in timesheet.io");

// Batch: bill chosen time entries at once; what can't be billed is skipped with the reason
const pick = await Promise.all(["Task t1", "Edited in Ledger", "Task t4", "Task t3"].map((d) => entryBy((t) => t.description === d)));
await ok(m("POST", "/billings/batch", { entry_ids: [] }), 422);
await ok(m("POST", "/billings/batch", { entry_ids: [pick[3].id] }), 422); // t3 isn't billable: nothing to bill
const batch = await ok(m("POST", "/billings/batch", { entry_ids: pick.map((t) => t.id), billing_date: day(0) }), 201);
assert.equal(batch.billed, 3);
assert.equal(batch.total_cents, 12 * 12000);
assert.equal(batch.billings.length, 1); // one customer
assert.deepEqual(batch.skipped.map((x) => [x.id, x.reason]), [[pick[3].id, "not billable"]]);
await ok(m("POST", "/billings/batch", { entry_ids: [pick[0].id] }), 422); // already billed
const batchT1 = await entryBy((t) => t.id === pick[0].id);
assert.ok((await ok(call("GET", `/api/v1/journal-entries/${batchT1.billing_journal_entry_id}`))).links.some((l) => l.ref === "billed" && l.label === "Billed"));
// Batch unbill: those entries' transactions are reversed and lose the tag; the billing keeps the rest
const unb = await ok(m("POST", "/billed/unbill", { entry_ids: [pick[1].id, pick[3].id] }));
assert.deepEqual([unb.unbilled, unb.skipped.length], [1, 1]);
const reversed = await ok(call("GET", `/api/v1/journal-entries/${(await entryBy((t) => t.id === pick[0].id)).billing_journal_entry_id}`));
assert.equal(reversed.reversed_by_id, null); // t1 is still billed
const left = await ok(m("GET", `/billings/${batch.billings[0].id}`));
assert.deepEqual([left.lines.length, Number(left.total_cents), left.status], [2, 5 * 12000, "posted"]);
await ok(m("POST", "/billed/unbill", { entry_ids: [pick[0].id, pick[2].id] }));
assert.equal((await ok(m("GET", `/billings/${batch.billings[0].id}`))).status, "reversed"); // nothing left on it
assert.equal((await ok(m("GET", "/time?show=billable"))).data.length, 3);
step("batch billing and batch unbill, one tagged transaction per time entry");

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
const pe = await ok(call("GET", `/api/v1/journal-entries/${posted.journal_entry_id}`));
const amt = (code, side) => Number(pe.lines.find((l) => l.account_code === code)[side]);
assert.equal(amt("5200", "debit_cents"), Number(edited.gross_cents));
assert.equal(amt("5210", "debit_cents"), 15000);
assert.equal(amt("2300", "credit_cents"), Number(edited.deductions_cents) + 15000);
assert.equal(amt("1000", "credit_cents"), Number(edited.net_cents));
await ok(m("POST", `/pay-runs/${run.id}/post`, { paid_from_account: "1000" }), 409);
await ok(m("DELETE", `/pay-runs/${run.id}`), 409);
assert.equal((await ok(m("GET", "/time?show=unpaid"))).data.length, 0);
await settle();
assert.equal((await mt("bulk3")).paid, true);
assert.equal(made.id && (await mt(made.id)).paid, true);
await ok(m("POST", `/pay-runs/${run.id}/reverse`));
assert.ok((await ok(m("GET", "/time?show=unpaid"))).data.length > 100);
await settle();
assert.equal((await mt("bulk3")).paid, false);
step("pay run drafted, edited, posted (balanced entry) and reversed; paid in timesheet.io and back");

const sum = await ok(m("GET", "/summary"));
assert.equal(sum.accounts.wages_expense_account, "5200");
assert.equal(JSON.stringify(sum).includes("ts_test"), false);
console.log("All flows passed.");
