-- QR Management: allow a registered-but-never-produced code to be voided (lost or damaged
-- label) so the production scanner refuses it, with an audit trail of why and when.
-- Additive only. barcodes.status already exists (DEFAULT 'GENERATED') and gains the value 'VOID'.

ALTER TABLE barcodes ADD COLUMN void_reason TEXT;
ALTER TABLE barcodes ADD COLUMN voided_at TEXT;
ALTER TABLE barcodes ADD COLUMN voided_by TEXT;

CREATE INDEX IF NOT EXISTS idx_barcodes_status ON barcodes(status);
