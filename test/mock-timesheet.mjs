// A stand-in for api.timesheet.io for local tests: node test/mock-timesheet.mjs [port]
// Point the module at it with TIMESHEET_API_URL=http://127.0.0.1:<port>.
// POST /__tasks replaces the task list.
import { createServer } from "node:http";

const KEY = "ts_test.secret123";
const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const member = (uid, first, last, email) => ({ uid, firstname: first, lastname: last, email, displayName: `${first} ${last}` });
const ana = member("u-ana", "Ana", "Silva", "ana@example.com");
const ben = member("u-ben", "Ben", "Okafor", "ben@example.com");
const web = { id: "p-web", title: "Website rebuild", employer: "Acme Corp", salary: "120.00" };
const ops = { id: "p-ops", title: "Internal ops", employer: "", salary: "0" };
const task = (id, m, project, d, from, to, extra = {}) => ({
	id, user: m.uid, member: m, project, typeId: 0, running: false, deleted: false, billable: project === web, description: `Task ${id}`,
	startDateTime: `${day(d)}T${from}:00+02:00`, endDateTime: `${day(d)}T${to}:00+02:00`, duration: 0, durationBreak: 0, lastUpdate: 1000, ...extra,
});
let tasks = [
	task("t1", ana, web, 3, "09:00", "12:00"),
	task("t2", ana, web, 2, "09:00", "17:00", { durationBreak: 3600 }), // 7 h
	task("t3", ben, ops, 2, "10:00", "11:30"),
	task("t4", ben, web, 1, "13:00", "15:00"),
	task("t5", ben, web, 0, "08:00", "09:00", { running: true, endDateTime: undefined }),
	...Array.from({ length: 120 }, (_, i) => task(`bulk${i}`, ana, ops, 5 + (i % 20), "06:00", "06:30")), // forces a second page
];

createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const json = (status, v) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
		if (req.url === "/__tasks") return (tasks = JSON.parse(body)), json(200, { count: tasks.length });
		if (req.headers.authorization !== `ApiKey ${KEY}`) return json(401, { message: "unauthorized" });
		if (req.method === "GET" && req.url === "/v1/profiles/me") return json(200, { user: "u-ana", email: "ana@example.com", displayName: "Ana Silva" });
		if (req.method === "POST" && req.url === "/v1/tasks/search") {
			const p = JSON.parse(body || "{}");
			const all = tasks.filter((t) => t.startDateTime.slice(0, 10) >= p.startDate);
			const limit = p.limit ?? 25;
			const page = p.page ?? 1;
			return json(200, { items: all.slice((page - 1) * limit, page * limit), params: { page, limit, count: all.length } });
		}
		json(404, { message: "not found" });
	});
}).listen(Number(process.argv[2]) || 8099, "127.0.0.1");
