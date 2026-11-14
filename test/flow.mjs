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
await ok(call("PUT", "/api/v1/modules/employees/settings", { values: { timesheet_api_key: "ts_test.secret123" } }));
assert.equal((await ok(m("POST", "/timesheet/test"))).account, "Ana Silva · ana@example.com");
const s1 = await ok(m("POST", "/timesheet/sync"));
assert.equal(s1.added, 124, s1.summary);
assert.equal(s1.skipped, 1);
assert.equal(s1.employees, 1); // Ben is new; Ana matched by email
assert.equal(s1.projects, 2);
const s2 = await ok(m("POST", "/timesheet/sync"));
assert.deepEqual([s2.added, s2.updated, s2.removed], [0, 0, 0], s2.summary);
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
await ok(m("PATCH", `/time/${t2.id}`, { minutes: 5 }), 409);
await ok(m("DELETE", `/time/${t2.id}`), 409);
step("timesheet.io sync (2 pages, idempotent, matches people by email)");

// Billing
await ok(m("POST", "/billings", { customer_entity_id: acme.id, period_start: day(30), period_end: day(0) }), 422); // no accounts chosen yet
const bill = await ok(m("POST", "/billings", { customer_entity_id: acme.id, period_start: day(30), period_end: day(0), receivable_account: "1200", revenue_account: "4100" }), 201);
assert.equal(bill.total_minutes, 180 + 420 + 120);
assert.equal(bill.total_cents, 12 * 12000);
assert.equal(bill.status, "posted");
const entry = await ok(call("GET", `/api/v1/journal-entries/${bill.journal_entry_id}`));
assert.equal(entry.links[0].ref, `billing:${bill.id}`);
assert.equal(entry.entity?.name, "Acme Corp");
await ok(m("POST", "/billings", { customer_entity_id: acme.id, period_start: day(30), period_end: day(0) }), 422); // nothing left (accounts now remembered)
await ok(m("PATCH", `/time/${t2.id}`, { bill_rate_cents: 1 }), 409);
const globex = await ok(m("POST", "/billings", { customer_entity_id: cust.id, period_start: day(30), period_end: day(0) }), 201);
assert.equal(globex.total_cents, 30000); // 2 h at the project's 150.00
assert.equal((await ok(m("GET", `/billings/${bill.id}`))).lines.length, 3);
step("billable hours billed and posted, linked to the customer");

// A change in timesheet.io after billing is not applied; an unbilled one is
const tasks = await (await fetch(`${mock}/v1/tasks/search`, { method: "POST", headers: { Authorization: "ApiKey ts_test.secret123" }, body: JSON.stringify({ startDate: "2000-01-01", limit: 1000 }) })).json();
const changed = tasks.items.map((t) => (t.id === "t1" ? { ...t, description: "changed", lastUpdate: 2000 } : t.id === "t3" ? { ...t, endDateTime: t.endDateTime.replace("11:30", "12:30"), lastUpdate: 2000 } : t)).filter((t) => t.id !== "bulk0");
await fetch(`${mock}/__tasks`, { method: "POST", body: JSON.stringify(changed) });
const s3 = await ok(m("POST", "/timesheet/sync"));
assert.deepEqual([s3.added, s3.updated, s3.removed, s3.locked], [0, 1, 1, 1], s3.summary);
step("sync leaves billed time alone, updates and removes the rest");

await ok(m("POST", `/billings/${bill.id}/reverse`));
await ok(m("POST", `/billings/${bill.id}/reverse`), 409);
assert.equal((await ok(call("GET", `/api/v1/journal-entries/${bill.journal_entry_id}`))).reversed_by_id !== null, true);
assert.equal((await ok(m("GET", "/time?show=billable"))).data.length, 3);
step("billing reversed; hours billable again");

// Payroll
await ok(m("POST", "/pay-runs", { period_start: "2020-01-01", period_end: "2019-01-01" }), 422);
const run = await ok(m("POST", "/pay-runs", { period_start: day(40), period_end: day(0), pay_date: day(0) }), 201);
const line = (n) => run.lines.find((l) => l.employee_name === n);
// Ana: 2 h manual + 3 h + 7 h + 119 × 0.5 h = 71.5 h at 40.00
assert.equal(line("Ana S.").minutes, 71.5 * 60);
assert.equal(line("Ana S.").gross_cents, 286000);
assert.equal(line("Ana S.").deductions_cents, 30030);
assert.equal(line("Ben Okafor").gross_cents, 4.5 * 5000);
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
await ok(m("POST", `/pay-runs/${run.id}/reverse`));
assert.ok((await ok(m("GET", "/time?show=unpaid"))).data.length > 100);
step("pay run drafted, edited, posted (balanced entry) and reversed");

const sum = await ok(m("GET", "/summary"));
assert.equal(sum.accounts.wages_expense_account, "5200");
assert.equal(JSON.stringify(sum).includes("ts_test"), false);
console.log("All flows passed.");
