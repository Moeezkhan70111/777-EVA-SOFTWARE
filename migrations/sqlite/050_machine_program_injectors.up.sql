-- Machine Program, second shape: a machine is programmed for a DATE, injector by injector.
--
--   machine + date                           machine_programs   (one per machine per date)
--     injector 1 or 2 + sole + sole colour
--       + article + size                     machine_program_runs
--         upper colour + supplier + DOZEN    machine_program_upper_lines   (what is reserved)
--
-- Still a PLANNING layer. Nothing here touches inventory_stock_balances, raw_material_qrs or
-- inventory_stock_events. Raw Material Output stays the only thing that moves stock, and the
-- stamp it writes on its event is what consumes a line.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

-- ---- Sole types -------------------------------------------------------------
-- SKECHERS, NIKE, ADIDAS - the sole a machine moulds. Nothing in the ERP named a sole before
-- this, so this is the one list of them. Names are stored upper case, like sections.
CREATE TABLE IF NOT EXISTS sole_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

-- ---- The machine's permanent contractor --------------------------------------
-- Who works on a machine is a fact about the MACHINE, set once and kept until somebody changes
-- it. A program copies it when the program is made (machine_programs.contractor_party_id and
-- contractor_name_snapshot), so changing it later never rewrites a saved program.
ALTER TABLE machines ADD COLUMN contractor_party_id TEXT REFERENCES parties(id);
ALTER TABLE machines ADD COLUMN contractor_assigned_at TEXT;

-- ---- Programs belong to a date ----------------------------------------------
-- layout tells the two shapes apart. SHIFT_SLOTS is the first shape (time slots and bags in
-- machine_program_lines) and is kept as history. INJECTORS is this one.
ALTER TABLE machine_programs ADD COLUMN layout TEXT NOT NULL DEFAULT 'SHIFT_SLOTS';

-- A first-shape program that is still live would go on reserving bags nothing can consume any
-- more, because Raw Material Output now stamps the new lines. It is closed here, kept, and
-- says why. Completed and deleted ones are untouched history.
UPDATE machine_programs
   SET status = 'CANCELLED',
       cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       cancelled_by = 'system',
       cancel_reason = 'Closed when Machine Program moved to injector programs (migration 050). Bags already scanned out stay out.',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'PROGRAMMED' AND layout = 'SHIFT_SLOTS';

-- One live program per machine was the first shape. Now a machine has one program per DATE,
-- and 4 October is a different program from 5 October.
DROP INDEX IF EXISTS idx_machine_programs_live;

CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_programs_machine_date
  ON machine_programs(machine_id, program_date)
  WHERE layout = 'INJECTORS' AND status <> 'CANCELLED';

-- ---- One sole run on one injector ---------------------------------------------
-- What an injector is moulding: a sole, in a colour, onto an article and size from the
-- Product Master. An injector may be given several runs in a day.
-- sole_colour is text because a colour is text everywhere else in the ERP
-- (product_variants.color, the raw material COLOR attribute). It is checked on save against
-- the colours the store actually knows.
CREATE TABLE IF NOT EXISTS machine_program_runs (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL,
  injector_no INTEGER NOT NULL,
  run_no INTEGER NOT NULL,
  sole_type_id TEXT NOT NULL,
  sole_colour TEXT NOT NULL,
  article_size_id TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (program_id) REFERENCES machine_programs(id),
  FOREIGN KEY (sole_type_id) REFERENCES sole_types(id),
  FOREIGN KEY (article_size_id) REFERENCES article_sizes(id),
  CHECK (injector_no IN (1, 2)),
  UNIQUE (program_id, injector_no, run_no)
);

CREATE INDEX IF NOT EXISTS idx_machine_program_runs_program ON machine_program_runs(program_id, injector_no, run_no);

-- ---- One upper colour on a run: the reservation ------------------------------------
-- item_id is the exact upper (article + colour + size + kind), never a colour string.
-- supplier_party_id is the supplier whose labelled packets the line is against, and is NULL
-- for stock that carries no supplier (opening stock, a correction). quantity is in unit_id,
-- the unit the upper is stocked in when the line is saved (DOZEN).
CREATE TABLE IF NOT EXISTS machine_program_upper_lines (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  supplier_party_id TEXT,
  quantity REAL NOT NULL,
  unit_id TEXT NOT NULL,
  available_at_save REAL NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES machine_program_runs(id),
  FOREIGN KEY (item_id) REFERENCES inventory_items(id),
  FOREIGN KEY (supplier_party_id) REFERENCES parties(id),
  FOREIGN KEY (unit_id) REFERENCES inventory_units(id),
  CHECK (quantity > 0)
);

-- The same upper from the same supplier is one line on a run. A second ADD changes its quantity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_machine_program_upper_lines_source
  ON machine_program_upper_lines(run_id, item_id, COALESCE(supplier_party_id, ''));
CREATE INDEX IF NOT EXISTS idx_machine_program_upper_lines_item
  ON machine_program_upper_lines(item_id, supplier_party_id);

-- ---- What Raw Material Output took for a line --------------------------------
-- The stamp is the one ownership rule. A STORE_EXIT carrying a line id consumed that event's
-- quantity from the line. A STORE_ENTRY carrying it is the compensating record written when
-- the packet comes back to the store. Nothing is cached.
ALTER TABLE raw_material_qr_events ADD COLUMN machine_program_upper_line_id TEXT REFERENCES machine_program_upper_lines(id);

CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_upper_line
  ON raw_material_qr_events(machine_program_upper_line_id);
