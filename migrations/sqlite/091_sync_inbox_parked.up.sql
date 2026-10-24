-- Events this computer has pulled but cannot apply yet, held here so the pull cursor can move on.
--
-- WHY. Until now a pulled event whose prerequisite had not arrived -- a scan before its carton, a
-- label run before its material -- held the cursor at its position. Every later event in the batch
-- was still applied, but the cursor could not pass the blocked one, the same batch was fetched
-- again on every pass, and once 200 events sat behind it nothing newer was ever fetched. Raw
-- material arrivals WAIT for their master data (owner decision 2026-10-23), so one material created
-- on another computer would eventually have frozen all replication into this one (docs/37 3.1).
--
-- WHAT CHANGES. A waiting event is parked here, with why, and counts as settled for the cursor. It
-- is retried with a widening backoff, and at once whenever a pull applies something new -- which
-- may be exactly what it was waiting for. It leaves this table only by being applied, or by being
-- refused permanently, which is reported like any other refusal.
--
-- envelope_json is the event exactly as it arrived, read back through the same boundary check as a
-- fresh one (isSyncEnvelope), so a parked event is never trusted more than a new one.
-- next_try_at is epoch milliseconds, the unit the puller's clock already uses.
--
-- PER-COMPUTER STATE, like sync_outbox: on the replication exclusion list, never sent, and cleared
-- when the computer moves to another project, because a parked event belongs to that project's log.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS sync_inbox_parked (
  dedupe_key TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  envelope_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  parked_at TEXT NOT NULL,
  next_try_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_inbox_parked_next_try ON sync_inbox_parked(next_try_at);
