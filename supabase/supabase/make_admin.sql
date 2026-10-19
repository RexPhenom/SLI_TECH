-- SLI_TECH · make ONE existing account an admin. No password involved.
-- 1) Sign up on the SLI_TECH site first (so the account exists), 2) put your email below, 3) run in SQL editor.
-- Rollback: delete from public.smg_admin_roles where user_id = (select id from auth.users where email = 'YOUR_EMAIL');
insert into public.smg_admin_roles (user_id, role)
select id, 'owner' from auth.users where email = 'saviourinyang743@gmail.com'
on conflict (user_id) do update set role = 'owner';
