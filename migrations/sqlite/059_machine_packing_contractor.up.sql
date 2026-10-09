-- A machine has TWO contractors: the one who runs it, and the one who packs what it makes.
--
--   MACHINE 1   Machine contractor: ALAMGIR   Packing contractor: RASHID
--
-- The owner said so on 2026-10-08. "Who works on MACHINE 1?" was never one answer - the floor
-- runs the injectors under one contractor and packs the output under another, and both are paid
-- against the same day's program.
--
-- The existing columns keep their meaning and become the MACHINE contractor. The packing
-- contractor is a second assignment beside them, set the same way, from the same CONTRACTOR
-- parties in the Party Master. One party may be the machine contractor on one machine and the
-- packing contractor on another, so there is no uniqueness between the two columns.
--
-- Both machine_programs columns are NULLABLE on purpose. Programs saved before today were made
-- when a machine had one contractor, and they must stay readable exactly as they were saved -
-- back-filling them would be inventing a fact nobody recorded. Every program made from now on
-- carries both, which SaveMachineProgramLineUseCase enforces before a program is created.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE machines ADD COLUMN packing_contractor_party_id TEXT REFERENCES parties(id);

ALTER TABLE machines ADD COLUMN packing_contractor_assigned_at TEXT;

ALTER TABLE machine_programs ADD COLUMN packing_contractor_party_id TEXT REFERENCES parties(id);

ALTER TABLE machine_programs ADD COLUMN packing_contractor_name_snapshot TEXT;
