-- From 0.12.0 billable hours go to the Billable hours clearing account by themselves: each billable
-- time entry with a customer and a rate keeps one live journal entry there, replaced when the hours
-- change. Being invoiced and paid is read from that entry's shared tags ("billed", "paid").
ALTER TABLE time_entries
    -- none: nothing in the clearing account (clearing_error says why when it is billable);
    -- pending: to post, replace or reverse; posted: clearing_entry_id is live; failed: posting refused
    ADD COLUMN clearing_status   text   NOT NULL DEFAULT 'none' CHECK (clearing_status IN ('none', 'pending', 'posted', 'failed')),
    ADD COLUMN clearing_error    text   NOT NULL DEFAULT '',
    ADD COLUMN clearing_entry_id bigint;
CREATE INDEX time_entries_clearing_entry_idx ON time_entries (clearing_entry_id) WHERE clearing_entry_id IS NOT NULL;
CREATE INDEX time_entries_clearing_todo_idx ON time_entries (clearing_status) WHERE clearing_status IN ('pending', 'failed');

-- Billable hours that aren't billed yet go there on the module's first start.
UPDATE time_entries SET clearing_status = 'pending' WHERE billable AND billing_id IS NULL AND billed_tag_entry_id IS NULL;
