CREATE TABLE IF NOT EXISTS cash_voucher_lines (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  description TEXT NOT NULL,
  mode_of_transfer TEXT NOT NULL DEFAULT 'Cash',
  receipt_amount REAL NOT NULL DEFAULT 0 CHECK (receipt_amount >= 0),
  payment_amount REAL NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (voucher_id) REFERENCES cash_vouchers(id) ON DELETE CASCADE,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK ((receipt_amount > 0 AND payment_amount = 0) OR (payment_amount > 0 AND receipt_amount = 0))
);
CREATE INDEX IF NOT EXISTS idx_cash_voucher_lines_voucher_id ON cash_voucher_lines(voucher_id);