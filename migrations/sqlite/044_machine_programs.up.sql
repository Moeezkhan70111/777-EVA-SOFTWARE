-- Machine Program: how a machine's shift will consume raw material from the store.
--
--   Machine + Contractor + (material, supplier, time slot, bags) x N  ->  machine_programs
--
-- This is a PLANNING layer, exactly as a Gatepass is for finished cartons. Creating a
-- program never touches inventory_stock_balances, raw_material_qrs or inventory_stock_events.
-- Physical movement stays with Raw Material Output, which is also where a program's
-- allocation is consumed.
--
--   Physical bags     the balance of a material, expressed in its own pack
--   Reserved          bags still owed to live (PROGRAMMED) machine programs
--   Available         Physical - Reserved, the most a NEW program may take
--
-- (No semicolons in comments: the migration runner splits statements on them.)

-- ---- An individual machine --------------------------------------------------
-- A work_section is a DESTINATION a packet is issued to (MACHINE, PACKING). A machine is
-- one unit standing inside such a section, so it points at one. That link is what decides
-- which materials a machine can be programmed with: a material is allocatable when the
-- first hop of its route -- where the store sends it -- is this machine's section.
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  machine_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  section_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (section_id) REFERENCES work_sections(id),
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status, sort_order);

-- ---- The program itself -----------------------------------------------------
-- status is the stored fact that decides whether the program still reserves anything.
-- Reserved only ever counts PROGRAMMED programs, so cancelling or completing one releases
-- its outstanding bags by that status change alone -- the same rule gatepasses follow.
-- PARTIALLY USED is NOT stored: it is derived from how much has actually been scanned out,
-- so it can never drift from the event log.
CREATE TABLE IF NOT EXISTS machine_programs (
  id TEXT PRIMARY KEY,
  program_number INTEGER NOT NULL UNIQUE,
  machine_id TEXT NOT NULL,
  contractor_party_id TEXT NOT NULL,
  machine_name_snapshot TEXT NOT NULL,
  contractor_name_snapshot TEXT NOT NULL,
  program_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROGRAMMED',
  total_bags INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id),
  FOREIGN KEY (contractor_party_id) REFERENCES parties(id),
  CHECK (status IN ('PROGRAMMED','COMPLETED','CANCELLED'))
);

-- One live program per machine, so a machine card has exactly one unambiguous state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_programs_live
  ON machine_programs(machine_id) WHERE status = 'PROGRAMMED';

CREATE INDEX IF NOT EXISTS idx_machine_programs_date ON machine_programs(program_date DESC);
CREATE INDEX IF NOT EXISTS idx_machine_programs_status ON machine_programs(status);

-- ---- One line: a material, a time slot, a number of bags --------------------
-- item_id is the authoritative inventory identity, never a colour string. supplier_party_id
-- is the supplier whose labelled packets this line is against, and is NULL when the line is
-- taken from stock that carries no supplier on it (opening stock, a correction, anything
-- received before labels existed). A packet only ever consumes a line whose supplier is its
-- own, or a line with no supplier named -- never another supplier's.
--
-- The pack is snapshotted the same way a printed label snapshots it: correcting a material's
-- packing later must not silently change what a saved program promised.
--
-- Time is held as minutes from midnight of program_date. end_minute may pass 1440 when the
-- slot runs into the next morning, which is what a 12-hour evening shift does. Keeping it as
-- an integer offset means overlap is an integer comparison and no screen ever does timezone
-- arithmetic of its own.
CREATE TABLE IF NOT EXISTS machine_program_lines (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  supplier_party_id TEXT,
  item_display_name TEXT NOT NULL,
  supplier_name_snapshot TEXT,
  bags INTEGER NOT NULL,
  pack_name_snapshot TEXT,
  packing_quantity_snapshot REAL,
  packing_unit_id TEXT,
  start_minute INTEGER NOT NULL,
  end_minute INTEGER NOT NULL,
  available_bags_at_creation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (supplier_party_id) REFERENCES parties(id),
  FOREIGN KEY (packing_unit_id) REFERENCES inventory_units(id),
  CHECK (bags > 0),
  CHECK (start_minute >= 0 AND start_minute < 1440),
  CHECK (end_minute > start_minute AND end_minute <= 2880)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_lines_program ON machine_program_lines(program_id, line_no);
CREATE INDEX IF NOT EXISTS idx_machine_program_lines_item ON machine_program_lines(item_id, supplier_party_id);

-- ---- What Raw Material Output actually took for a program -------------------
-- The stamp on the scan event is the ONE ownership rule, exactly as production_events.
-- gatepass_id is for a carton. A STORE_EXIT carrying a line id consumed one of that line's
-- bags. A STORE_ENTRY carrying it is the compensating record written when the packet is
-- received back into the store, so the bag returns to the program's outstanding quantity.
-- Nothing is cached: Reserved is recomputed from these rows every time it is asked for.
ALTER TABLE raw_material_qr_events ADD COLUMN machine_program_line_id TEXT REFERENCES machine_program_lines(id);

CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_program_line
  ON raw_material_qr_events(machine_program_line_id);
