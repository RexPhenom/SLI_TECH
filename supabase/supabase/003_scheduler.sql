-- SLI_TECH · Migration C: run the fulfilment worker every minute.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault;

select vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'smg_worker_secret', 'SLI_TECH worker schedule secret');

create or replace function public.smg_worker_secret()
returns text language sql security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'smg_worker_secret' limit 1;
$$;
revoke all on function public.smg_worker_secret() from public, anon, authenticated;
grant execute on function public.smg_worker_secret() to service_role;

select cron.schedule('smg-fulfil-worker', '* * * * *', $job$
  select net.http_post(
    url := 'https://pedjksnjyltbkjhstaqp.supabase.co/functions/v1/fulfil-worker',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'smg_worker_secret' limit 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
$job$);
