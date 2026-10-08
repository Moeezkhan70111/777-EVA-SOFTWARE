-- The delivery proof: the builty photo that is what makes a Gatepass DELIVERED.
--
-- The journey's last step is the only one with nothing in the database to stand on. Issued,
-- billed, at the gate and dispatched are all consequences of records that already exist (a
-- bill, a scan, an event). Delivered is a photo someone took on the road, so it needs a row
-- of its own - and because the status may never say DELIVERED without one, that row and the
-- status change are written in the same transaction.
--
-- The file itself lives beside the product images, under the application's own data root,
-- with a name this application generates. What a user picked the file as is kept only as a
-- label (original_name) - it is never a path, and never trusted.
--
-- Replacement keeps history rather than overwriting it: a replaced proof stays as a row with
-- is_current = 0 and its replaced_at filled in, so what was shown as proof before, and when
-- it stopped being the proof, are both still answerable. No second history table.
--
-- The partial unique index is what makes "exactly one current proof" a database fact rather
-- than a promise from application code - the same technique as idx_sale_vouchers_gatepass_live
-- in migration 031. Additive only: no existing row or status is touched.
-- (No semicolons in comments: the migration runner splits statements on them.)

CREATE TABLE IF NOT EXISTS gatepass_delivery_proofs (
  id TEXT PRIMARY KEY,
  gatepass_id TEXT NOT NULL,
  /* The name inside the application's own proof store. Generated here, never user-supplied. */
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  /* What the operator called the file, kept only to show them. Never used as a path. */
  original_name TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL,
  /* When this proof stopped being the current one, for a replaced row. */
  replaced_at TEXT,
  FOREIGN KEY (gatepass_id) REFERENCES gatepasses(id),
  CHECK (byte_size > 0),
  CHECK (is_current IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_gatepass_delivery_proofs_current
  ON gatepass_delivery_proofs(gatepass_id) WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_gatepass_delivery_proofs_gatepass
  ON gatepass_delivery_proofs(gatepass_id, uploaded_at DESC);
