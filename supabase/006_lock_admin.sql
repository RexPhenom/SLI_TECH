-- SLI_TECH · Migration 006: lock the admin down. Additive/replace-only, nothing is deleted.
-- 1) Admin powers now require a TWO-STEP verified session (aal2), not just a password.
-- 2) The admin list (smg_admin_roles) can only be changed from the Supabase SQL editor / service role, never through the website API.
-- Rollback: 006_lock_admin_ROLLBACK.sql
create or replace function private.smg_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.smg_admin_roles r where r.user_id = (select auth.uid()))
     and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2';
$$;

create or replace function private.smg_admin_roles_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return coalesce(new, old); end if;
  raise exception 'The admin list can only be changed from the Supabase SQL editor.';
end $$;
create trigger smg_admin_roles_guard_t before insert or update or delete on public.smg_admin_roles
  for each row execute function private.smg_admin_roles_guard();
