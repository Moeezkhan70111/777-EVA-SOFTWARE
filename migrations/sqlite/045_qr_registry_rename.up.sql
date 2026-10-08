-- The carton label is now a QR code, not a Code128 barcode, so the registry tables take the
-- names the rest of the system already used for these identities: qr_codes, qr_batches and
-- qr_sequences. Renames only — no row is created, deleted, re-keyed or re-sequenced, and the
-- per-(article,color,size) counters keep their values, so no serial can ever be re-issued.
--
-- ALTER TABLE ... RENAME TO also rewrites the FOREIGN KEY reference qr_codes.batch_id carries
-- to qr_batches, so the two tables stay linked across the rename.

ALTER TABLE barcode_sequences RENAME TO qr_sequences;
ALTER TABLE barcode_batches RENAME TO qr_batches;
ALTER TABLE barcodes RENAME TO qr_codes;

-- Indexes keep their old names through a table rename, so rebuild them under the new ones.
DROP INDEX IF EXISTS idx_barcode_batches_created_at;
DROP INDEX IF EXISTS idx_barcodes_batch_id;
DROP INDEX IF EXISTS idx_barcodes_variant;
DROP INDEX IF EXISTS idx_barcodes_status;

CREATE INDEX IF NOT EXISTS idx_qr_batches_created_at ON qr_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qr_codes_batch_id ON qr_codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_qr_codes_variant ON qr_codes(product_variant_id);
CREATE INDEX IF NOT EXISTS idx_qr_codes_status ON qr_codes(status);

-- The QR Generator's permission code follows the page's name. Existing grants are rewritten
-- in place so nobody loses access. A plain UPDATE would collide where a role somehow holds
-- both codes, so delete the old row in that case instead.
DELETE FROM role_permissions
WHERE permission_code = 'barcode-generator'
  AND EXISTS (
    SELECT 1 FROM role_permissions existing
    WHERE existing.role_code = role_permissions.role_code
      AND existing.permission_code = 'qr-generator'
  );
UPDATE role_permissions SET permission_code = 'qr-generator' WHERE permission_code = 'barcode-generator';

DELETE FROM user_additional_permissions
WHERE permission_code = 'barcode-generator'
  AND EXISTS (
    SELECT 1 FROM user_additional_permissions existing
    WHERE existing.user_id = user_additional_permissions.user_id
      AND existing.permission_code = 'qr-generator'
  );
UPDATE user_additional_permissions SET permission_code = 'qr-generator' WHERE permission_code = 'barcode-generator';

UPDATE permission_requests SET permission_code = 'qr-generator' WHERE permission_code = 'barcode-generator';

-- app_users.permissions_json is a cache of the effective set, so rewrite the code there too
-- and a user keeps the page until their permissions are next recalculated.
UPDATE app_users
SET permissions_json = replace(permissions_json, '"barcode-generator"', '"qr-generator"')
WHERE permissions_json LIKE '%"barcode-generator"%';
