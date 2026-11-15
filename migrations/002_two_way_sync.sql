-- Two-way timesheet.io sync: what each time entry still has to send, and deletions to send.
ALTER TABLE time_entries
    -- synced: timesheet.io has what Ledger has; pending: to send; failed: timesheet.io refused it;
    -- ledger_only: can't be sent (push_error says why: no timesheet.io project or person)
    ADD COLUMN push_status             text        NOT NULL DEFAULT 'synced' CHECK (push_status IN ('synced', 'pending', 'failed', 'ledger_only')),
    ADD COLUMN push_error              text        NOT NULL DEFAULT '',
    ADD COLUMN pushed_at               timestamptz,
    -- the timesheet.io person the task belongs to, and its start and end as timesheet.io has them
    ADD COLUMN timesheet_task_user_id  text,
    ADD COLUMN timesheet_start         text,
    ADD COLUMN timesheet_end           text,
    ADD COLUMN timesheet_break_seconds integer     NOT NULL DEFAULT 0;
CREATE INDEX time_entries_push_idx ON time_entries (push_status) WHERE push_status <> 'synced';

CREATE TABLE timesheet_deletions (
    task_id      text        PRIMARY KEY,
    requested_by text        NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    last_error   text        NOT NULL DEFAULT ''
);

-- Send hand-entered time, and the billed and paid state of settled time, on the next sync.
UPDATE time_entries SET push_status = 'pending' WHERE source = 'manual' OR billing_id IS NOT NULL OR pay_run_id IS NOT NULL;
