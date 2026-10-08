-- Raw material Store movement: what one QR label is physically worth, and where the
-- material goes when it leaves the store.
--
-- One printed label = one PACKET. How much is in a packet is a property of the material
-- itself, not of the print run: RUBBER UPPER 7/10 is packed 2 dozen to a packet while
-- RUBBER UPPER 4/6 is packed 3 dozen, and those are already two separate inventory_items
-- rows because size is part of an item's attribute signature.
--
-- Where a packet goes on Store Move Out is likewise a property of the material — rubber
-- uppers go to PACKING, ragzine goes to the UPPER MAKER — so the operator never has to
-- choose a destination. They just scan.

-- ─── Destinations a packet can be issued to ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS work_sections (
  id TEXT PRIMARY KEY,
  section_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

-- ─── Packing and destination, per raw material ───────────────────────────────────
-- Both stay NULL until the owner configures them. A material with no packing cannot be
-- moved through the store: there is no defensible answer to "how much did that packet
-- add", and guessing would corrupt stock.
ALTER TABLE inventory_items ADD COLUMN packing_quantity REAL;
ALTER TABLE inventory_items ADD COLUMN packing_unit_id TEXT REFERENCES inventory_units(id);
ALTER TABLE inventory_items ADD COLUMN default_section_id TEXT REFERENCES work_sections(id);

-- ─── What each printed label is worth, and where it is now ───────────────────────
-- packing_quantity / packing_unit_id are a SNAPSHOT taken when the label is printed. If
-- the packing of a material is corrected later, labels already on packets keep meaning
-- what they meant when they were printed — the same rule the finished-goods event log
-- follows with its article/colour/size snapshots.
--
-- current_status mirrors qr_master.current_status for cartons. `status` stays the registry
-- status (GENERATED / VOID), mirroring barcodes.status.
ALTER TABLE raw_material_qrs ADD COLUMN packing_quantity REAL;
ALTER TABLE raw_material_qrs ADD COLUMN packing_unit_id TEXT REFERENCES inventory_units(id);
ALTER TABLE raw_material_qrs ADD COLUMN current_status TEXT NOT NULL DEFAULT 'GENERATED';
ALTER TABLE raw_material_qrs ADD COLUMN current_section_id TEXT REFERENCES work_sections(id);

CREATE INDEX IF NOT EXISTS idx_raw_material_qrs_current_status ON raw_material_qrs(current_status);

-- ─── Movement history ────────────────────────────────────────────────────────────
-- The same shape as production_events, for QRs that identify a raw material packet rather
-- than a finished carton. It is a separate table because production_events requires a
-- product_variant_id and article/colour/size on every row, and roughly a dozen live
-- queries (gatepass reservations, stock projections, dispatch attribution, reports) rely
-- on those being present — making them nullable to fit raw material would put the
-- finished-goods core at risk for no gain. Both tables are read through one journey API,
-- so the operator still sees a single QR history.
CREATE TABLE IF NOT EXISTS raw_material_qr_events (
  id TEXT PRIMARY KEY,
  qr_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  party_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_ts_local TEXT NOT NULL,
  event_date TEXT NOT NULL,
  factory_id TEXT NOT NULL,
  workstation_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  actor TEXT,
  session_id TEXT,
  -- What this movement did to stock, in the unit it was recorded in. Snapshotted so the
  -- history stays readable after a packing correction.
  quantity REAL NOT NULL,
  unit_id TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  section_id TEXT,
  item_display_name TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  source_app TEXT NOT NULL DEFAULT 'desktop-store-scanner',
  FOREIGN KEY (qr_id) REFERENCES raw_material_qrs(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (unit_id) REFERENCES inventory_units(id),
  FOREIGN KEY (section_id) REFERENCES work_sections(id),
  CHECK (event_type IN ('STORE_ENTRY','STORE_EXIT')),
  CHECK (sync_status IN ('PENDING','SYNCED','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_qr ON raw_material_qr_events(qr_id, event_ts_local);
CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_date ON raw_material_qr_events(event_date);
CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_item ON raw_material_qr_events(item_id, event_date);
