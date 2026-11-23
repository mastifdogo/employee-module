# Employees

Track employee time, bill customers for billable hours and run payroll, with
time pulled from [timesheet.io](https://timesheet.io) through its API.

A module for [Ledger](https://github.com/mastifdogo/Bookeeping) (0.35.4 or
newer). Install it under **Settings → Modules** by entering this repository's
`owner/name`.

## What it does

- **Time**: time entries per employee, day and project, added by hand or
  pulled from timesheet.io. Each can be billable.
- **Calendar**: a month of hours worked per day. Filter it by employee,
  customer, project and kind of hours (billable, not billable, billable but
  not billed, billed, not on a pay run). Scroll up or down in it to move
  through the months; click a day to open its time entries.
- **Billable hours go to the books by themselves** (no Billable hours tab
  since 0.12.0): every billable time entry with a customer (its project's) and
  a billing rate is one transaction in the module's *Billable hours* clearing
  account, tagged with the **customer**, **employee** and **project**, and
  with **the employee's name** as a tag of its own (`ana-silva` for Ana
  Silva: Ledger's tags are lowercase words). Change
  the hours and that transaction is reversed and a new one posted; make them
  not billable and it is reversed. Nothing is revenue until the hours are
  invoiced: Sales offers each one as a billable item, and the **billed** tag it
  puts on the transaction marks the hours billed here (and locks them); a
  **paid** tag marks them paid. See *Invoicing billed hours* below.
- **Payroll**: a pay run takes every hour in a period that isn't on a pay run
  yet (hourly employees) plus one period's pay for each salaried employee,
  for everyone or only the employees you tick (their hours left out stay
  unpaid for a later run).
  You review the draft, correct gross pay, deductions and employer cost per
  person, then post it. **Its cost is split by project**: one entry per
  project, tagged with the **project** and its **customer** (hourly pay split
  by the hours on the run; salaries and hours without a project together),
  booked through the *Wages payable* clearing account, which the pay run's own
  entry then clears:

  | Entry | Debit | Credit |
  |---|---|---|
  | One per project | Wages expense (gross pay), Employer payroll cost (employer's share) | Wages payable (clearing) |
  | The pay run's | Wages payable (clearing) | Payroll liabilities (deductions + employer's share), the account pay comes from (net pay) |

  The pay run's page shows the cost by project before you post. A posted pay
  run can be reversed: all its entries are, and its hours go back to unpaid.
  If the server stops while a pay run is being posted, the next time a
  bookkeeper or admin opens Pay runs (2 minutes after the posting began, at
  the earliest) what it had put in the books is reversed and the run is a
  draft again, to be posted once more.
- **People**: employees (hourly or salary, pay rate, billing rate, the
  percentages a pay run starts from) and projects (the customer they are
  billed to and an hourly rate). Customers are Ledger's shared **Entities**.
- Employees can be imported from a CSV under Settings → Employees, and found
  with Ledger's search.

**Payroll taxes are not calculated.** Deductions and the employer's share
start as a percentage you set on each employee and are yours to correct on
every pay run. Use your payroll provider's or tax authority's figures.

## Root mode

In Ledger's root mode (Ledger ≥ 0.21.1, admins only) the page shows red
**Root** buttons that reach records the module normally protects: edit or
delete a billed or paid time entry, delete any pay run or older billing (its hours
become billable or unpaid again), and change the amounts of a posted pay
run. Ledger keeps everything these change and can put it back from Settings →
Root log. They change only the module's records: journal entries stay in the
books (delete those on the entry's page) and nothing is sent to timesheet.io.
Root mode can't be left while a posted pay run has no lines or time sits on a
reversed billing or pay run.

## Invoicing billed hours

Ledger makes the module's **clearing account** *Billable hours* the first
time billable hours come in (code `CLR-EMPLOYEES-BILLABLE` unless someone
renumbers it). Every billable time entry is one journal entry in it, with the
customer as the entry's entity: a **debit** (the billable item) and an
**equal credit**, so the account stays at zero and **nothing is revenue until
the hours are invoiced**. In the **Sales** module:

1. Under **Settings → Sales → Accounts → Billable costs**, add the
   *Billable hours* clearing account.
2. On a customer's new invoice, **+ Billable items** lists their hours, one
   per time entry (date, person, hours × rate, project and task); tick them
   and add them as one line or each as its own line.
3. Give those invoice lines your usual revenue category: the invoice posts
   the revenue (and the receivable) then.

When the invoice is issued, Sales tags the hours' transactions **billed**:
the hours show *billed* here, can't be changed, and are billed in
timesheet.io. Voiding the invoice takes the tag off and frees them.

Any other module finds the hours the same way, without reading this module's
tables:

- the debit lines of the clearing account
  (`ctx.ledger.listJournalEntries({ accountCode })`), on entries neither
  reversed nor reversals;
- the customer is the entry's `entity`, and the shared tags say the rest:
  `customer` (entity), `employee` and `project` (note: the name), and
  `billed` / `paid` once someone sets them;
- the link `{ ref: "time:<id>" }` names the time entry; the reference is
  `HOURS-<time entry id>`; the debit line's memo is the item:
  `2026-11-12 · Ana Silva · 7.00 h × 120.00 · Website rebuild: Task t2`.

**Billings made before 0.12.0 stay as they were**, billed (0.11.0 tagged them
`billed` itself; 0.6.0 to 0.8.0 posted to a *Billable hours* account the module
made, usually 1250, which stays in Sales' billable costs until those hours are
invoiced). Their hours show *billed* on the Time tab; a journal entry's link
still opens the billing.

## Tags

The module uses the tags on journal entries that Ledger shares between itself
and every module (Ledger ≥ 0.23.0).

- **What it sets.** On each billable hours transaction: `customer` (the
  project's customer), `employee` and `project` (the names, as notes), and
  the employee's name as a tag (lowercase, words joined by `-`, e.g.
  `ana-silva`; prefixed `employee-` when it would clash with a standard tag
  or doesn't start with a letter). On each
  of a pay run's cost entries: `project` and its `customer`. When a
  transaction is replaced, its tags come off the old one.
- **What it follows.** A tag belongs to the transaction, so Sales, another
  module or a person can set or remove it, and the hours follow. Nothing is
  posted or reversed because of a tag.
  - `billed` on an hours transaction: the hours are billed and locked here
    (and billed in timesheet.io); taken off, they are open again.
  - `paid` on it: the hours show *paid* (and are paid in timesheet.io);
    taken off, they aren't.
  - On a billing from before 0.12.0: `paid` shows on the billing, and
    `billed` taken off frees its hours as before.

  Since 0.13.0 a `billed` or `paid` tag set or taken off is sent to
  timesheet.io straight away, not at the next sync. Tags changed while Ledger
  was down are read again when the module starts, and sent then.

## Linked entries

On Ledger 0.28.0 and later, a posted pay run's journal entry is linked to its
wage-cost entries (one per project), so opening any of them in Ledger shows
the others. Pay runs posted before are linked when the module next starts.
Billable hours show with the invoice that bills them once Sales (0.21.0)
links them. The old entry link "Billed" on billings from before 0.4.0 is
taken off there: Ledger would show every such billing as linked to the
others, and the tag "billed" already says it.

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
  and calls are left out; a task that is running again keeps the hours Ledger
  already has for it until it is finished;
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
- the shared tags go back to timesheet.io as soon as they change: a `billed`
  tag on the hours' transaction (Sales invoicing them, or a person) marks
  their task **billed**, a `paid` tag (the customer paid) marks it **paid**,
  and taking either off undoes it. Billing hours here marks them billed and
  posting a pay run marks them paid as well, and reversing either undoes it.

**Ledger wins.** A change made in Ledger that isn't sent yet, and any hours that
are billed or on a pay run, are never overwritten from timesheet.io: Ledger's
version is sent back (a task deleted there is made again). A change made only in
timesheet.io is taken as usual. A change timesheet.io refuses shows as *not
sent* on the Time tab and on the dashboard, and is tried again on each sync.

Ledger calls timesheet.io; it doesn't receive timesheet.io webhooks, because
every Ledger module route needs a logged-in Ledger user. The syncs above do
that job.

## Settings

**Settings → Employees** has three tabs (accounts are chosen from a list since 0.7.0, which needs Ledger 0.19.8):

- **Payroll**: the currency (CAD or USD) for all rates, billings and pay
  runs, and the three accounts pay runs are posted to.
- **Billing hours**: where billed hours are recorded (the module's clearing
  account) and how to let Sales invoice them; nothing to fill in.
- **timesheet.io**: the API key, time zone, days to pull, when to sync (on
  sign-in, hourly), and the connection's status with Sync now.

Each payroll account can also be picked, or created, in the dialog that
posts, and the first choice is remembered.

Rates: an hour is billed at the entry's own rate if it has one, else the
project's, else the employee's.

## Testing

```sh
npm test    # nothing to install; needs a Ledger checkout and PostgreSQL, see test/run.sh
```

`test/run.sh` runs Ledger's module checker, serves the module in a real Ledger
on a scratch database with `test/mock-timesheet.mjs` standing in for
timesheet.io (`TIMESHEET_API_URL`), and runs `test/flow.mjs` through time,
sync, billing, tags and payroll. `LEDGER_DIR` is the Ledger checkout;
`LEDGER_PORT` (8098) and `MOCK_PORT` (8099) choose other ports. With `psql`
installed it also posts pay runs while another request loads Pay runs (the
test reaches into the scratch database to age a draft and to make a posting
look hung); without it that part is skipped.

## Releasing

1. Bump `version` in `ledger-module.json`.
2. Commit and push to `main`. The Release workflow
   (`.github/workflows/release.yml`) tags `v<version>` and publishes a
   GitHub Release when that version isn't released yet. Ledger installs the
   latest release.
