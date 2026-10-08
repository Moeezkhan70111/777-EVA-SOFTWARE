-- Gatepass → Sale Voucher link, and typed user notifications.
--
-- A sale voucher made from a gatepass remembers which one (sale_vouchers.gatepass_id), so
-- that when the gatepass is cancelled the billing user can be told exactly which bill to
-- delete. One live bill per gatepass: the partial unique index refuses a second one while
-- the first is not deleted.
--
-- user_notifications gains a kind (what happened), the entity it is about, and a severity
-- (INFO / WARNING / CRITICAL) so the shell can open the right screen and shout when it must.
-- Additive only. (No semicolons in comments: the migration runner splits on them.)
ALTER TABLE sale_vouchers ADD COLUMN gatepass_id TEXT REFERENCES gatepasses(id);
CREATE INDEX IF NOT EXISTS idx_sale_vouchers_gatepass ON sale_vouchers(gatepass_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_vouchers_gatepass_live ON sale_vouchers(gatepass_id) WHERE gatepass_id IS NOT NULL AND deleted_at IS NULL;
ALTER TABLE user_notifications ADD COLUMN kind TEXT;
ALTER TABLE user_notifications ADD COLUMN entity_id TEXT;
ALTER TABLE user_notifications ADD COLUMN severity TEXT NOT NULL DEFAULT 'INFO';
