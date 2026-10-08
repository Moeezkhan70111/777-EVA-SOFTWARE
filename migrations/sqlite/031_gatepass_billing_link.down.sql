DROP INDEX IF EXISTS idx_sale_vouchers_gatepass_live;
DROP INDEX IF EXISTS idx_sale_vouchers_gatepass;
ALTER TABLE sale_vouchers DROP COLUMN gatepass_id;
ALTER TABLE user_notifications DROP COLUMN severity;
ALTER TABLE user_notifications DROP COLUMN entity_id;
ALTER TABLE user_notifications DROP COLUMN kind;
