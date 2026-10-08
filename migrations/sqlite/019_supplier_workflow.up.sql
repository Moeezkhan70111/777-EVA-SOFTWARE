-- Supplier workflow: purchase vouchers, supplier ledger support, raw-material cost price.

-- Rebuild parties to allow CONTRACTOR party_type (SQLite cannot alter CHECK constraints).
CREATE TABLE IF NOT EXISTS parties_new (
  id TEXT PRIMARY KEY,
  party_code TEXT NOT NULL UNIQUE,
  party_name TEXT NOT NULL UNIQUE,
  party_name_urdu TEXT,
  party_type TEXT NOT NULL DEFAULT 'CUSTOMER',
  contact_person TEXT,
  mobile_number TEXT,
  whatsapp_number TEXT,
  phone_number TEXT,
  email TEXT,
  address TEXT,
  city TEXT,
  party_group_id TEXT,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_active INTEGER NOT NULL DEFAULT 1,
  balance_limit REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_group_id) REFERENCES party_groups(id),
  CHECK (party_type IN ('CUSTOMER','SUPPLIER','CONTRACTOR','DISTRIBUTOR','DEALER','TRANSPORTER')),
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

INSERT INTO parties_new (id, party_code, party_name, party_name_urdu, party_type, contact_person, mobile_number, whatsapp_number, phone_number, email, address, city, party_group_id, remarks, status, is_active, balance_limit, created_at, updated_at, deleted_at, deleted_by, delete_reason)
SELECT id, party_code, party_name, party_name_urdu, party_type, contact_person, mobile_number, whatsapp_number, phone_number, email, address, city, party_group_id, remarks, status, is_active, balance_limit, created_at, updated_at, deleted_at, deleted_by, delete_reason FROM parties;

DROP TABLE parties;

ALTER TABLE parties_new RENAME TO parties;

CREATE TABLE IF NOT EXISTS purchase_vouchers (
  id TEXT PRIMARY KEY,
  voucher_number TEXT NOT NULL UNIQUE,
  party_id TEXT NOT NULL,
  voucher_date TEXT NOT NULL,
  book_no TEXT,
  reference_no TEXT,
  remarks TEXT,
  total_quantity REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'FINALIZED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  delete_reason TEXT,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  CHECK (status IN ('DRAFT','FINALIZED','CANCELLED'))
);

CREATE TABLE IF NOT EXISTS purchase_voucher_line_items (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  total_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (voucher_id) REFERENCES purchase_vouchers(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_vouchers_party ON purchase_vouchers(party_id);
CREATE INDEX IF NOT EXISTS idx_purchase_voucher_lines_voucher ON purchase_voucher_line_items(voucher_id);

ALTER TABLE inventory_items ADD COLUMN cost_price REAL;
