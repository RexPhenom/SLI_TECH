-- SLI_TECH · Migration 004: tools the admin dashboard needs. Additive only.
-- 1) admins may add/edit provider service rows (the catalogue the provider offers; mock rows for testing)
-- 2) admins may switch a provider on/off
-- 3) one function for the order actions an admin is allowed to take (re-queue, fail, start/finish a refund), all audited.
-- Rollback: 004_admin_tools_ROLLBACK.sql

grant insert, update on public.smg_provider_services to authenticated;
create policy smg_pservices_ins on public.smg_provider_services for insert to authenticated with check ((select private.smg_is_admin()));
create policy smg_pservices_upd on public.smg_provider_services for update to authenticated using ((select private.smg_is_admin())) with check ((select private.smg_is_admin()));
grant update (is_active) on public.smg_providers to authenticated;
create policy smg_providers_upd on public.smg_providers for update to authenticated using ((select private.smg_is_admin())) with check ((select private.smg_is_admin()));

create or replace function public.smg_admin_order_action(p_order uuid, p_action text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.smg_orders; n text := left(coalesce(p_note, ''), 300); pay uuid;
begin
  if not (select private.smg_is_admin()) then raise exception 'not_admin'; end if;
  select * into o from public.smg_orders where id = p_order for update;
  if not found then raise exception 'order_not_found'; end if;

  if p_action = 'retry' then
    if o.status <> 'manual_review' or o.provider_order_id is not null then raise exception 'cannot_retry'; end if;
    update public.smg_orders set status = 'queued', status_note = null where id = o.id;
    update public.smg_fulfilment_jobs set status = 'queued', attempts = 0, lease_token = null, next_attempt_at = now(), last_error = null where order_id = o.id;
  elsif p_action = 'fail' then
    if o.status <> 'manual_review' then raise exception 'cannot_fail'; end if;
    update public.smg_orders set status = 'failed', status_note = coalesce(nullif(n, ''), 'This order could not be delivered.') where id = o.id;
  elsif p_action = 'refund_start' then
    if o.status not in ('failed','partial','cancelled','manual_review') then raise exception 'cannot_refund'; end if;
    select id into pay from public.smg_payments where order_id = o.id and status = 'success' limit 1;
    if pay is null then raise exception 'no_payment'; end if;
    update public.smg_orders set status = 'refund_pending', status_note = coalesce(nullif(n, ''), 'A refund has been started.') where id = o.id;
    insert into public.smg_refunds (order_id, payment_id, kind, amount_kobo, status, reason, created_by)
      values (o.id, pay, 'customer_payment', o.amount_kobo, 'requested', n, (select auth.uid()));
  elsif p_action = 'refund_done' then
    if o.status <> 'refund_pending' then raise exception 'cannot_finish_refund'; end if;
    update public.smg_refunds set status = 'completed' where order_id = o.id and status in ('requested','approved','processing');
    update public.smg_orders set status = 'refunded', status_note = coalesce(nullif(n, ''), 'Your refund has been issued.') where id = o.id;
  else
    raise exception 'bad_action';
  end if;
  insert into public.smg_audit_logs (actor_id, actor_type, action, entity, entity_id, detail)
  values ((select auth.uid()), 'admin', 'order_' || p_action, 'smg_orders', o.id::text, jsonb_build_object('note', n));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.smg_admin_order_action(uuid, text, text) from public, anon;
grant execute on function public.smg_admin_order_action(uuid, text, text) to authenticated;
