-- QR Generator: link every registered barcode identity to its canonical product_variants row,
-- and register pre-existing scanned QR identities so the scanner's registry check never rejects
-- a barcode that was already in production before the QR Generator became the source of truth.
-- Additive only: no existing row is deleted, renamed, or re-keyed.

ALTER TABLE barcodes ADD COLUMN product_variant_id TEXT;

-- barcodes already carries UNIQUE(article, color, size, sequence) and a PK on the QR value
-- itself, so only the variant link needs a new index.
CREATE INDEX IF NOT EXISTS idx_barcodes_variant ON barcodes(product_variant_id);

-- One synthetic batch per historical article/color/size combination found in production history.
INSERT OR IGNORE INTO barcode_batches (
  id, article_size_id, article, color, size, start_sequence, end_sequence, quantity, created_at, created_by
)
SELECT
  'legacy_' || pe.article_snapshot || '_' || pe.color_snapshot || '_' || pe.size_snapshot,
  NULL,
  pe.article_snapshot,
  pe.color_snapshot,
  pe.size_snapshot,
  MIN(CAST(pe.serial_snapshot AS INTEGER)),
  MAX(CAST(pe.serial_snapshot AS INTEGER)),
  COUNT(*),
  MIN(pe.created_at),
  'legacy-backfill'
FROM production_events pe
WHERE pe.event_type = 'PRODUCED'
  AND EXISTS (SELECT 1 FROM qr_master q WHERE q.qr_id = pe.qr_id)
GROUP BY pe.article_snapshot, pe.color_snapshot, pe.size_snapshot;

-- Register each historical QR identity itself.
INSERT OR IGNORE INTO barcodes (
  id, batch_id, article, color, size, sequence, status, created_at, updated_at, product_variant_id
)
SELECT
  pe.qr_id,
  'legacy_' || pe.article_snapshot || '_' || pe.color_snapshot || '_' || pe.size_snapshot,
  pe.article_snapshot,
  pe.color_snapshot,
  pe.size_snapshot,
  CAST(pe.serial_snapshot AS INTEGER),
  'GENERATED',
  pe.created_at,
  pe.created_at,
  pe.product_variant_id
FROM production_events pe
WHERE pe.event_type = 'PRODUCED'
  AND EXISTS (SELECT 1 FROM qr_master q WHERE q.qr_id = pe.qr_id);

-- Barcodes generated before this migration carry no variant link, so resolve it by natural key.
UPDATE barcodes
SET product_variant_id = (
  SELECT pv.id FROM product_variants pv
  WHERE pv.article = barcodes.article
    AND pv.color = barcodes.color
    AND pv.size = barcodes.size
    AND pv.deleted_at IS NULL
  LIMIT 1
)
WHERE product_variant_id IS NULL;

-- Make sure a counter row exists for every combination that already has registered identities.
INSERT OR IGNORE INTO barcode_sequences (id, article, color, size, last_sequence, updated_at)
SELECT
  lower(hex(randomblob(16))),
  combos.article,
  combos.color,
  combos.size,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT DISTINCT article, color, size FROM barcodes) AS combos;

-- Never hand out a serial that historical data already used.
UPDATE barcode_sequences
SET last_sequence = MAX(
      last_sequence,
      COALESCE((
        SELECT MAX(b.sequence) FROM barcodes b
        WHERE b.article = barcode_sequences.article
          AND b.color = barcode_sequences.color
          AND b.size = barcode_sequences.size
      ), 0)
    ),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
