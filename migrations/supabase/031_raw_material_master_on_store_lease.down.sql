-- Undoes 031: the raw-material taxonomy goes back under MASTER_DATA. Records and the log are not touched.

begin;

update public.leased_record_types
   set lease_domain = 'MASTER_DATA'
 where aggregate_type in ('INVENTORY_UNIT', 'UNIT_LADDER_PRESET', 'INVENTORY_CATEGORY', 'INVENTORY_ITEM');

commit;
