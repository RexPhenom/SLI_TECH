drop trigger if exists smg_admin_roles_guard_t on public.smg_admin_roles;
drop function if exists private.smg_admin_roles_guard();
create or replace function private.smg_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.smg_admin_roles r where r.user_id = (select auth.uid()));
$$;
