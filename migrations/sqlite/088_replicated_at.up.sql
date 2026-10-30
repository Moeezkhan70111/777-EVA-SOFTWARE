-- Every table the sync applier writes learns WHEN a row arrived from another computer.
--
-- THE DECISION (owner, 2026-10-23). A replicated row keeps the ORIGIN's created_at, unchanged.
-- That is the business time -- when the carton was registered, when the scan happened -- and a
-- receiving computer rewriting it would make every report on that computer disagree with every
-- report on the origin. The arrival time is a separate fact, kept in a separate column, for
-- diagnostics only: "when did PC 2 learn about this" is the first question asked when two
-- computers seem out of step.
--
-- WHY replicated_at AND NOT received_at. received_at was the first name proposed, but in this
-- codebase "received" already means a business event -- raw material received into the store
-- (rawMaterialReceiptUseCase, storeEntryScanUseCase, RECEIVE stock events). A received_at column
-- on a raw material table would read as "when the material was received", which is exactly the
-- wrong thing to believe. replicated_at cannot be mistaken for anything in the business.
--
-- WHAT THE VALUE MEANS.
--   NULL       the row was recorded on THIS computer
--   a time     the row was written here by the sync applier, at that UTC time
--
-- So the column is also the cheapest answer to "did this come from somewhere else". It is never
-- updated: a second arrival of the same event is a no-op, and keeps the first arrival's time.
--
-- NOT A CLOCK THAT DECIDES ANYTHING. replicated_at comes from the receiving computer's clock and
-- is never compared with created_at to choose a winner. A computer whose clock is wrong records
-- a wrong arrival time and nothing else -- which is why the per-PC setup steps verify time
-- synchronisation (docs/34, docs/36) rather than anything here trusting it.
--
-- Each later contract adds the same column to its own tables, in a migration of its own. They
-- are kept apart on purpose: the carton tables exist in the base schema, while most others are
-- created by later migrations, and the sync tests build the carton tables alone.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE product_variants ADD COLUMN replicated_at TEXT;
ALTER TABLE qr_master ADD COLUMN replicated_at TEXT;
ALTER TABLE production_events ADD COLUMN replicated_at TEXT;
