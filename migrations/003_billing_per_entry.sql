-- From 0.4.0 each billed time entry posts its own journal entry (tagged "Billed", with the
-- customer on it). Billings made before keep their one entry in billings.journal_entry_id.
ALTER TABLE time_entries ADD COLUMN billing_journal_entry_id bigint;
