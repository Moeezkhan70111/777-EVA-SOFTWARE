-- Reverses 019: rls_auto_enable() goes back to PostgreSQL's default, EXECUTE for PUBLIC, which
-- anon and authenticated inherit. Harmless in itself (see 019's header): a direct call does nothing.
-- The event trigger works either way.

begin;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    grant execute on function public.rls_auto_enable() to public;
  end if;
end;
$$;

commit;
