-- Make the cloud tables able to hold what the local tables actually contain.
--
-- supabase/schema.sql was written before the gatepass work and before money moved to integer
-- paisa, and it guessed at types the local model does not use. Six mismatches would each reject
-- the two event contracts that are implemented today:
--
--   1. IDS ARE TEXT LOCALLY, NOT uuid. Every local id is TEXT. Most hold a UUID, but
--      factories.id is the literal 'factory-777' (apps/desktop/src/main/deviceIdentity.ts), so a
--      uuid column cannot hold it and every production event would be refused on its factory
--      foreign key. Making the columns text matches the local model exactly and removes the whole
--      class of failure rather than special-casing one row. UUIDs stored as text still index.
--
--   2. GATE STATUSES ARE MISSING. qr_master.current_status locally allows TO_GATE and ON_GATE and
--      current_location_type allows GATE. The cloud check constraints have neither, so any carton
--      at the gate would be refused.
--
--   3. TIMESTAMPS ARE TEXT LOCALLY. The contracts promise to carry what the recording computer
--      wrote, character for character. Round-tripping through timestamptz would re-render the
--      value, so the columns the contracts carry become text, exactly as they are locally. The
--      application already guarantees UTC ISO 8601 (R16). Cloud reporting should cast on read,
--      e.g. (event_ts_local)::timestamptz, rather than store a second representation.
--
--   4. metadata_json IS jsonb. jsonb reorders keys and drops whitespace, so the text that comes
--      back is not the text that went in. The local column is TEXT and the contract carries the
--      exact string, so the cloud column becomes text too.
--
--   5. AN updated_at TRIGGER OVERWRITES THE RECORDED TIME. trg_qr_master_updated_at sets
--      updated_at to the cloud's now(), losing the value the recording computer wrote. The local
--      model writes these itself, so the trigger is dropped for the tables the contracts write.
--
--   6. THE CLOUD HAS NO ORDERED LOG to read changes from. That is migration 003.
--
-- This migration is written for the new, EMPTY project: every type change is a plain cast that
-- cannot fail on data that is not there. Run it immediately after supabase/schema.sql.
--
-- NOT CHANGED, deliberately:
--   * sync_outbox. The outbox is a per-computer queue of what that computer still has to send.
--     The cloud has no use for one, and a shared outbox would be two computers writing one
--     queue. It is left alone rather than repurposed.
--   * product_variants.cost_price / selling_price, still numeric(12,2) rupees where the local
--     model now uses integer paisa (R15). Neither contract carries a price, so this is a
--     separate decision rather than a silent change to money columns.
--   * Tables outside the two contracts and their prerequisites.

begin;

-- ── Foreign keys have to come off before the types they join on can change ──

alter table workstations drop constraint if exists workstations_factory_id_fkey;
alter table devices drop constraint if exists devices_factory_id_fkey;
alter table devices drop constraint if exists devices_workstation_id_fkey;
alter table qr_master drop constraint if exists qr_master_product_variant_id_fkey;
alter table production_events drop constraint if exists production_events_qr_id_fkey;
alter table production_events drop constraint if exists production_events_product_variant_id_fkey;
alter table production_events drop constraint if exists production_events_factory_id_fkey;
alter table production_events drop constraint if exists production_events_workstation_id_fkey;
alter table production_events drop constraint if exists production_events_operator_id_fkey;
alter table stock_projection_by_variant drop constraint if exists stock_projection_by_variant_product_variant_id_fkey;
alter table stock_projection_by_location drop constraint if exists stock_projection_by_location_product_variant_id_fkey;
alter table report_daily_summary drop constraint if exists report_daily_summary_factory_id_fkey;

-- ── 1. Ids become text, matching the local model ──

alter table factories alter column id type text using id::text;
alter table workstations alter column id type text using id::text;
alter table workstations alter column factory_id type text using factory_id::text;
alter table operators alter column id type text using id::text;
alter table product_variants alter column id type text using id::text;

alter table devices alter column factory_id type text using factory_id::text;
alter table devices alter column workstation_id type text using workstation_id::text;

alter table qr_master alter column product_variant_id type text using product_variant_id::text;
alter table qr_master alter column current_location_id type text using current_location_id::text;
alter table qr_master alter column first_event_id type text using first_event_id::text;

alter table production_events alter column id type text using id::text;
alter table production_events alter column product_variant_id type text using product_variant_id::text;
alter table production_events alter column factory_id type text using factory_id::text;
alter table production_events alter column workstation_id type text using workstation_id::text;
alter table production_events alter column operator_id type text using operator_id::text;

alter table stock_projection_by_variant alter column product_variant_id type text using product_variant_id::text;
alter table stock_projection_by_location alter column product_variant_id type text using product_variant_id::text;
alter table report_daily_summary alter column factory_id type text using factory_id::text;

-- ── 2. The gate statuses and the gate location ──

alter table qr_master drop constraint if exists qr_master_current_status_check;
alter table qr_master add constraint qr_master_current_status_check
  check (current_status in ('PRODUCED','WAREHOUSE','TO_GATE','DISPATCHED','ON_GATE','SOLD','RETURNED','DAMAGED','SCRAPPED'));

alter table qr_master drop constraint if exists qr_master_current_location_type_check;
alter table qr_master add constraint qr_master_current_location_type_check
  check (current_location_type in ('FACTORY','WAREHOUSE','GATE','VEHICLE','CUSTOMER','UNKNOWN'));

-- ── 3 and 4. The values the contracts carry stay exactly as they were written ──

-- THE DEFAULTS COME OFF FIRST. `alter column ... type text` re-evaluates the column's existing
-- DEFAULT against the new type, and `now()` has no automatic cast to text, so changing the type
-- while the default is still attached fails with "default for column cannot be cast
-- automatically to type text" and rolls the whole migration back. The USING clause only converts
-- the rows, not the default.
alter table qr_master alter column created_at drop default;
alter table qr_master alter column updated_at drop default;
alter table production_events alter column created_at drop default;

alter table qr_master alter column created_at type text using to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
alter table qr_master alter column updated_at type text using to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

alter table production_events alter column event_ts_local type text using to_char(event_ts_local at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
alter table production_events alter column event_date type text using to_char(event_date, 'YYYY-MM-DD');
alter table production_events alter column created_at type text using to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
alter table production_events alter column metadata_json type text using metadata_json::text;

-- ── 5. The cloud stops rewriting a time the recording computer owns ──

drop trigger if exists trg_qr_master_updated_at on qr_master;

-- ── Foreign keys back on, now that both sides agree ──

alter table workstations add constraint workstations_factory_id_fkey
  foreign key (factory_id) references factories(id);
alter table devices add constraint devices_factory_id_fkey
  foreign key (factory_id) references factories(id);
alter table devices add constraint devices_workstation_id_fkey
  foreign key (workstation_id) references workstations(id);
alter table qr_master add constraint qr_master_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table production_events add constraint production_events_qr_id_fkey
  foreign key (qr_id) references qr_master(qr_id);
alter table production_events add constraint production_events_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table production_events add constraint production_events_factory_id_fkey
  foreign key (factory_id) references factories(id);
alter table production_events add constraint production_events_workstation_id_fkey
  foreign key (workstation_id) references workstations(id);
alter table production_events add constraint production_events_operator_id_fkey
  foreign key (operator_id) references operators(id);
alter table stock_projection_by_variant add constraint stock_projection_by_variant_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table stock_projection_by_location add constraint stock_projection_by_location_product_variant_id_fkey
  foreign key (product_variant_id) references product_variants(id);
alter table report_daily_summary add constraint report_daily_summary_factory_id_fkey
  foreign key (factory_id) references factories(id);

commit;
