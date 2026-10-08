-- Barcode Generator: permanent per-(article,color,size) sequence counters, generated batches, and individual barcode identities.

CREATE TABLE IF NOT EXISTS barcode_sequences (
  id TEXT PRIMARY KEY,
  article TEXT NOT NULL,
  color TEXT NOT NULL,
  size TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(article, color, size)
);

CREATE TABLE IF NOT EXISTS barcode_batches (
  id TEXT PRIMARY KEY,
  article_size_id TEXT,
  article TEXT NOT NULL,
  color TEXT NOT NULL,
  size TEXT NOT NULL,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS barcodes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  article TEXT NOT NULL,
  color TEXT NOT NULL,
  size TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(article, color, size, sequence),
  FOREIGN KEY (batch_id) REFERENCES barcode_batches(id)
);

CREATE INDEX IF NOT EXISTS idx_barcode_batches_created_at ON barcode_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_barcodes_batch_id ON barcodes(batch_id);
