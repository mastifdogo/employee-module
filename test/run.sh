#!/bin/sh
# Checks the module in a real Ledger and runs the end-to-end flows.
#   LEDGER_DIR=<Ledger checkout> TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres sh test/run.sh
set -eu
cd "$(dirname "$0")/.."
: "${LEDGER_DIR:=/tmp/ledger-for-modules}"
: "${TEST_DATABASE_URL:=postgres://postgres:postgres@127.0.0.1:5432/postgres}"
export TEST_DATABASE_URL TIMESHEET_API_URL=http://127.0.0.1:8099
log=$(mktemp)
node test/mock-timesheet.mjs 8099 &
mock=$!
node "$LEDGER_DIR/.claude/skills/ledger-module/scripts/check-module.ts" . --serve 8098 >"$log" 2>&1 &
ledger=$!
trap 'kill -INT $ledger 2>/dev/null; kill $mock 2>/dev/null; wait 2>/dev/null; rm -f "$log"' EXIT
for _ in $(seq 60); do
	grep -q "ledger_session=" "$log" && break
	kill -0 $ledger 2>/dev/null || { cat "$log"; exit 1; }
	sleep 1
done
cat "$log"
grep -q "All checks passed" "$log"
node test/flow.mjs http://127.0.0.1:8098 "$(grep -o 'ledger_session=[^ ]*' "$log" | cut -d= -f2)" http://127.0.0.1:8099
