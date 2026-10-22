-- A computer may send the products its cartons belong to.
--
-- THE PROBLEM THIS SOLVES, observed on 2026-10-22. A product variant was created locally at
-- 17:26:22 and a carton of it scanned ten seconds later. push_qr_master refused the carton with
-- UNKNOWN_PRODUCT_VARIANT, correctly -- the cloud had never heard of SK46 BLACK 4/6, and a
-- receiving computer that invented a product rather than refusing the carton would be worse.
--
-- But the only cure was somebody noticing and inserting the variant by hand. Every new product,
-- colour or size does this again, and the failure surfaces as a refused carton rather than as
-- "a product is missing", so it reads like a sync fault instead of a provisioning gap.
--
-- WHY THIS IS INSERT-ONLY, AND NEEDS NO CONFLICT RULE. A variant's identity -- article, colour,
-- size -- is fixed when it is created; nothing ever edits it. Only the description and the
-- prices change, and the cloud needs neither: no contract carries a price, and docs/37 keeps
-- money out of the cloud as a separate decision. So `on conflict do nothing` is the whole of it.
-- This is NOT the last-write-wins master-data group in docs/38 -- it is the append-only group,
-- which is why it costs a day rather than a fortnight.
--
-- PRICES ARE DELIBERATELY NOT ACCEPTED. There is no parameter for cost_price or selling_price,
-- so a client cannot send them even by mistake. The company's pricing does not leave the
-- building for a feature that has no use for it.
--
-- THE CLAIM IS VALIDATED EXACTLY AS THE OTHER TWO PUSHES VALIDATE IT. claim_is_current runs in
-- the same transaction as the write, so a superseded device cannot insert a product any more
-- than it can insert a carton. Every rule 004's policies state is restated here, because a
-- SECURITY DEFINER function owned by the table owner bypasses RLS entirely.
--
-- NO FACTORY CHECK, deliberately, and consistent with push_qr_master: product variants have no
-- tenant column, by the owner's decision of 2026-10-17 recorded in 005 and the README. A product
-- belongs to no factory, exactly as a carton identity does not.
--
-- EVERY REFUSAL IS PER ROW. Nothing in the loop raises, so one unacceptable variant is answered
-- with its own REFUSED outcome and the rest of the batch still lands. A raise here would be
-- settled by the drain as a transient failure for the whole batch, and transient attempts are
-- unbounded -- so it would not park one row, it would stall the outbox.
--
-- (No semicolons in comments: paste this whole file into the Supabase SQL editor, after 007.)

begin;

create or replace function public.push_product_variant(p_epoch bigint, p_holder uuid, p_rows jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  item jsonb;
  outcomes jsonb := '[]'::jsonb;
  inserted int;
begin
  account := public.claim_is_current(p_epoch, p_holder);

  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'ROWS_NOT_AN_ARRAY' using errcode = '22023';
  end if;

  for item in select * from jsonb_array_elements(p_rows) loop
    if item->>'id' is null or item->>'article' is null or item->>'color' is null
       or item->>'size' is null or item->>'created_at' is null then
      outcomes := outcomes || jsonb_build_object('id', item->>'id', 'outcome', 'REFUSED', 'reason', 'PAYLOAD_INCOMPLETE');
      continue;
    end if;

    -- status is written here rather than accepted: ACTIVE is the only state a variant arrives
    -- in, and a retired one is retired on each computer from its own records.
    insert into public.product_variants (
      id, article, color, size, description, cost_price, selling_price,
      status, created_at, updated_at
    ) values (
      item->>'id', item->>'article', item->>'color', item->>'size', item->>'description', null, null,
      'ACTIVE', (item->>'created_at')::timestamptz, (item->>'created_at')::timestamptz
    )
    on conflict (id) do nothing;

    get diagnostics inserted = row_count;
    outcomes := outcomes || jsonb_build_object(
      'id', item->>'id',
      'outcome', case when inserted > 0 then 'INSERTED' else 'DUPLICATE' end
    );
  end loop;

  return jsonb_build_object('ok', true, 'epoch', account.claim_epoch, 'results', outcomes);
end;
$$;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and Supabase grants it to anon and
-- authenticated as well, so it is revoked by name before anything is given back.
revoke all on function public.push_product_variant(bigint, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.push_product_variant(bigint, uuid, jsonb) to authenticated;

-- The direct insert stays closed. 004 revoked insert on product_variants from authenticated and
-- nothing here restores it: this RPC is the only way a client may add one, so a write that
-- skipped the claim cannot be written.

commit;
