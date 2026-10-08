-- QR Generator: optionally record who asked for a generation run (a person, not the operator
-- who ran it — that is created_by). Additive only.

ALTER TABLE barcode_batches ADD COLUMN requested_by TEXT;
