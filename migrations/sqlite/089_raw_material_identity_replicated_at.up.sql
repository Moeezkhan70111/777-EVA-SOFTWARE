-- The raw-material packet identity tables learn when a row arrived from another computer.
--
-- The same column, with the same meaning, as migration 088 gave the carton tables: NULL means
-- recorded on this computer, a time means written here by the sync applier at that UTC time.
-- created_at stays the origin's. See 088 for the decision and why the name is replicated_at.
--
-- These two receive RAW_MATERIAL_QR_BATCH and RAW_MATERIAL_QR (packages/sync,
-- rawMaterialContracts.ts). A separate migration from 088 because these tables are created by
-- later migrations, not by the base schema.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE raw_material_qr_batches ADD COLUMN replicated_at TEXT;
ALTER TABLE raw_material_qrs ADD COLUMN replicated_at TEXT;
