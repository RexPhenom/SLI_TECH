drop function if exists public.smg_rate_hit(text, text, integer, integer), public.smg_create_order(uuid, uuid, text, integer, text),
  public.smg_start_payment(uuid, uuid, text), public.smg_apply_payment(text, bigint, text, text, text, text, text),
  public.smg_claim_job(integer), public.smg_finish_job(uuid, uuid, text, uuid, text, text, numeric, text);
