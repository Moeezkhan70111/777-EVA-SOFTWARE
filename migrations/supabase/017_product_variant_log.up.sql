-- 017: product variants reach the log, so a new computer can hold the cartons of them.
--
-- THE GAP (found in the rehearsal, 2026-10-28). A carton names its product variant, and a computer
-- that has not been given the variant cannot hold the carton: it waits (UNKNOWN_PRODUCT_VARIANT).
-- The receiving side has had a PRODUCT_VARIANT contract since 008, and push_product_variant puts a
-- pushed variant into public.product_variants -- but nothing ever wrote a variant into the LOG,
-- and the log is the only thing a computer reads. The seeded variants never travelled at all. So an
-- empty computer received every carton and could hold none of them.
--
-- THE FIX. A log trigger on product_variants, like the carton's (003), and, once, a log row for
-- every variant already here, oldest first. The payload carries exactly the keys the receiver reads
-- (readProductVariantPayload): the identity and nothing else. No prices: they are each computer's
-- own, as 008 decided. The time is written as UTC with a Z, the way the computers store time (R16).
--
-- Insert-only, as variants are: a variant's article, colour and size never change, so an UPDATE
-- has nothing to send. Not factory-scoped (sync_aggregate_types, 009): factory_id stays null.
--
-- Run once, in the SQL editor, after 016. Re-running is harmless: the trigger is replaced, and the
-- existing variants are logged with on conflict do nothing on their dedupe keys.

create or replace function public.log_product_variant_insert() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The same lock as every log writer (003): positions are handed out in commit order.
  perform pg_advisory_xact_lock(777, 1);
  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload)
  values (
    'PRODUCT_VARIANT:' || new.id,
    'PRODUCT_VARIANT',
    new.id,
    jsonb_build_object(
      'variantId', new.id,
      'article', new.article,
      'color', new.color,
      'size', new.size,
      'description', new.description,
      'createdAt', to_char(new.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

revoke all on function public.log_product_variant_insert() from public, anon, authenticated;

drop trigger if exists trg_product_variants_log on public.product_variants;
create trigger trg_product_variants_log
after insert on public.product_variants
for each row execute procedure public.log_product_variant_insert();

-- The variants already here, logged once, oldest first. The lock and the insert in one block, so
-- they are one transaction however the editor sends the file, and the variants take their positions
-- in one unbroken run.
do $$
begin
  perform pg_advisory_xact_lock(777, 1);
  insert into public.sync_event_log (dedupe_key, aggregate_type, aggregate_id, payload)
  select
    'PRODUCT_VARIANT:' || v.id,
    'PRODUCT_VARIANT',
    v.id,
    jsonb_build_object(
      'variantId', v.id,
      'article', v.article,
      'color', v.color,
      'size', v.size,
      'description', v.description,
      'createdAt', to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  from public.product_variants v
  order by v.created_at, v.id
  on conflict (dedupe_key) do nothing;
end;
$$;
