select cron.unschedule('smg-fulfil-worker');
drop function if exists public.smg_worker_secret();
delete from vault.secrets where name = 'smg_worker_secret';
