-- SLI_TECH · Migration 005: register SmmFree as a provider. Inactive until you switch it on in the admin. Additive only.
-- Rollback: 005_smmfree_provider_ROLLBACK.sql
insert into public.smg_providers (code, name, mode, currency, is_active)
values ('smmfree', 'SmmFree', 'live', 'INR', false)
on conflict (code) do nothing;
