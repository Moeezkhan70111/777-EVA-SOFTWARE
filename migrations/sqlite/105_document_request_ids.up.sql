-- One press of Save is one document, however many times it reaches this computer (docs: duplicate-protection
-- audit, 2026-11-09). Additive only: new nullable columns and partial unique indexes. Every existing row keeps
-- NULL, which the indexes allow, so nothing already here is touched.
--
-- request_id           the screen's id for one press of Save, kept across a retry whose answer was lost.
--                      UNIQUE where present: two writes under one id cannot both commit, whatever races.
-- request_fingerprint  a hash of what that press asked for. A retry asking for the same thing gets the
--                      original document back, and asking for something else under the same id is a conflict.
--
-- No semicolons in these comments: the migration runner splits statements on them (as 035 notes).
--
-- LOCAL TO THIS COMPUTER. A retry only ever happens on the computer that made the document, so these columns
-- are never sent (masterRecords.ts, localColumns). A record arriving from another computer leaves them NULL here,
-- and an older computer receiving a record simply has no such column. No cloud change.
--
-- A cash voucher's id already IS its request id (data/cash.ts), so it gets only the fingerprint.

ALTER TABLE gatepasses ADD COLUMN request_id TEXT;
ALTER TABLE gatepasses ADD COLUMN request_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_gatepasses_request ON gatepasses(request_id) WHERE request_id IS NOT NULL;

ALTER TABLE sale_vouchers ADD COLUMN request_id TEXT;
ALTER TABLE sale_vouchers ADD COLUMN request_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_vouchers_request ON sale_vouchers(request_id) WHERE request_id IS NOT NULL;

ALTER TABLE cash_vouchers ADD COLUMN request_fingerprint TEXT;
