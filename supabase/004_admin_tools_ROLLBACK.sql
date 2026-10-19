drop function if exists public.smg_admin_order_action(uuid, text, text);
drop policy if exists smg_providers_upd on public.smg_providers;
revoke update (is_active) on public.smg_providers from authenticated;
drop policy if exists smg_pservices_ins on public.smg_provider_services;
drop policy if exists smg_pservices_upd on public.smg_provider_services;
revoke insert, update on public.smg_provider_services from authenticated;
