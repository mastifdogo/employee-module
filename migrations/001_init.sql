-- Employees module: people, projects, time entries, billings and pay runs.
-- Runs once in the module's own schema (mod_employees). Money is integer cents.

CREATE TABLE employees (
    id                    bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                  text          NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    email                 text          NOT NULL DEFAULT '',
    employee_number       text          NOT NULL DEFAULT '',
    pay_type              text          NOT NULL DEFAULT 'hourly' CHECK (pay_type IN ('hourly', 'salary')),
    -- hourly: pay per hour; salary: pay per pay run
    pay_rate_cents        bigint        NOT NULL DEFAULT 0 CHECK (pay_rate_cents >= 0),
    -- what a customer is charged per hour unless the project or the entry says otherwise
    bill_rate_cents       bigint        NOT NULL DEFAULT 0 CHECK (bill_rate_cents >= 0),
    withholding_percent   numeric(5, 2) NOT NULL DEFAULT 0 CHECK (withholding_percent BETWEEN 0 AND 100),
    employer_cost_percent numeric(5, 2) NOT NULL DEFAULT 0 CHECK (employer_cost_percent BETWEEN 0 AND 100),
    timesheet_user_id     text          UNIQUE,
    is_active             boolean       NOT NULL DEFAULT true,
    notes                 text          NOT NULL DEFAULT '',
    created_by            text          NOT NULL,
    created_at            timestamptz   NOT NULL DEFAULT now(),
    updated_at            timestamptz   NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX employees_name_key ON employees (lower(name));

CREATE TABLE projects (
    id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    -- the customer in Ledger's shared entity list who is billed for this project
    customer_entity_id    bigint,
    bill_rate_cents       bigint      CHECK (bill_rate_cents >= 0),
    timesheet_project_id  text        UNIQUE,
    timesheet_client_name text        NOT NULL DEFAULT '',
    is_active             boolean     NOT NULL DEFAULT true,
    created_by            text        NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE billings (
    id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_entity_id bigint      NOT NULL,
    customer_name      text        NOT NULL,
    period_start       date        NOT NULL,
    period_end         date        NOT NULL,
    billing_date       date        NOT NULL,
    currency           text        NOT NULL CHECK (currency IN ('CAD', 'USD')),
    total_minutes      integer     NOT NULL DEFAULT 0,
    total_cents        bigint      NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    status             text        NOT NULL DEFAULT 'posting' CHECK (status IN ('posting', 'posted', 'reversed')),
    journal_entry_id   bigint,
    created_by         text        NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    reversed_by        text,
    reversed_at        timestamptz
);

CREATE TABLE pay_runs (
    id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    period_start      date        NOT NULL,
    period_end        date        NOT NULL,
    pay_date          date        NOT NULL,
    currency          text        NOT NULL CHECK (currency IN ('CAD', 'USD')),
    status            text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posting', 'posted', 'reversed')),
    paid_from_account text,
    journal_entry_id  bigint,
    created_by        text        NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    posted_by         text,
    posted_at         timestamptz,
    reversed_by       text,
    reversed_at       timestamptz,
    CHECK (period_end >= period_start)
);

CREATE TABLE pay_run_lines (
    id                  bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pay_run_id          bigint  NOT NULL REFERENCES pay_runs (id) ON DELETE CASCADE,
    employee_id         bigint  NOT NULL REFERENCES employees (id),
    employee_name       text    NOT NULL,
    pay_type            text    NOT NULL,
    minutes             integer NOT NULL DEFAULT 0,
    rate_cents          bigint  NOT NULL DEFAULT 0,
    gross_cents         bigint  NOT NULL DEFAULT 0 CHECK (gross_cents >= 0),
    -- withheld from the employee's pay (income tax, pension, insurance)
    deductions_cents    bigint  NOT NULL DEFAULT 0 CHECK (deductions_cents >= 0 AND deductions_cents <= gross_cents),
    -- the employer's own share on top of gross pay
    employer_cost_cents bigint  NOT NULL DEFAULT 0 CHECK (employer_cost_cents >= 0),
    UNIQUE (pay_run_id, employee_id)
);

CREATE TABLE time_entries (
    id                       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id              bigint      NOT NULL REFERENCES employees (id),
    project_id               bigint      REFERENCES projects (id),
    work_date                date        NOT NULL,
    minutes                  integer     NOT NULL CHECK (minutes BETWEEN 1 AND 100000),
    description              text        NOT NULL DEFAULT '',
    billable                 boolean     NOT NULL DEFAULT false,
    -- rate for this entry only; empty = the project's rate, then the employee's
    bill_rate_cents          bigint      CHECK (bill_rate_cents >= 0),
    -- set when the entry is billed
    billing_id               bigint      REFERENCES billings (id),
    billed_rate_cents        bigint,
    billed_amount_cents      bigint,
    -- set when the entry is put on a pay run
    pay_run_id               bigint      REFERENCES pay_runs (id) ON DELETE SET NULL,
    source                   text        NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'timesheet')),
    timesheet_task_id        text        UNIQUE,
    timesheet_last_update_ms bigint,
    created_by               text        NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_date_idx ON time_entries (work_date);
CREATE INDEX time_entries_employee_idx ON time_entries (employee_id, work_date);
CREATE INDEX time_entries_billing_idx ON time_entries (billing_id);
CREATE INDEX time_entries_pay_run_idx ON time_entries (pay_run_id);

CREATE TABLE timesheet_syncs (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    started_by  text        NOT NULL,
    succeeded   boolean,
    summary     text        NOT NULL DEFAULT ''
);
