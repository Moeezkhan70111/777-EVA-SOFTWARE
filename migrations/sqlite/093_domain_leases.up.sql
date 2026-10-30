-- This computer learns who holds each write lease, and stamps its leased work with the lease epoch.
--
-- WHY. Under the single-writer model (docs/37 section W) one computer holds each domain's write
-- lease and every other computer reads it. The cloud refuses a leased push from anyone else, under
-- any other epoch (cloud migration 011). This computer needs two things locally to take part:
--
--   sync_domain_leases   the last answer the cloud gave to "who holds what". Read by the local
--                        write gate, which refuses a leased write unless this computer holds that
--                        domain and has caught up past the previous holder's last write. Read
--                        offline too: the holder may keep writing while the cloud is unreachable.
--
--   sync_outbox.lease_epoch  the lease epoch a leased event was written under, stamped in the same
--                        insert that queues it. The cloud accepts the event only while that epoch
--                        is still this computer's lease. Null for carton flows, which are not
--                        leased, and for leased work queued before this computer knew its lease --
--                        such rows are never sent as they are (the backfill decides them).
--
-- PER-COMPUTER STATE, NEVER REPLICATED. The cache is rewritten whole on every successful fetch,
-- and is tied to the cloud project it came from, exactly as the pull cursor is: a lease granted on
-- the test project must never authorise a write meant for production.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS sync_domain_leases (
  domain TEXT PRIMARY KEY,
  holder_device_id TEXT,
  holder_label TEXT,
  epoch INTEGER NOT NULL,
  barrier_seq INTEGER NOT NULL DEFAULT 0,
  granted_at TEXT,
  project_key TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  CHECK (epoch >= 0),
  CHECK (barrier_seq >= 0)
);

ALTER TABLE sync_outbox ADD COLUMN lease_epoch INTEGER;
