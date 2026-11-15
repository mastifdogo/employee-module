# Employees

Track employee time, bill customers for billable hours and run payroll, with
time pulled from [timesheet.io](https://timesheet.io) through its API.

A module for [Ledger](https://github.com/mastifdogo/Bookeeping) (0.16.0 or
newer). Install it under **Settings → Modules** by entering this repository's
`owner/name`.

## What it does

- **Time**: time entries per employee, day and project, added by hand or
  pulled from timesheet.io. Each can be billable.
- **Calendar**: a month of hours worked per day, for everyone or one
  employee. Scroll up or down in it to move through the months; click a day
  to open its time entries.
- **Billable hours**: unbilled billable hours grouped by customer. *Bill*
  posts one journal entry (debit accounts receivable, credit revenue) tagged
  with the customer, marks the hours billed and offers them as a CSV for the
  invoice. A billing can be reversed, which makes the hours billable again.
- **Payroll**: a pay run takes every hour in a period that isn't on a pay run
  yet (hourly employees) plus one period's pay for each salaried employee.
  You review the draft, correct gross pay, deductions and employer cost per
  person, then post it as one journal entry:

  | | Debit | Credit |
  |---|---|---|
  | Wages expense | gross pay | |
  | Employer payroll cost | employer's share | |
  | Payroll liabilities | | deductions + employer's share |
  | The account pay comes from | | net pay |

  A posted pay run can be reversed; its hours go back to unpaid.
- **People**: employees (hourly or salary, pay rate, billing rate, the
  percentages a pay run starts from) and projects (the customer they are
  billed to and an hourly rate). Customers are Ledger's shared **Entities**.
- Employees can be imported from a CSV under Settings → Employees, and found
  with Ledger's search.

**Payroll taxes are not calculated.** Deductions and the employer's share
start as a percentage you set on each employee and are yours to correct on
every pay run. Use your payroll provider's or tax authority's figures.

## timesheet.io

1. In timesheet.io open **my.timesheet.io → Development → API keys**
   (<https://my.timesheet.io/development/apikeys>) and create a key
   (`ts_xxxx.yyyy`).
2. In Ledger, an admin pastes it under **Settings → Employees → timesheet.io
   API key**. It is stored as a secret and never shown again.
3. Ledger and timesheet.io are then synced:
   - each time someone signs in to Ledger (a setting, on by default; it runs
     within about 15 seconds of the sign-in, for the organization signed in to);
   - with the **Sync** button beside the title of the Employees page;
   - every hour, if you turn that setting on;
   - and a change made in Ledger is sent right away.

   Connection status, the last sync, what is waiting to be sent and *Test the
   connection* are on the settings page, below the form.

The sync goes both ways.

**From timesheet.io** (the tasks of the last 60 days, a setting):

- each person is matched to an employee by email, or added as a new employee
  with no pay rate (a dashboard to-do asks for it);
- each project is added with its hourly rate; its client is matched to a
  customer already in Entities with the same name, otherwise you choose one;
- each finished task becomes a time entry: its length minus its breaks, on the
  day it started, billable or not as in timesheet.io. Running timers, mileage
  and calls are left out;
- edits and deletions made in timesheet.io are applied (but see *Ledger wins*).

**To timesheet.io**:

- time entered in Ledger becomes a task for that person and project, starting
  at 9:00 in the time zone set under Settings (UTC when empty). It needs a
  project that came from timesheet.io and a person linked to timesheet.io
  (linked by email once they track time there); otherwise it stays in Ledger
  only, and the Time tab says why. Moving an entry to another person deletes
  the task and makes it again under them, since timesheet.io can't change a
  task's owner;
- edits and deletions made in Ledger are sent, including to entries that came
  from timesheet.io. A task keeps its time of day and breaks; only the day and
  the end move when you change them;
- billing hours marks their tasks **billed**, posting a pay run marks them
  **paid**, and reversing either undoes it.

**Ledger wins.** A change made in Ledger that isn't sent yet, and any hours that
are billed or on a pay run, are never overwritten from timesheet.io: Ledger's
version is sent back (a task deleted there is made again). A change made only in
timesheet.io is taken as usual. A change timesheet.io refuses shows as *not
sent* on the Time tab and on the dashboard, and is tried again on each sync.

Ledger calls timesheet.io; it doesn't receive timesheet.io webhooks, because
every Ledger module route needs a logged-in Ledger user. The syncs above do
that job.

## Settings

Currency (CAD or USD) for all rates, billings and pay runs; the five account
codes used when posting (each can also be picked, or created, in the dialog
that posts, and the first choice is remembered); the timesheet.io key, time zone,
days to pull, and when to sync (on sign-in, hourly).

Rates: an hour is billed at the entry's own rate if it has one, else the
project's, else the employee's.

## Testing

```sh
npm test    # nothing to install; needs a Ledger checkout and PostgreSQL, see test/run.sh
```

`test/run.sh` runs Ledger's module checker, serves the module in a real Ledger
on a scratch database with `test/mock-timesheet.mjs` standing in for
timesheet.io (`TIMESHEET_API_URL`), and runs `test/flow.mjs` through time,
sync, billing and payroll.

## Releasing

1. Bump `version` in `ledger-module.json`.
2. Commit and push to `main`. The Release workflow
   (`.github/workflows/release.yml`) tags `v<version>` and publishes a
   GitHub Release when that version isn't released yet. Ledger installs the
   latest release.
