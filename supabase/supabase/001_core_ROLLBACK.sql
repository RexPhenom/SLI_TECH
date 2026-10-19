-- SLI_TECH rollback for Migration A. Removes ONLY smg_ objects created by 001_core.sql. Destroys SLI_TECH data.
drop trigger if exists smg_on_auth_user_created on auth.users;
drop table if exists public.smg_refunds, public.smg_provider_transactions, public.smg_fulfilment_jobs,
  public.smg_webhook_events, public.smg_payments, public.smg_orders, public.smg_service_mappings, public.smg_services,
  public.smg_provider_services, public.smg_providers, public.smg_fx_rates, public.smg_settings, public.smg_audit_logs,
  public.smg_rate_limits, public.smg_profiles, public.smg_admin_roles cascade;
drop function if exists private.smg_new_user(), private.smg_orders_guard(), private.smg_audit_admin(),
  private.smg_audit_immutable(), private.smg_touch(), private.smg_is_admin();
