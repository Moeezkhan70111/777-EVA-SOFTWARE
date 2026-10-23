-- Removes the origin columns from the numbered tables.
--
-- REVERSING THIS RE-BREAKS REPLICATION. countOutsideRange needs origin_device_id to ask "is
-- there a number here that I issued outside my block". Without it the question collapses back to
-- "is there any number here outside my block", which is false on every computer the moment a
-- numbered table replicates -- and every numbered document creation fails. Only run this on an
-- installation that is NOT replicating, and change numberRange.ts back in the same step.
--
-- The provenance is lost, not merely hidden: once these columns are dropped there is no record of
-- which computer issued which document, and re-adding them can only stamp everything with one
-- device id again. On a fleet that has been replicating, that is wrong for every row that came
-- from elsewhere.
--
-- device.id is left in app_settings. It is a true statement about this machine, nothing else
-- depends on its absence, and ensureOperationalContext would write it again on the next start.
--
-- Nothing executes this file: the runner reads *.up.sql only, and the application has no
-- rollback path. It exists so the forward migration can be read against its inverse.
--
-- (No semicolons in comments.)

ALTER TABLE cash_vouchers DROP COLUMN origin_device_id;
ALTER TABLE sale_vouchers DROP COLUMN origin_device_id;
ALTER TABLE purchase_vouchers DROP COLUMN origin_device_id;
ALTER TABLE gatepasses DROP COLUMN origin_device_id;
ALTER TABLE machine_programs DROP COLUMN origin_device_id;
ALTER TABLE manual_production_entries DROP COLUMN origin_device_id;
ALTER TABLE parties DROP COLUMN origin_device_id;
ALTER TABLE article_sizes DROP COLUMN origin_device_id;
ALTER TABLE party_claims DROP COLUMN origin_device_id;
ALTER TABLE removal_requests DROP COLUMN origin_device_id;
ALTER TABLE stock_correction_requests DROP COLUMN origin_device_id;
ALTER TABLE machines DROP COLUMN origin_device_id;
ALTER TABLE inventory_items DROP COLUMN origin_device_id;
ALTER TABLE work_sections DROP COLUMN origin_device_id;
