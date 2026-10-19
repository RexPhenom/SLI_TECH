-- SLI_TECH · Migration 000: remove 3 EMPTY stub tables so the real schema (001) can be created.
-- Safe-guarded: aborts if any of them contains a row. Rollback: 000_clear_empty_stub_ROLLBACK.sql
do $$ begin
  if (select count(*) from public.smg_services) + (select count(*) from public.smg_orders) + (select count(*) from public.smg_payments) > 0
  then raise exception 'stub tables are not empty; aborting'; end if;
end $$;
drop table public.smg_payments;
drop table public.smg_orders;
drop table public.smg_services;
