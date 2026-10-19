-- SLI_TECH · Migration 006: only ONE admin can ever exist, and the website API can never change the admin list.
-- 1) A unique index allows at most one row in smg_admin_roles.
-- 2) A trigger rejects any insert/update/delete unless it comes from the Supabase SQL editor / service role (never from the website or API).
-- Nothing is deleted. Your existing admin row is unchanged. Rollback: 006_lock_admin_ROLLBACK.sql
create unique index smg_admin_one_row on public.smg_admin_roles ((true));

create or replace function private.smg_admin_roles_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return coalesce(new, old); end if;
  raise exception 'The admin list can only be changed from the Supabase SQL editor.';
end $$;
create trigger smg_admin_roles_guard_t before insert or update or delete on public.smg_admin_roles
  for each row execute function private.smg_admin_roles_guard();
