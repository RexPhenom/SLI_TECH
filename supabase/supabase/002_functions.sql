-- SLI_TECH · Migration B: trusted server-side functions (callable only by the service role).

create or replace function public.smg_rate_hit(p_bucket text, p_key text, p_max integer, p_window_seconds integer)
returns boolean language plpgsql set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.smg_rate_limits
   where bucket = p_bucket and key = p_key and created_at > now() - make_interval(secs => p_window_seconds);
  if n >= p_max then return true; end if;
  insert into public.smg_rate_limits (bucket, key) values (p_bucket, p_key);
  if random() < 0.02 then delete from public.smg_rate_limits where created_at < now() - interval '1 day'; end if;
  return false;
end $$;

create or replace function public.smg_create_order(p_user uuid, p_service uuid, p_link text, p_qty integer, p_idem text)
returns jsonb language plpgsql set search_path = '' as $$
declare s public.smg_services; o public.smg_orders; amt bigint; pend integer; v text;
begin
  if p_idem is null or char_length(p_idem) not between 8 and 80 then raise exception 'bad_request'; end if;
  select * into o from public.smg_orders where user_id = p_user and idempotency_key = p_idem;
  if found then
    return jsonb_build_object('order_id', o.id, 'amount_kobo', o.amount_kobo, 'status', o.status, 'existing', true);
  end if;
  select value into v from public.smg_settings where key = 'maintenance_mode';
  if coalesce(v, 'on') <> 'off' then raise exception 'maintenance'; end if;
  select value into v from public.smg_settings where key = 'checkout_enabled';
  if coalesce(v, 'off') <> 'on' then raise exception 'checkout_disabled'; end if;
  p_link := btrim(coalesce(p_link, ''));
  if char_length(p_link) > 500 or p_link !~* '^https?://[^[:space:]]+$' then raise exception 'invalid_link'; end if;
  select * into s from public.smg_services where id = p_service and is_active and provider_available;
  if not found then raise exception 'service_unavailable'; end if;
  if p_qty is null or p_qty < s.min_qty or p_qty > s.max_qty then raise exception 'invalid_quantity'; end if;
  select count(*) into pend from public.smg_orders
   where user_id = p_user and status in ('pending_payment','payment_processing') and created_at > now() - interval '1 hour';
  if pend >= 10 then raise exception 'too_many_pending'; end if;
  amt := ceil(p_qty::numeric * s.price_per_1000_kobo / 1000)::bigint;
  if amt < 10000 then raise exception 'amount_too_small'; end if;
  begin
    insert into public.smg_orders (user_id, service_id, service_name, link, quantity, unit_price_kobo, amount_kobo, idempotency_key)
    values (p_user, s.id, s.name, p_link, p_qty, s.price_per_1000_kobo, amt, p_idem) returning * into o;
  exception when unique_violation then
    select * into o from public.smg_orders where user_id = p_user and idempotency_key = p_idem;
    return jsonb_build_object('order_id', o.id, 'amount_kobo', o.amount_kobo, 'status', o.status, 'existing', true);
  end;
  insert into public.smg_audit_logs (actor_id, actor_type, action, entity, entity_id, detail)
  values (p_user, 'customer', 'order_created', 'smg_orders', o.id::text, jsonb_build_object('service', s.id, 'qty', p_qty, 'amount_kobo', amt));
  return jsonb_build_object('order_id', o.id, 'amount_kobo', amt, 'status', o.status, 'existing', false);
end $$;

create or replace function public.smg_start_payment(p_order uuid, p_user uuid, p_reference text)
returns jsonb language plpgsql set search_path = '' as $$
declare o public.smg_orders; em text;
begin
  if p_reference is null or p_reference !~ '^SLI-[A-Za-z0-9]{10,40}$' then raise exception 'bad_request'; end if;
  select * into o from public.smg_orders where id = p_order and user_id = p_user for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status not in ('pending_payment','payment_processing') then raise exception 'order_not_payable'; end if;
  if exists (select 1 from public.smg_payments where order_id = o.id and status = 'success') then raise exception 'already_paid'; end if;
  update public.smg_payments set status = 'abandoned' where order_id = o.id and status = 'pending';
  insert into public.smg_payments (order_id, user_id, reference, amount_kobo) values (o.id, p_user, p_reference, o.amount_kobo);
  if o.status = 'pending_payment' then update public.smg_orders set status = 'payment_processing' where id = o.id; end if;
  select email into em from auth.users where id = p_user;
  return jsonb_build_object('amount_kobo', o.amount_kobo, 'currency', 'NGN', 'email', em);
end $$;

create or replace function public.smg_apply_payment(p_reference text, p_amount_kobo bigint, p_currency text, p_status text,
                                                    p_gateway_tx text, p_event_key text, p_event_type text)
returns jsonb language plpgsql set search_path = '' as $$
declare pay public.smg_payments; o public.smg_orders; ev bigint; res jsonb;
begin
  if p_event_key is not null then
    insert into public.smg_webhook_events (gateway, event_key, event_type) values ('paystack', p_event_key, p_event_type)
      on conflict do nothing returning id into ev;
    if ev is null and exists (select 1 from public.smg_webhook_events where gateway = 'paystack' and event_key = p_event_key and processed_at is not null) then
      return jsonb_build_object('result', 'duplicate_event');
    end if;
  end if;
  select * into pay from public.smg_payments where reference = p_reference for update;
  if not found then return jsonb_build_object('result', 'unknown_reference'); end if;
  select * into o from public.smg_orders where id = pay.order_id for update;

  if p_status = 'success' then
    if pay.status = 'success' then
      res := jsonb_build_object('result', 'already_applied');
    elsif p_currency is distinct from 'NGN' or p_amount_kobo is distinct from pay.amount_kobo then
      insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
      values ('system', 'payment_mismatch', 'smg_payments', pay.id::text, jsonb_build_object('expected', pay.amount_kobo, 'got', p_amount_kobo, 'currency', p_currency));
      res := jsonb_build_object('result', 'mismatch');
    elsif exists (select 1 from public.smg_payments where order_id = pay.order_id and status = 'success' and id <> pay.id) then
      insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
      values ('system', 'duplicate_payment', 'smg_payments', pay.id::text, jsonb_build_object('reference', p_reference, 'order', pay.order_id));
      res := jsonb_build_object('result', 'duplicate_payment');
    else
      update public.smg_payments set status = 'success', gateway_tx_id = p_gateway_tx, verified_at = now() where id = pay.id;
      if o.status in ('pending_payment','payment_processing') then
        update public.smg_orders set status = 'paid' where id = o.id;
        update public.smg_orders set status = 'queued' where id = o.id;
        insert into public.smg_fulfilment_jobs (order_id) values (o.id) on conflict (order_id) do nothing;
        insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
        values ('system', 'payment_verified', 'smg_payments', pay.id::text, jsonb_build_object('order', o.id, 'amount_kobo', pay.amount_kobo));
        res := jsonb_build_object('result', 'paid', 'order_id', o.id);
      else
        insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
        values ('system', 'late_payment', 'smg_payments', pay.id::text, jsonb_build_object('order', o.id, 'order_status', o.status));
        res := jsonb_build_object('result', 'order_not_payable');
      end if;
    end if;
  elsif p_status in ('failed','abandoned') then
    if pay.status = 'pending' then update public.smg_payments set status = p_status where id = pay.id; end if;
    if o.status = 'payment_processing' and not exists (select 1 from public.smg_payments where order_id = o.id and status = 'pending') then
      update public.smg_orders set status = 'pending_payment' where id = o.id;
    end if;
    res := jsonb_build_object('result', 'recorded');
  elsif p_status = 'reversed' then
    if pay.status = 'success' then
      update public.smg_payments set status = 'reversed' where id = pay.id;
      if o.status in ('paid','queued','submitting','processing') then update public.smg_orders set status = 'manual_review', status_note = 'Payment reversed; needs review.' where id = o.id; end if;
      insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
      values ('system', 'payment_reversed', 'smg_payments', pay.id::text, jsonb_build_object('order', o.id));
    end if;
    res := jsonb_build_object('result', 'reversed');
  else
    res := jsonb_build_object('result', 'ignored');
  end if;

  if p_event_key is not null then
    update public.smg_webhook_events set processed_at = now() where gateway = 'paystack' and event_key = p_event_key;
  end if;
  return res;
end $$;

create or replace function public.smg_claim_job(p_lease_seconds integer default 180)
returns jsonb language plpgsql set search_path = '' as $$
declare j public.smg_fulfilment_jobs; o public.smg_orders; tok uuid := gen_random_uuid(); r record;
begin
  -- a worker that died while submitting leaves the provider state unknown: never resend blindly
  for r in select j2.id as jid, j2.order_id as oid from public.smg_fulfilment_jobs j2
           join public.smg_orders o2 on o2.id = j2.order_id
           where j2.status = 'leased' and j2.leased_until < now() and o2.status = 'submitting'
           for update of j2 skip locked loop
    update public.smg_fulfilment_jobs set status = 'manual_review', last_error = 'Lease expired while submitting; provider state unknown.' where id = r.jid;
    update public.smg_orders set status = 'manual_review', status_note = 'Submission result unknown; check the provider before retrying.' where id = r.oid;
    insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
    values ('system', 'job_lease_expired', 'smg_fulfilment_jobs', r.jid::text, jsonb_build_object('order', r.oid));
  end loop;

  select * into j from public.smg_fulfilment_jobs
   where status = 'queued' and next_attempt_at <= now() order by next_attempt_at
   for update skip locked limit 1;
  if not found then return null; end if;

  select * into o from public.smg_orders where id = j.order_id for update;
  if o.provider_order_id is not null then
    update public.smg_fulfilment_jobs set status = 'done', last_error = 'Already submitted to provider.' where id = j.id;
    return null;
  end if;
  if o.status not in ('queued','submitting') then
    update public.smg_fulfilment_jobs set status = 'failed', last_error = 'Order is not submittable (' || o.status || ').' where id = j.id;
    return null;
  end if;
  if o.status = 'queued' then update public.smg_orders set status = 'submitting' where id = o.id; end if;
  update public.smg_fulfilment_jobs
     set status = 'leased', lease_token = tok, leased_until = now() + make_interval(secs => p_lease_seconds), attempts = attempts + 1
   where id = j.id;
  return jsonb_build_object('job_id', j.id, 'order_id', o.id, 'lease_token', tok, 'attempts', j.attempts + 1,
                            'link', o.link, 'quantity', o.quantity, 'service_id', o.service_id);
end $$;

create or replace function public.smg_finish_job(p_job uuid, p_token uuid, p_outcome text, p_provider uuid,
                                                 p_provider_order text, p_error text, p_cost numeric, p_cost_currency text)
returns jsonb language plpgsql set search_path = '' as $$
declare j public.smg_fulfilment_jobs; err text := left(coalesce(p_error, ''), 300);
begin
  select * into j from public.smg_fulfilment_jobs where id = p_job and lease_token = p_token and status = 'leased' for update;
  if not found then raise exception 'lease_lost'; end if;

  if p_outcome = 'submitted' then
    if p_provider_order is null or btrim(p_provider_order) = '' then raise exception 'bad_provider_order'; end if;
    update public.smg_orders set status = 'processing', provider_id = p_provider, provider_order_id = btrim(p_provider_order),
           provider_cost_minor = p_cost, provider_currency = p_cost_currency, status_note = null where id = j.order_id;
    update public.smg_fulfilment_jobs set status = 'done', last_error = null, lease_token = null where id = j.id;
  elsif p_outcome = 'rejected' then
    update public.smg_orders set status = 'failed', status_note = coalesce(nullif(err, ''), 'The provider rejected this order.') where id = j.order_id;
    update public.smg_fulfilment_jobs set status = 'failed', last_error = err, lease_token = null where id = j.id;
  elsif p_outcome = 'retry' then
    if j.attempts >= j.max_attempts then
      update public.smg_orders set status = 'manual_review', status_note = 'Several attempts failed; needs review.' where id = j.order_id;
      update public.smg_fulfilment_jobs set status = 'manual_review', last_error = err, lease_token = null where id = j.id;
    else
      update public.smg_fulfilment_jobs set status = 'queued', last_error = err, lease_token = null,
             next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, j.attempts)::integer)) where id = j.id;
    end if;
  elsif p_outcome = 'ambiguous' then
    update public.smg_orders set status = 'manual_review', status_note = 'Provider response unclear; check before retrying.' where id = j.order_id;
    update public.smg_fulfilment_jobs set status = 'manual_review', last_error = err, lease_token = null where id = j.id;
  else
    raise exception 'bad_outcome';
  end if;
  insert into public.smg_audit_logs (actor_type, action, entity, entity_id, detail)
  values ('system', 'job_' || p_outcome, 'smg_fulfilment_jobs', j.id::text, jsonb_build_object('order', j.order_id));
  return jsonb_build_object('ok', true);
end $$;

-- only the server (service role) may run these
revoke all on function public.smg_rate_hit(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.smg_create_order(uuid, uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.smg_start_payment(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.smg_apply_payment(text, bigint, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.smg_claim_job(integer) from public, anon, authenticated;
revoke all on function public.smg_finish_job(uuid, uuid, text, uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.smg_rate_hit(text, text, integer, integer) to service_role;
grant execute on function public.smg_create_order(uuid, uuid, text, integer, text) to service_role;
grant execute on function public.smg_start_payment(uuid, uuid, text) to service_role;
grant execute on function public.smg_apply_payment(text, bigint, text, text, text, text, text) to service_role;
grant execute on function public.smg_claim_job(integer) to service_role;
grant execute on function public.smg_finish_job(uuid, uuid, text, uuid, text, text, numeric, text) to service_role;
