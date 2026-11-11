-- Raw-material master data is written by the raw material store's computer (docs/47).
--
-- Until now one lease, MASTER_DATA, covered both the general master data (parties, machines, work sections,
-- products, colours) and the raw-material taxonomy (units, unit ladder presets, categories and materials). Moving
-- MASTER_DATA to the office computer (PC1) left the store computer (PC2), which holds RAW_MATERIAL_STORE and every
-- real raw material, unable to add a material. The raw-material taxonomy now travels under RAW_MATERIAL_STORE, with
-- the stock it describes: one writer for a material and its stock.
--
--   INVENTORY_UNIT, UNIT_LADDER_PRESET, INVENTORY_CATEGORY, INVENTORY_ITEM    MASTER_DATA -> RAW_MATERIAL_STORE
--   PARTY_GROUP, PARTY, WORK_SECTION, MACHINE, products, colours             MASTER_DATA, unchanged
--
-- push_leased_record reads the domain from this table on every push, so nothing else changes: its revision rules,
-- its lease check, its log trigger and its doorbell are 013's and 016's. A revision already stored keeps its row; the
-- next revision of the same record is accepted from the RAW_MATERIAL_STORE holder at that lease's epoch (013 compares
-- revisions, never one row's epoch with the next). No record, log row or lease is touched.
--
-- APPLY BEFORE the store computer runs the release that writes these under RAW_MATERIAL_STORE: until then its
-- revisions would be refused NOT_LEASE_HOLDER. A computer still on an older release stamps them MASTER_DATA, and
-- they are refused the same way, visibly, in its dead letters; reading is unaffected everywhere.
--
-- Requires 013 and 011. No revoke, so it runs through execute_sql as well as the SQL editor. TEST project first.
-- Safe to run twice.

begin;

update public.leased_record_types
   set lease_domain = 'RAW_MATERIAL_STORE'
 where aggregate_type in ('INVENTORY_UNIT', 'UNIT_LADDER_PRESET', 'INVENTORY_CATEGORY', 'INVENTORY_ITEM');

commit;
