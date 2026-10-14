-- WHICH MACHINE AN UPPER PACKET WAS ISSUED TO -- Upper Move Out (Phase 3).
--
--   Upper Move Out  MACHINE 1  .  RM_P0001_I0042_000017  (SK6 RED 7/10, 5 DOZEN)
--     ->  raw_material_qrs.current_status  IN_STORE -> ISSUED
--     ->  inventory_stock_balances         -5 DOZEN, with its TRANSFER_OUT stock event
--     ->  raw_material_qr_events           STORE_EXIT, machine_id = MACHINE 1
--
-- An upper leaves the store the one way every raw material packet does -- the STORE_EXIT event,
-- written in the same transaction as the status move and the stock debit. The operator now names
-- the machine it goes to, and machine_id is where that is kept. It is written once, with the event,
-- and never updated: choosing another machine later cannot move a packet already issued.
--
-- NULL for every event before this, and for every exit that is not Upper Move Out (the generic Raw
-- Material Output scanner and the retired machine-program Store Out name no machine).
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE raw_material_qr_events ADD COLUMN machine_id TEXT REFERENCES machines(id);

CREATE INDEX IF NOT EXISTS idx_raw_material_qr_events_machine ON raw_material_qr_events(machine_id, event_ts_local);
