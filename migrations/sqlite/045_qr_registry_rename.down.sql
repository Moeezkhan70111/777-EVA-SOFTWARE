-- Reverses 045: the registry tables and the QR Generator permission code go back to their
-- barcode-era names. Renames and in-place updates only, so no row is lost.

ALTER TABLE qr_sequences RENAME TO barcode_sequences;
ALTER TABLE qr_batches RENAME TO barcode_batches;
ALTER TABLE qr_codes RENAME TO barcodes;

DROP INDEX IF EXISTS idx_qr_batches_created_at;
DROP INDEX IF EXISTS idx_qr_codes_batch_id;
DROP INDEX IF EXISTS idx_qr_codes_variant;
DROP INDEX IF EXISTS idx_qr_codes_status;

CREATE INDEX IF NOT EXISTS idx_barcode_batches_created_at ON barcode_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_barcodes_batch_id ON barcodes(batch_id);
CREATE INDEX IF NOT EXISTS idx_barcodes_variant ON barcodes(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_barcodes_status ON barcodes(status);

DELETE FROM role_permissions
WHERE permission_code = 'qr-generator'
  AND EXISTS (
    SELECT 1 FROM role_permissions existing
    WHERE existing.role_code = role_permissions.role_code
      AND existing.permission_code = 'barcode-generator'
  );
UPDATE role_permissions SET permission_code = 'barcode-generator' WHERE permission_code = 'qr-generator';

DELETE FROM user_additional_permissions
WHERE permission_code = 'qr-generator'
  AND EXISTS (
    SELECT 1 FROM user_additional_permissions existing
    WHERE existing.user_id = user_additional_permissions.user_id
      AND existing.permission_code = 'barcode-generator'
  );
UPDATE user_additional_permissions SET permission_code = 'barcode-generator' WHERE permission_code = 'qr-generator';

UPDATE permission_requests SET permission_code = 'barcode-generator' WHERE permission_code = 'qr-generator';

UPDATE app_users
SET permissions_json = replace(permissions_json, '"qr-generator"', '"barcode-generator"')
WHERE permissions_json LIKE '%"qr-generator"%';
