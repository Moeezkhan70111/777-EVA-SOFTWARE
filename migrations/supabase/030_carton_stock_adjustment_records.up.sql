-- Stock Adjustment documents reach the cloud (docs/46).
--
-- An Opening Stock or Stock Adjustment document with its lines, posted on the carton computer (local migration 107).
-- Like 028 and 029, this is a row in leased_record_types and nothing else: push_leased_record, its revision rules, its
-- lease check, its log trigger and its doorbell ring are 013's and 016's, unchanged. The cartons themselves move by
-- CARTON_ADJUST_IN and CARTON_ADJUST_OUT movements, which 027 already accepts.
--
--   A stock adjustment document    CARTON_STOCK    its number, kind, date, reason, who posted it, and its lines
--
-- UNTIL THIS IS APPLIED a document is answered UNKNOWN_RECORD_TYPE, which the client treats as a deployment-order wait
-- (supabaseTransport.ts): the document stays queued, nothing else in the outbox is held up, and it goes once this runs.
-- The movements are not held up at all: every computer receives the figure, and the document follows.
--
-- UNSCOPED, like every leased record: one factory.
--
-- Requires 013 (leased_record_types), 011 (the domains), 026 (CARTON_STOCK). No revoke, so it runs through execute_sql
-- as well as the SQL editor. TEST project first. Safe to run twice. PREPARED, NOT APPLIED to either project.

begin;

insert into public.sync_aggregate_types (aggregate_type, factory_scoped, note) values
  ('CARTON_STOCK_ADJUSTMENT', false, 'An Opening Stock or Stock Adjustment document with its lines: a leased record (030), carton lease.')
on conflict (aggregate_type) do nothing;

insert into public.leased_record_types (aggregate_type, lease_domain) values
  ('CARTON_STOCK_ADJUSTMENT', 'CARTON_STOCK')
on conflict (aggregate_type) do nothing;

commit;
