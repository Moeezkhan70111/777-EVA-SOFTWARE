-- NOT A MIGRATION. TEST PROJECT ONLY. Run whole through execute_sql or the SQL editor.
-- Functional check of 014 on TEST. Leaves nothing behind: the block ends by raising, so the temporary
-- device, its claim and its health row are all rolled back. PC rows are only READ, to copy not-null
-- columns. Success is the error message 'SYNC_HEALTH_CHECK_PASSED ...'.
do $$
declare
  b text := 'sh-check-device';
  uid uuid := gen_random_uuid();
  holder uuid := gen_random_uuid();
  r jsonb;
  refused boolean;
begin
  insert into public.workstations
  select (jsonb_populate_record(null::public.workstations, to_jsonb(w)
          || jsonb_build_object('id', 'ws-sh-check', 'device_id', b, 'workstation_code', 'SH-CHECK', 'name', 'sh check'))).*
    from public.workstations w where w.device_id = 'desktop-main';
  insert into public.device_accounts
  select (jsonb_populate_record(null::public.device_accounts, to_jsonb(d)
          || jsonb_build_object('auth_user_id', uid, 'device_id', b, 'workstation_id', 'ws-sh-check',
                                'label', 'Health check PC', 'claim_holder', holder, 'claim_epoch', 1))).*
    from public.device_accounts d where d.device_id = 'desktop-main';
  perform set_config('request.jwt.claims', jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- 1. A report lands as this device's row, named from its enrolment. An item's needs is kept only as
  --    text, and nothing else the client adds is kept at all.
  r := public.report_sync_health(1, holder, jsonb_build_object(
    'waiting', 1, 'stuck', 2, 'stale', 1, 'deadLetters', 0, 'unsentMarks', 3,
    'oldestWaitingSince', '2026-10-23T05:00:00.000Z',
    'sample', jsonb_build_array(
      jsonb_build_object('subject', 'Material A', 'waitingFor', 'a category', 'since', '2026-10-23T05:00:00.000Z', 'needs', 'INVENTORY_CATEGORY:c-17'),
      jsonb_build_object('subject', 'Material B', 'waitingFor', 'a unit', 'since', '2026-10-24T05:00:00.000Z', 'needs', 17, 'extra', 'dropped'),
      jsonb_build_object('subject', 'Material C', 'waitingFor', 'a unit', 'since', '2026-10-24T05:00:00.000Z'),
      jsonb_build_object('subject', 'Material D', 'waitingFor', 'a unit', 'since', '2026-10-24T05:00:00.000Z'),
      jsonb_build_object('subject', 'Material E', 'waitingFor', 'a unit', 'since', '2026-10-24T05:00:00.000Z'),
      jsonb_build_object('subject', 'Material F', 'waitingFor', 'a unit', 'since', '2026-10-24T05:00:00.000Z'),
      jsonb_build_object('subject', 'Material G', 'waitingFor', 'a unit', 'since', '2026-10-24T05:00:00.000Z'))));
  if (r->>'accepted')::boolean is distinct from true then raise exception 'STEP 1: %', r; end if;
  if (select label || '|' || stale || '|' || unsent_marks || '|' || jsonb_array_length(sample)
            || '|' || (sample->0->>'needs') || '|' || (sample->1 ? 'needs')::text || '|' || (sample->1 ? 'extra')::text
        from public.device_sync_health where device_id = b)
     is distinct from 'Health check PC|1|3|5|INVENTORY_CATEGORY:c-17|false|false' then
    raise exception 'STEP 1: row %', (select to_jsonb(h) from public.device_sync_health h where device_id = b);
  end if;

  -- 2. A second report OVERWRITES: still one row, now healthy.
  r := public.report_sync_health(1, holder, jsonb_build_object('waiting', 0, 'stuck', 0, 'stale', 0, 'deadLetters', 0, 'unsentMarks', 0, 'oldestWaitingSince', null, 'sample', '[]'::jsonb));
  if (select count(*) from public.device_sync_health where device_id = b) <> 1 then raise exception 'STEP 2: appended'; end if;
  if (select stale + stuck + waiting + jsonb_array_length(sample) from public.device_sync_health where device_id = b) <> 0 then
    raise exception 'STEP 2: not overwritten';
  end if;

  -- 3. A malformed report writes nothing.
  r := public.report_sync_health(1, holder, jsonb_build_object('waiting', -1, 'stuck', 0, 'stale', 0, 'deadLetters', 0, 'unsentMarks', 0));
  if r->>'reason' is distinct from 'REPORT_UNREADABLE' then raise exception 'STEP 3: %', r; end if;

  -- 4. A superseded claim reports nothing.
  refused := false;
  begin
    perform public.report_sync_health(1, gen_random_uuid(), jsonb_build_object('waiting', 0, 'stuck', 0, 'stale', 0, 'deadLetters', 0, 'unsentMarks', 0));
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'STEP 4: a superseded claim reported'; end if;

  raise exception 'SYNC_HEALTH_CHECK_PASSED: all 4 steps (rolled back, nothing kept)';
end;
$$;
