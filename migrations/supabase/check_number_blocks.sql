-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor, after 018.
-- Functional check of 018 on TEST. Leaves nothing behind: the block ends by raising, so every
-- write in it -- the temporary devices, their claims, the registry rows -- is rolled back.
-- Success is the error message 'NUMBER_BLOCK_CHECK_PASSED ...'. Any other error names the failed step.
--
-- The temporary devices copy an existing enrolment's row as a template so every not-null column is
-- filled. The template itself is only read: nothing claims as it, and nothing changes it.
do $$
declare
  template text := (select device_id from public.device_accounts where device_id is not null order by enrolled_at limit 1);
  ids uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  names text[] := array['blk-check-a', 'blk-check-b', 'blk-check-c'];
  r jsonb;
  refused boolean;
  i int;
begin
  for i in 1..3 loop
    insert into public.workstations
    select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
            || jsonb_build_object('id', 'ws-' || names[i], 'device_id', names[i], 'workstation_code', upper(names[i]), 'name', names[i]))).*
      from public.workstations w where w.device_id = template;
    insert into public.device_accounts
    select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
            || jsonb_build_object('auth_user_id', ids[i], 'device_id', names[i], 'workstation_id', 'ws-' || names[i],
                                  'label', names[i], 'claim_holder', null, 'claim_epoch', 0))).*
      from public.device_accounts d where d.device_id = template;
  end loop;
  -- Blocks 7-9 are far beyond any computer in use (MAX_ASSIGNABLE_BLOCK is 5).

  -- 1. A claim without a block is refused, and takes no epoch.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.claim_device('blk-check-a', 'ws-blk-check-a', 'check');
  if r->>'reason' is distinct from 'NUMBER_BLOCK_MISSING' then raise exception 'STEP 1: claim without a block: %', r; end if;
  if (select claim_epoch from public.device_accounts where auth_user_id = ids[1]) <> 0 then raise exception 'STEP 1: refusal took an epoch'; end if;

  -- 2. The first claim of a block registers it.
  r := public.claim_device('blk-check-a', 'ws-blk-check-a', 'check', 9);
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 2: first claim of block 9 refused: %', r; end if;
  if (select device_id from public.number_blocks where block = 9) is distinct from 'blk-check-a' then raise exception 'STEP 2: block 9 not registered to A'; end if;

  -- 3. Claiming it again is an ordinary claim: no second registration.
  r := public.claim_device('blk-check-a', 'ws-blk-check-a', 'check', 9);
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 3: reclaim refused: %', r; end if;
  if (select count(*) from public.number_block_events where block = 9) <> 1 then raise exception 'STEP 3: registered twice'; end if;

  -- 4. THE INCIDENT: a second computer on a block already taken is refused, and takes no epoch.
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.claim_device('blk-check-b', 'ws-blk-check-b', 'check', 9);
  if r->>'reason' is distinct from 'NUMBER_BLOCK_TAKEN' or (r->>'block')::int <> 9 then raise exception 'STEP 4: second computer on block 9: %', r; end if;
  if (select claim_epoch from public.device_accounts where auth_user_id = ids[2]) <> 0 then raise exception 'STEP 4: refusal took an epoch'; end if;
  if r ? 'heldBy' or r::text like '%blk-check-a%' then raise exception 'STEP 4: refusal names the holder: %', r; end if;

  -- 5. A computer claiming another block than its own (a swapped database) is refused.
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  r := public.claim_device('blk-check-a', 'ws-blk-check-a', 'check', 8);
  if r->>'reason' is distinct from 'NUMBER_BLOCK_CHANGED' or (r->>'block')::int <> 9 then raise exception 'STEP 5: changed block: %', r; end if;
  if exists (select 1 from public.number_blocks where block = 8) then raise exception 'STEP 5: block 8 registered by a refused claim'; end if;

  -- 6. Every write refuses a device that holds no block, even with a claim taken before 018.
  update public.device_accounts set claim_epoch = 1, claim_holder = ids[3] where auth_user_id = ids[3];
  perform set_config('request.jwt.claim.sub', ids[3]::text, true);
  refused := false;
  begin
    perform public.heartbeat_device(1, ids[3]);
  exception when insufficient_privilege then
    refused := sqlerrm = 'NUMBER_BLOCK_NOT_REGISTERED';
  end;
  if not refused then raise exception 'STEP 6: a device with no block passed claim_is_current'; end if;

  -- 7. The owner's move: a reason is required, and a device already holding a block cannot take another.
  perform set_config('request.jwt.claim.sub', ids[2]::text, true);
  r := public.claim_device('blk-check-b', 'ws-blk-check-b', 'check', 7);
  if (r->>'ok')::boolean is distinct from true then raise exception 'STEP 7: B refused block 7: %', r; end if;
  refused := false;
  begin
    perform public.reassign_number_block(9, 'blk-check-c', 'short');
  exception when others then refused := sqlerrm like 'REASON_REQUIRED%';
  end;
  if not refused then raise exception 'STEP 7: reassigned without a reason'; end if;
  refused := false;
  begin
    perform public.reassign_number_block(9, 'blk-check-b', 'B already holds block 7');
  exception when others then refused := sqlerrm like 'DEVICE_HOLDS_ANOTHER_BLOCK%';
  end;
  if not refused then raise exception 'STEP 7: a device took a second block'; end if;

  -- 8. Block 9 moves to C, recorded with its reason; A then writes nothing, and C writes.
  r := public.reassign_number_block(9, 'blk-check-c', 'check: C holds what A held');
  if r->>'from' is distinct from 'blk-check-a' then raise exception 'STEP 8: reassignment: %', r; end if;
  if (select string_agg(event || ':' || coalesce(previous_device_id, '-'), ',' order by seq) from public.number_block_events where block = 9)
     is distinct from 'REGISTERED:-,REASSIGNED:blk-check-a' then
    raise exception 'STEP 8: block 9 history wrong';
  end if;
  perform set_config('request.jwt.claim.sub', ids[1]::text, true);
  refused := false;
  begin
    perform public.heartbeat_device((select claim_epoch from public.device_accounts where auth_user_id = ids[1]),
                                    (select claim_holder from public.device_accounts where auth_user_id = ids[1]));
  exception when insufficient_privilege then refused := sqlerrm = 'NUMBER_BLOCK_NOT_REGISTERED';
  end;
  if not refused then raise exception 'STEP 8: the old holder still writes'; end if;
  perform set_config('request.jwt.claim.sub', ids[3]::text, true);
  perform public.heartbeat_device(1, ids[3]);

  -- 9. The history cannot be rewritten.
  refused := false;
  begin
    update public.number_block_events set reason = 'rewritten';
  exception when others then refused := sqlerrm = 'number_block_events is append-only';
  end;
  if not refused then raise exception 'STEP 9: block history could be rewritten'; end if;

  -- 10. A signed-in client reads no block and moves none.
  set local role authenticated;
  refused := false;
  begin
    perform 1 from public.number_blocks;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 10: a client read the registry'; end if;
  refused := false;
  begin
    perform public.reassign_number_block(9, 'blk-check-a', 'check: a client tries');
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'STEP 10: a client moved a block'; end if;
  reset role;

  raise exception 'NUMBER_BLOCK_CHECK_PASSED: all 10 steps (rolled back, nothing kept)';
end;
$$;
