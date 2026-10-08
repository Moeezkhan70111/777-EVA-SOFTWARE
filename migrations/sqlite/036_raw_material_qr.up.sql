-- Raw Material QR Generator: permanent per-(party,item) sequence counters, generated batches,
-- and individual QR/barcode identities for raw material received from a supplier. Mirrors the
-- finished-goods barcode_sequences/barcode_batches/barcodes shape (020_barcode_generator).

CREATE TABLE IF NOT EXISTS raw_material_qr_sequences (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(party_id, item_id)
);

CREATE TABLE IF NOT EXISTS raw_material_qr_batches (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  requested_by TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id)
);

CREATE TABLE IF NOT EXISTS raw_material_qrs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(party_id, item_id, sequence),
  FOREIGN KEY (batch_id) REFERENCES raw_material_qr_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_raw_material_qr_batches_created_at ON raw_material_qr_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_material_qrs_batch_id ON raw_material_qrs(batch_id);
CREATE INDEX IF NOT EXISTS idx_raw_material_qrs_item_id ON raw_material_qrs(item_id);
