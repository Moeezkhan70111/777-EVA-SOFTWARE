-- What the factory floor calls each colour, in Urdu: one list, kept as master data and shared by every computer
-- (docs/45). A colour is stored in English everywhere it already is -- product variants, carton QR identities, material
-- attributes -- and this table only says how it is SHOWN. Nothing that exists is changed.
--
-- english_key   the colour as it is matched: lower case, trimmed, inner spaces collapsed (normalizeColorKey in
--               @erp/domain). UNIQUE, so one colour has one Urdu name.
-- english_name  as entered, for showing.
-- urdu_name     exactly as entered. Never normalised: a corrected spelling is a different word to its reader.
--
-- SEEDED THE SAME ON EVERY COMPUTER. Each seeded row has a fixed id (color:<key>), so the same colour is the same record
-- everywhere and a computer that receives another's revision of it updates its own row rather than clashing on the
-- name. Capture triggers do not exist while migrations run (masterCapture.ts), so the seed is not queued as a change.
-- The rows are the owner's fifteen of 2026-11-10 and the eight the raw material label's dictionary had besides
-- (DEFAULT_COLOR_TRANSLATIONS, checked against this file by migration106.test.ts).
--
-- Replicated as the COLOR_TRANSLATION leased record under MASTER_DATA. The cloud learns the type from cloud migration
-- 029, prepared and not applied: until it is, a revision waits as UNKNOWN_RECORD_TYPE and nothing else is held up.
--
-- No semicolons in these comments: the migration runner splits statements on them (as 035 notes).

CREATE TABLE IF NOT EXISTS color_translations (
  id TEXT PRIMARY KEY,
  english_key TEXT NOT NULL UNIQUE,
  english_name TEXT NOT NULL,
  urdu_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO color_translations (id, english_key, english_name, urdu_name, created_at, updated_at) VALUES
  ('color:black', 'black', 'Black', 'سیاہ', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:navy', 'navy', 'Navy', 'نیوی', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:blue', 'blue', 'Blue', 'بلو', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:yellow', 'yellow', 'Yellow', 'پیلا', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:neon', 'neon', 'Neon', 'نیون', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:red', 'red', 'Red', 'لال', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:grey', 'grey', 'Grey', 'گرے', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:orange', 'orange', 'Orange', 'اورنج', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:commando', 'commando', 'Commando', 'کمانڈو', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:army-green', 'army green', 'Army Green', 'آرمی گرین', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:pink', 'pink', 'Pink', 'پنک', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:coffee', 'coffee', 'Coffee', 'کافی', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:light', 'light', 'Light', 'لایٹ', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:dark', 'dark', 'Dark', 'ڈارک', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:white', 'white', 'White', 'سفید', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:brown', 'brown', 'Brown', 'براؤن', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:cream', 'cream', 'Cream', 'کریم', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:skin', 'skin', 'Skin', 'سکن', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:army', 'army', 'Army', 'آرمی', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:green', 'green', 'Green', 'گرین', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:sky', 'sky', 'Sky', 'سکائ', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:gray', 'gray', 'Gray', 'گرے', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'),
  ('color:mustard', 'mustard', 'Mustard', 'مسٹرڈ', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z');

-- THE OUTBOX LEARNS THE NEW RECORD TYPE, by the same rebuild as 095, 101 and 104. Without it nothing fails at the
-- write, because enqueueSyncEvent never throws, and a colour change would simply never travel.

CREATE TABLE sync_outbox_with_colors (
  id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  lock_token TEXT,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  transient_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_epoch INTEGER,
  CHECK (aggregate_type IN (
    'QR_MASTER','PRODUCT_VARIANT','PRODUCTION_EVENT','PRODUCTION_PRODUCED','DISPATCH_EVENT','RETURN_EVENT','PROJECTION',
    'RAW_MATERIAL_QR_BATCH','RAW_MATERIAL_QR',
    'PARTY_GROUP','PARTY','INVENTORY_UNIT','UNIT_LADDER_PRESET','INVENTORY_CATEGORY','INVENTORY_ITEM','WORK_SECTION','MACHINE',
    'STOCK_EVENT','CARTON_STOCK_EVENT',
    'MAIN_GROUP','PRODUCT_GROUP','ARTICLE_SERIES','PRODUCT_TYPE','PRODUCT_SUB_GROUP','ARTICLE_SIZE',
    'MANUAL_PRODUCTION_ENTRY','GATEPASS','SALE_VOUCHER','CASH_VOUCHER',
    'COLOR_TRANSLATION'
  )),
  CHECK (operation IN ('INSERT','UPDATE')),
  CHECK (status IN ('PENDING','IN_FLIGHT','FAILED','DEAD_LETTER','SYNCED'))
);

INSERT INTO sync_outbox_with_colors (
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
)
SELECT
  id, aggregate_type, aggregate_id, operation, dedupe_key, payload_json,
  status, lock_token, available_at, attempts, transient_attempts, last_error, created_at, updated_at, lease_epoch
FROM sync_outbox
ORDER BY rowid;

DROP TABLE sync_outbox;
ALTER TABLE sync_outbox_with_colors RENAME TO sync_outbox;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_status_available_at ON sync_outbox(status, available_at);
