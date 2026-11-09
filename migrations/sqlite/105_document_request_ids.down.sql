-- Undoes 105: the indexes, then the columns. Nothing else ever depended on them.

DROP INDEX IF EXISTS idx_gatepasses_request;
DROP INDEX IF EXISTS idx_sale_vouchers_request;

ALTER TABLE gatepasses DROP COLUMN request_fingerprint;
ALTER TABLE gatepasses DROP COLUMN request_id;
ALTER TABLE sale_vouchers DROP COLUMN request_fingerprint;
ALTER TABLE sale_vouchers DROP COLUMN request_id;
ALTER TABLE cash_vouchers DROP COLUMN request_fingerprint;
