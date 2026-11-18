-- When posting a pay run began (set when it is claimed for posting, cleared when it is a draft again).
-- A posting the server didn't finish is told by this, not by when the draft was made: a draft from
-- yesterday that is being posted right now is not stuck. It also says which posting holds the run,
-- so one that was given up on can't mark the run posted afterwards.
ALTER TABLE pay_runs ADD COLUMN posting_at timestamptz;
