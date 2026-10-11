-- Takes the saved-batch record back off Store Out.
--
-- Nothing reads the batch stamp to decide a quantity -- issued and remaining are recomputed from
-- machine_program_upper_line_id, which this migration never touched -- so dropping it loses the
-- grouping of packets into the batch they were saved in, and nothing else. Every packet that left
-- the store stays out of it, against the same allocation it always was.
--
-- The batch table goes with it, and with it the idempotency keys: a Save Batch request replayed
-- after a rollback would be served again rather than recognised. That is what rolling the
-- feature back means.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

DROP INDEX IF EXISTS idx_raw_material_qr_events_program_batch;

ALTER TABLE raw_material_qr_events DROP COLUMN machine_program_batch_id;

DROP INDEX IF EXISTS idx_machine_program_issue_batches_program;

DROP TABLE IF EXISTS machine_program_issue_batches;
