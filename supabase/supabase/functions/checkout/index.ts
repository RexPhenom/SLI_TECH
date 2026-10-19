// SLI_TECH · checkout. A signed-in customer asks to buy a service; the SERVER prices it, creates the
// order and starts a Paystack payment. Nothing the browser sends about price or status is trusted.
import { cors, json, rpc, userFrom, ps, rid, failure, PSK, SITE, UUID_RE } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Not found" }, 404);
  if (!PSK || !SITE || SITE === "/") return json(req, { error: "Payments are not configured yet." }, 503);
  const user = await userFrom(req);
  if (!user) return json(req, { error: "Please sign in first." }, 401);
  const text = await req.text();
  if (text.length > 4000) return json(req, { error: "Request too large." }, 413);
  let b: any; try { b = JSON.parse(text); } catch (_) { return json(req, { error: "Invalid request." }, 400); }
  if (typeof b.service_id !== "string" || !UUID_RE.test(b.service_id) || typeof b.link !== "string" ||
      !Number.isInteger(b.quantity) || typeof b.idempotency_key !== "string") return json(req, { error: "Invalid request." }, 400);
  try {
    if (await rpc("smg_rate_hit", { p_bucket: "checkout", p_key: user.id, p_max: 20, p_window_seconds: 3600 }))
      return json(req, { error: "Too many attempts. Please try again later." }, 429);
    const o = await rpc("smg_create_order", { p_user: user.id, p_service: b.service_id, p_link: b.link, p_qty: b.quantity, p_idem: b.idempotency_key });
    if (o.status !== "pending_payment" && o.status !== "payment_processing")
      return json(req, { error: "This order has already been processed.", order_id: o.order_id, status: o.status }, 409);
    const ref = "SLI-" + rid(20);
    const p = await rpc("smg_start_payment", { p_order: o.order_id, p_user: user.id, p_reference: ref });
    const r = await ps("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({ email: p.email, amount: p.amount_kobo, currency: "NGN", reference: ref, callback_url: SITE + "#/pay/return", metadata: { order_id: o.order_id } }),
    });
    if (!r.ok || !r.data || !r.data.authorization_url) return json(req, { error: "Could not start the payment. Please try again." }, 502);
    return json(req, { url: r.data.authorization_url, order_id: o.order_id, reference: ref, amount_kobo: p.amount_kobo });
  } catch (e) { return failure(req, e); }
});
