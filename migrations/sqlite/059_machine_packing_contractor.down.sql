-- Takes the packing contractor back off machines and machine_programs.
--
-- Nothing else points at these four columns, so they are simply dropped. Who packed a program's
-- output is lost, which is what rolling the feature back means. The machine contractor in the
-- original columns is untouched.
--
-- (No semicolons in comments: the migration runner splits statements on them.)

ALTER TABLE machine_programs DROP COLUMN packing_contractor_name_snapshot;

ALTER TABLE machine_programs DROP COLUMN packing_contractor_party_id;

ALTER TABLE machines DROP COLUMN packing_contractor_assigned_at;

ALTER TABLE machines DROP COLUMN packing_contractor_party_id;
