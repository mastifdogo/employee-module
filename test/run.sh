#!/bin/sh
# Checks the module in a real Ledger and runs the end-to-end flows.
#   LEDGER_DIR=<Ledger checkout> TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres sh test/run.sh
# LEDGER_PORT (8098) and MOCK_PORT (8099) choose other ports.
set -eu
cd "$(dirname "$0")/.."
: "${LEDGER_DIR:=/tmp/ledger-for-modules}"
: "${TEST_DATABASE_URL:=postgres://postgres:postgres@127.0.0.1:5432/postgres}"
: "${LEDGER_PORT:=8098}"
: "${MOCK_PORT:=8099}"
export TEST_DATABASE_URL TIMESHEET_API_URL="http://127.0.0.1:$MOCK_PORT"
log=$(mktemp)
node test/mock-timesheet.mjs "$MOCK_PORT" &
mock=$!
node "$LEDGER_DIR/.claude/skills/ledger-module/scripts/check-module.ts" . --serve "$LEDGER_PORT" >"$log" 2>&1 &
ledger=$!
# The checker's scratch database is named after its process: the flows that need a look inside
# (pay runs posted while another request settles them) reach it with psql, and are skipped without it.
case "$TEST_DATABASE_URL" in *\?*) scratch= ;; *) scratch="${TEST_DATABASE_URL%/*}/ledger_modcheck_$ledger" ;; esac
trap 'kill -INT $ledger 2>/dev/null || true; kill $mock 2>/dev/null || true; wait 2>/dev/null || true; rm -f "$log"' EXIT
for _ in $(seq 60); do
	grep -q "ledger_session=" "$log" && break
	kill -0 $ledger 2>/dev/null || { cat "$log"; exit 1; }
	sleep 1
done
cat "$log"
grep -q "All checks passed" "$log"
node test/flow.mjs "http://127.0.0.1:$LEDGER_PORT" "$(grep -o 'ledger_session=[^ ]*' "$log" | cut -d= -f2)" "http://127.0.0.1:$MOCK_PORT" "$scratch"
