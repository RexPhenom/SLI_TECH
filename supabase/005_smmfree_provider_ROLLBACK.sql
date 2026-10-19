-- Removes SmmFree only if nothing references it yet.
delete from public.smg_providers where code = 'smmfree'
  and not exists (select 1 from public.smg_provider_services s where s.provider_id = public.smg_providers.id)
  and not exists (select 1 from public.smg_orders o where o.provider_id = public.smg_providers.id);
