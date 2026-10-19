-- SLI_TECH · Migration A: core schema, row level security, order state rules.
-- Additive only. Every object is prefixed smg_. Safe to run on an empty project.

create schema if not exists private;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------- roles
create table public.smg_admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('owner','admin','support')),
  created_at timestamptz not null default now()
);

create or replace function private.smg_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.smg_admin_roles r where r.user_id = (select auth.uid()));
$$;
revoke all on function private.smg_is_admin() from public, anon;
grant execute on function private.smg_is_admin() to authenticated;

create or replace function private.smg_touch()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------- profiles
create table public.smg_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  phone text check (phone is null or char_length(phone) <= 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger smg_profiles_touch before update on public.smg_profiles
  for each row execute function private.smg_touch();

create or replace function private.smg_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.smg_profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger smg_on_auth_user_created after insert on auth.users
  for each row execute function private.smg_new_user();

-- ---------------------------------------------------------------- settings / fx
create table public.smg_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
create trigger smg_settings_touch before update on public.smg_settings
  for each row execute function private.smg_touch();
insert into public.smg_settings (key, value) values
  ('maintenance_mode','on'), ('checkout_enabled','off'), ('paystack_mode','test'),
  ('min_margin_pct','20'), ('site_notice','');

create table public.smg_fx_rates (
  id bigint generated always as identity primary key,
  base text not null, quote text not null, rate numeric not null check (rate > 0),
  source text not null, fetched_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- providers
create table public.smg_providers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  mode text not null default 'mock' check (mode in ('mock','live')),
  currency text not null default 'INR',
  is_active boolean not null default false,
  last_balance numeric, last_checked_at timestamptz, last_error text,
  created_at timestamptz not null default now()
);
insert into public.smg_providers (code, name, mode, currency) values ('mock','Mock provider (testing)','mock','NGN');

create table public.smg_provider_services (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.smg_providers(id) on delete restrict,
  provider_service_id text not null,
  name text not null,
  rate_per_1000 numeric not null check (rate_per_1000 >= 0),
  currency text not null,
  min_qty integer not null check (min_qty > 0),
  max_qty integer not null check (max_qty >= min_qty),
  refill boolean, cancel boolean,
  is_available boolean not null default true,
  last_synced_at timestamptz not null default now(),
  unique (provider_id, provider_service_id)
);

-- ---------------------------------------------------------------- catalogue
create table public.smg_services (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 140),
  description text check (description is null or char_length(description) <= 2000),
  platform text not null check (char_length(platform) between 2 and 40),
  category text not null check (char_length(category) between 2 and 60),
  price_per_1000_kobo bigint not null check (price_per_1000_kobo > 0),
  min_qty integer not null check (min_qty > 0),
  max_qty integer not null check (max_qty >= min_qty),
  delivery_estimate text,
  refill_info text, limitations text,
  is_active boolean not null default false,
  provider_available boolean not null default false,
  last_price_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger smg_services_touch before update on public.smg_services
  for each row execute function private.smg_touch();

-- which provider service fulfils which local service (kept apart so customers never see it)
create table public.smg_service_mappings (
  service_id uuid primary key references public.smg_services(id) on delete cascade,
  provider_service_pk uuid not null references public.smg_provider_services(id) on delete restrict,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- orders
create table public.smg_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  service_id uuid not null references public.smg_services(id) on delete restrict,
  service_name text not null,
  link text not null check (char_length(link) <= 500 and link ~* '^https?://'),
  quantity integer not null check (quantity > 0),
  unit_price_kobo bigint not null check (unit_price_kobo > 0),   -- retail price per 1000, snapshot
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  status text not null default 'pending_payment' check (status in (
    'pending_payment','payment_processing','paid','queued','submitting','processing',
    'completed','partial','failed','cancelled','refund_pending','refunded','manual_review')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 80),
  provider_id uuid references public.smg_providers(id),
  provider_order_id text,
  provider_cost_minor numeric, provider_currency text, fx_rate numeric, fx_at timestamptz,
  start_count bigint, remains bigint,
  status_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create unique index smg_orders_provider_order_uq on public.smg_orders (provider_id, provider_order_id) where provider_order_id is not null;
create index smg_orders_user_idx on public.smg_orders (user_id, created_at desc);
create index smg_orders_status_idx on public.smg_orders (status, created_at desc);
create trigger smg_orders_touch before update on public.smg_orders
  for each row execute function private.smg_touch();

-- ---------------------------------------------------------------- payments
create table public.smg_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.smg_orders(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  gateway text not null default 'paystack',
  reference text not null unique,
  amount_kobo bigint not null check (amount_kobo > 0),
  currency text not null default 'NGN' check (currency = 'NGN'),
  status text not null default 'pending' check (status in ('pending','success','failed','abandoned','reversed')),
  gateway_tx_id text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index smg_payments_one_success on public.smg_payments (order_id) where status = 'success';
create index smg_payments_user_idx on public.smg_payments (user_id, created_at desc);
create trigger smg_payments_touch before update on public.smg_payments
  for each row execute function private.smg_touch();

create table public.smg_webhook_events (
  id bigint generated always as identity primary key,
  gateway text not null,
  event_key text not null,            -- unique id for the event, used for replay protection
  event_type text,
  payload jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (gateway, event_key)
);

-- ---------------------------------------------------------------- fulfilment
create table public.smg_fulfilment_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.smg_orders(id) on delete restrict,
  status text not null default 'queued' check (status in ('queued','leased','done','failed','manual_review')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  lease_token uuid, leased_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index smg_jobs_due_idx on public.smg_fulfilment_jobs (status, next_attempt_at);
create trigger smg_jobs_touch before update on public.smg_fulfilment_jobs
  for each row execute function private.smg_touch();

create table public.smg_provider_transactions (
  id bigint generated always as identity primary key,
  order_id uuid references public.smg_orders(id) on delete restrict,
  provider_id uuid references public.smg_providers(id),
  action text not null,
  http_status integer,
  outcome text not null check (outcome in ('ok','error','timeout','ambiguous')),
  response jsonb,                      -- never store the API key here
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- refunds
create table public.smg_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.smg_orders(id) on delete restrict,
  payment_id uuid references public.smg_payments(id) on delete restrict,
  kind text not null check (kind in ('customer_payment','provider_wallet')),
  amount_kobo bigint not null check (amount_kobo > 0),
  status text not null default 'requested' check (status in ('requested','approved','processing','completed','rejected','failed')),
  reason text, created_by uuid,
  gateway_refund_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index smg_refunds_one_active on public.smg_refunds (order_id) where status in ('requested','approved','processing','completed');
create trigger smg_refunds_touch before update on public.smg_refunds
  for each row execute function private.smg_touch();

-- ---------------------------------------------------------------- audit + rate limits
create table public.smg_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid, actor_type text not null default 'system' check (actor_type in ('customer','admin','system')),
  action text not null, entity text not null, entity_id text,
  detail jsonb, created_at timestamptz not null default now()
);
create index smg_audit_created_idx on public.smg_audit_logs (created_at desc);

create or replace function private.smg_audit_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'Audit records cannot be changed or deleted.'; end $$;
create trigger smg_audit_no_update before update or delete on public.smg_audit_logs
  for each row execute function private.smg_audit_immutable();

create table public.smg_rate_limits (
  id bigint generated always as identity primary key,
  bucket text not null, key text not null, created_at timestamptz not null default now()
);
create index smg_rate_limits_idx on public.smg_rate_limits (bucket, key, created_at);

-- audit admin edits to the catalogue
create or replace function private.smg_audit_admin()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.smg_audit_logs (actor_id, actor_type, action, entity, entity_id, detail)
  values ((select auth.uid()), case when (select auth.uid()) is null then 'system' else 'admin' end,
          tg_op, tg_table_name, coalesce((to_jsonb(new)->>'id'), (to_jsonb(new)->>'service_id'), (to_jsonb(old)->>'id'), (to_jsonb(old)->>'service_id')),
          jsonb_build_object('new', to_jsonb(new) - 'description', 'old', to_jsonb(old) - 'description'));
  return coalesce(new, old);
end $$;
create trigger smg_services_audit after insert or update or delete on public.smg_services
  for each row execute function private.smg_audit_admin();
create trigger smg_mappings_audit after insert or update or delete on public.smg_service_mappings
  for each row execute function private.smg_audit_admin();

-- ---------------------------------------------------------------- order state machine
create or replace function private.smg_orders_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare ok boolean := false;
begin
  if new.user_id <> old.user_id or new.service_id <> old.service_id or new.link <> old.link
     or new.quantity <> old.quantity or new.unit_price_kobo <> old.unit_price_kobo
     or new.amount_kobo <> old.amount_kobo or new.currency <> old.currency then
    raise exception 'Order details cannot be changed after creation.';
  end if;
  if new.status is distinct from old.status then
    ok := case old.status
      when 'pending_payment'   then new.status in ('payment_processing','paid','cancelled','failed')
      when 'payment_processing' then new.status in ('pending_payment','paid','cancelled','failed')
      when 'paid'              then new.status in ('queued','manual_review','refund_pending')
      when 'queued'            then new.status in ('submitting','manual_review','refund_pending','cancelled')
      when 'submitting'        then new.status in ('processing','manual_review','failed')
      when 'processing'        then new.status in ('completed','partial','failed','manual_review')
      when 'manual_review'     then new.status in ('queued','processing','completed','failed','refund_pending')
      when 'failed'            then new.status in ('refund_pending','manual_review')
      when 'partial'           then new.status in ('refund_pending')
      when 'cancelled'         then new.status in ('refund_pending')
      when 'refund_pending'    then new.status in ('refunded','manual_review')
      else false end;
    if not ok then
      raise exception 'Invalid order status change: % -> %', old.status, new.status;
    end if;
    if new.status in ('paid','queued','submitting','processing','completed','partial')
       and not exists (select 1 from public.smg_payments p where p.order_id = new.id and p.status = 'success') then
      raise exception 'A verified payment is required for status %.', new.status;
    end if;
    insert into public.smg_audit_logs (actor_id, actor_type, action, entity, entity_id, detail)
    values ((select auth.uid()), 'system', 'order_status', 'smg_orders', new.id::text,
            jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $$;
create trigger smg_orders_guard_t before update on public.smg_orders
  for each row execute function private.smg_orders_guard();

-- ================================================================ GRANTS + ROW LEVEL SECURITY
-- start from nothing, then give back only what is needed
do $$
declare t text;
begin
  foreach t in array array['smg_admin_roles','smg_profiles','smg_settings','smg_fx_rates','smg_providers',
    'smg_provider_services','smg_services','smg_service_mappings','smg_orders','smg_payments','smg_webhook_events',
    'smg_fulfilment_jobs','smg_provider_transactions','smg_refunds','smg_audit_logs','smg_rate_limits'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;

-- admin roles: a user may see only their own row; nobody can write from the browser
grant select on public.smg_admin_roles to authenticated;
create policy smg_roles_self on public.smg_admin_roles for select to authenticated using (user_id = (select auth.uid()));

-- profiles: own row, only name and phone can be edited
grant select on public.smg_profiles to authenticated;
grant update (full_name, phone) on public.smg_profiles to authenticated;
create policy smg_profiles_select on public.smg_profiles for select to authenticated using (id = (select auth.uid()) or (select private.smg_is_admin()));
create policy smg_profiles_update on public.smg_profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- settings: public may read only the flags the site needs; admins manage all
grant select on public.smg_settings to anon, authenticated;
grant insert, update on public.smg_settings to authenticated;
create policy smg_settings_public on public.smg_settings for select to anon using (key in ('maintenance_mode','checkout_enabled','site_notice'));
create policy smg_settings_auth on public.smg_settings for select to authenticated using (key in ('maintenance_mode','checkout_enabled','site_notice') or (select private.smg_is_admin()));
create policy smg_settings_ins on public.smg_settings for insert to authenticated with check ((select private.smg_is_admin()));
create policy smg_settings_upd on public.smg_settings for update to authenticated using ((select private.smg_is_admin())) with check ((select private.smg_is_admin()));

-- catalogue: public sees only services that are switched on AND available at the provider
grant select on public.smg_services to anon, authenticated;
grant insert, update, delete on public.smg_services to authenticated;
create policy smg_services_public on public.smg_services for select to anon using (is_active and provider_available);
create policy smg_services_auth on public.smg_services for select to authenticated using ((is_active and provider_available) or (select private.smg_is_admin()));
create policy smg_services_ins on public.smg_services for insert to authenticated with check ((select private.smg_is_admin()));
create policy smg_services_upd on public.smg_services for update to authenticated using ((select private.smg_is_admin())) with check ((select private.smg_is_admin()));
create policy smg_services_del on public.smg_services for delete to authenticated using ((select private.smg_is_admin()));

-- admin-only tables (read for admins; writes by the server only, unless noted)
grant select on public.smg_providers, public.smg_provider_services, public.smg_fx_rates, public.smg_webhook_events,
  public.smg_fulfilment_jobs, public.smg_provider_transactions, public.smg_refunds, public.smg_audit_logs to authenticated;
create policy smg_providers_admin on public.smg_providers for select to authenticated using ((select private.smg_is_admin()));
create policy smg_pservices_admin on public.smg_provider_services for select to authenticated using ((select private.smg_is_admin()));
create policy smg_fx_admin on public.smg_fx_rates for select to authenticated using ((select private.smg_is_admin()));
create policy smg_webhooks_admin on public.smg_webhook_events for select to authenticated using ((select private.smg_is_admin()));
create policy smg_jobs_admin on public.smg_fulfilment_jobs for select to authenticated using ((select private.smg_is_admin()));
create policy smg_ptx_admin on public.smg_provider_transactions for select to authenticated using ((select private.smg_is_admin()));
create policy smg_refunds_admin on public.smg_refunds for select to authenticated using ((select private.smg_is_admin()));
create policy smg_audit_admin on public.smg_audit_logs for select to authenticated using ((select private.smg_is_admin()));

-- service mappings: admins manage
grant select, insert, update, delete on public.smg_service_mappings to authenticated;
create policy smg_map_sel on public.smg_service_mappings for select to authenticated using ((select private.smg_is_admin()));
create policy smg_map_ins on public.smg_service_mappings for insert to authenticated with check ((select private.smg_is_admin()));
create policy smg_map_upd on public.smg_service_mappings for update to authenticated using ((select private.smg_is_admin())) with check ((select private.smg_is_admin()));
create policy smg_map_del on public.smg_service_mappings for delete to authenticated using ((select private.smg_is_admin()));

-- orders: customers read their own (without provider cost columns); admins read all; nobody writes from the browser
grant select (id, user_id, service_id, service_name, link, quantity, unit_price_kobo, amount_kobo, currency, status,
              start_count, remains, status_note, created_at, updated_at) on public.smg_orders to authenticated;
create policy smg_orders_own on public.smg_orders for select to authenticated using (user_id = (select auth.uid()) or (select private.smg_is_admin()));

-- payments: customers read their own; admins read all
grant select (id, order_id, user_id, gateway, reference, amount_kobo, currency, status, verified_at, created_at) on public.smg_payments to authenticated;
create policy smg_payments_own on public.smg_payments for select to authenticated using (user_id = (select auth.uid()) or (select private.smg_is_admin()));

-- smg_rate_limits has RLS on and no policy and no grants: only the server (service role) can use it.
