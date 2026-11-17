-- Ledger 0.23.0: tags on journal entries shared by Ledger and every module ("billed", "paid",
-- "customer", ...). A tag belongs to the entry, so anyone can set or remove it; these columns are
-- where the module remembers what the tags say.
ALTER TABLE time_entries
    -- the shared tags "billed" and "customer" were put on billing_journal_entry_id (false: still to do)
    ADD COLUMN billing_tagged      boolean NOT NULL DEFAULT false,
    -- billing_journal_entry_id carries the shared tag "paid" (set by Sales or a person, never here)
    ADD COLUMN billing_paid        boolean NOT NULL DEFAULT false,
    -- hours not billed here whose journal entry was tagged "billed" by another module or a person:
    -- that entry. They are not offered for billing until the tag is taken off again.
    ADD COLUMN billed_tag_entry_id bigint;
-- The same for the one journal entry of a billing made before 0.4.0 (billings.journal_entry_id).
ALTER TABLE billings
    ADD COLUMN entry_tagged boolean NOT NULL DEFAULT false,
    ADD COLUMN entry_paid   boolean NOT NULL DEFAULT false;
CREATE INDEX time_entries_billing_entry_idx ON time_entries (billing_journal_entry_id) WHERE billing_journal_entry_id IS NOT NULL;
CREATE INDEX time_entries_billed_tag_idx ON time_entries (billed_tag_entry_id) WHERE billed_tag_entry_id IS NOT NULL;
