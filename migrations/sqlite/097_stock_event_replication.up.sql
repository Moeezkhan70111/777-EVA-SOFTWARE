-- What a stock event arriving from another computer needs here (cloud migration 015).
--
-- replicated_at   when THIS computer received the event, from its own clock. Null on an event
--                 recorded here. created_at stays the origin's. See 088 for why the name.
--
-- pending_machine_program_id   the machine program a Dana issue was fetched for, kept aside when
--                 the program is not on this computer (docs/37 W.6). machine_program_id
--                 references machine_programs, which do not replicate yet, so an arriving Dana
--                 issue is stored with machine_program_id null and the program's id here. When
--                 programs replicate, the link is restored from this column. Always null on an
--                 event recorded here, and on one whose program is here.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE inventory_stock_events ADD COLUMN replicated_at TEXT;
ALTER TABLE inventory_stock_events ADD COLUMN pending_machine_program_id TEXT;
