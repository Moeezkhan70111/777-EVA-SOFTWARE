-- Reverses 018: the cloud stops recording number blocks, and claims stop asking for one.
--
-- RE-OPENS THE PC2/PC3 FAILURE. After this, two computers on one block can both claim and both
-- write, and nothing in the cloud notices (docs/39 section 4.4).
--
-- The registry and its history STAY, deliberately: they are the record of which computer held which
-- block, and the numbers those computers issued are still out there. Re-applying 018 picks them up
-- as they are. Drop the two tables by hand only if that record is truly unwanted.
--
-- claim_device and claim_is_current go back to 006's text exactly, so a client from before 018
-- (three-argument claim) syncs again. A client from 018 sends p_number_block and is refused by
-- PostgREST (no such function) until it is downgraded too.

begin;

drop function if exists public.reassign_number_block(integer, text, text);
drop function if exists public.claim_device(text, text, text, integer);

create or replace function public.claim_device(
  p_device_id text,
  p_workstation_id text,
  p_app_version text default null
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
  new_epoch bigint;
  new_holder uuid;
begin
  -- NO CALLER, NO REFUSAL TO RECORD. auth.uid() reads request.jwt.claim.sub, and there are two
  -- ways to arrive here without one: the Supabase SQL editor, which runs as the table owner over
  -- a direct connection with no PostgREST request at all, and a JWT for role `authenticated`
  -- carrying no `sub`. Neither is a client -- `anon` has no execute grant on this function -- but
  -- both used to produce the WRONG failure. The lookup below would find no row, the NOT_ENROLLED
  -- branch would then try to log the refusal, and device_claim_events.auth_user_id is `not null`
  -- on purpose, so that insert raised and the reasoned refusal never came back.
  --
  -- Refused here instead, before the lookup and before anything is written. NOT_ENROLLED is the
  -- honest answer -- no enrolled account is making this call -- and it is a reason the client
  -- already classifies, so nothing downstream changes. No audit row is written because there is
  -- no account to attribute one to: an unattributable line in the owner's record of who claimed
  -- what would be worse than its absence, which is also why auth_user_id stays `not null`.
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'reason', 'NOT_ENROLLED');
  end if;

  select * into account from public.device_accounts
   where auth_user_id = auth.uid()
   for update;

  if not found then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'NOT_ENROLLED', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'NOT_ENROLLED');
  end if;

  if not account.is_active or account.revoked_at is not null then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'REVOKED', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'REVOKED');
  end if;

  -- An enrolment with nothing recorded cannot be matched against anything, so it is refused
  -- rather than treated as matching everything.
  if account.device_id is null or account.workstation_id is null then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'BINDING_INCOMPLETE', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'BINDING_INCOMPLETE');
  end if;

  if p_device_id is distinct from account.device_id then
    insert into public.device_claim_events (auth_user_id, device_id, event, detail, app_version)
    values (auth.uid(), p_device_id, 'REFUSED', 'DEVICE_MISMATCH', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'DEVICE_MISMATCH');
  end if;

  if p_workstation_id is distinct from account.workstation_id then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, detail, app_version)
    values (auth.uid(), p_device_id, p_workstation_id, 'REFUSED', 'WORKSTATION_MISMATCH', p_app_version);
    return jsonb_build_object('ok', false, 'reason', 'WORKSTATION_MISMATCH');
  end if;

  new_epoch := account.claim_epoch + 1;
  new_holder := gen_random_uuid();

  update public.device_accounts
     set claim_epoch = new_epoch,
         claim_holder = new_holder,
         last_seen_at = now(),
         last_seen_version = p_app_version
   where auth_user_id = auth.uid();

  -- The previous holder has just been evicted. Recorded as its own line so a copied identity
  -- shows up as a run of supersessions rather than as nothing at all.
  if account.claim_holder is not null then
    insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, claim_epoch, detail, app_version)
    values (auth.uid(), account.device_id, account.workstation_id, 'SUPERSEDED', account.claim_epoch, 'CLAIMED_AGAIN', p_app_version);
  end if;

  insert into public.device_claim_events (auth_user_id, device_id, workstation_id, event, claim_epoch, app_version)
  values (auth.uid(), account.device_id, account.workstation_id, 'CLAIMED', new_epoch, p_app_version);

  return jsonb_build_object('ok', true, 'epoch', new_epoch, 'holder', new_holder);
end;
$$;

revoke all on function public.claim_device(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_device(text, text, text) to authenticated;

create or replace function public.claim_is_current(p_epoch bigint, p_holder uuid)
returns public.device_accounts
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  account public.device_accounts%rowtype;
begin
  select * into account from public.device_accounts
   where auth_user_id = auth.uid()
   for share;

  if not found then
    raise exception 'NOT_ENROLLED' using errcode = '42501';
  end if;
  if not account.is_active or account.revoked_at is not null then
    raise exception 'REVOKED' using errcode = '42501';
  end if;
  if account.device_id is null or account.workstation_id is null then
    raise exception 'BINDING_INCOMPLETE' using errcode = '42501';
  end if;
  if account.claim_epoch = 0 or account.claim_holder is null then
    raise exception 'NOT_CLAIMED' using errcode = '42501';
  end if;
  if p_epoch is distinct from account.claim_epoch or p_holder is distinct from account.claim_holder then
    raise exception 'CLAIM_SUPERSEDED' using errcode = '42501';
  end if;

  return account;
end;
$$;

revoke all on function public.claim_is_current(bigint, uuid) from public, anon, authenticated;

commit;
