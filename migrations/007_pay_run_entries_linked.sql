-- Linked entries (Ledger 0.28.0): a posted pay run's entry is linked to its
-- wage-cost entries, so each shows on the other's page in Ledger. Whether
-- that was done for the run; runs posted before are linked at startup.
ALTER TABLE pay_runs ADD COLUMN entries_linked boolean NOT NULL DEFAULT false;
