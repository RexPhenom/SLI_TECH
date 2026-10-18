// SLI_TECH · verify-payment. After the customer returns from Paystack, ask Paystack (not the browser)
// whether the payment really succeeded, then let the database apply it exactly once.
import { cors, json, rest, rpc, userFrom, ps, failure, PSK, REF_RE } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Not found" }, 404);
  if (!PSK) return json(req, { error: "Payments are not configured yet." }, 503);
  const user = await userFrom(req);
  if (!user) return json(req, { error: "Please sign in first." }, 401);
  let b: any; try { b = JSON.parse(await req.text()); } catch (_) { return json(req, { error: "Invalid request." }, 400); }
  const ref = String(b.reference || "");
  if (!REF_RE.test(ref)) return json(req, { error: "Invalid reference." }, 400);
  try {
    if (await rpc("smg_rate_hit", { p_bucket: "verify", p_key: user.id, p_max: 60, p_window_seconds: 3600 }))
      return json(req, { error: "Too many attempts. Please try again later." }, 429);
    const rows = await rest("smg_payments?select=id,order_id,user_id&reference=eq." + ref + "&limit=1");
    if (!rows || !rows.length || rows[0].user_id !== user.id) return json(req, { error: "Payment not found." }, 404);
    const v = await ps("/transaction/verify/" + encodeURIComponent(ref));
    if (!v.ok || !v.data) return json(req, { error: "We could not check the payment yet. Please try again shortly." }, 502);
    const st = String(v.data.status);
    const map: Record<string, string> = { success: "success", failed: "failed", abandoned: "abandoned", reversed: "reversed" };
    let result = "pending";
    if (map[st]) {
      const r = await rpc("smg_apply_payment", {
        p_reference: ref, p_amount_kobo: Number(v.data.amount), p_currency: String(v.data.currency), p_status: map[st],
        p_gateway_tx: String(v.data.id), p_event_key: null, p_event_type: "verify",
      });
      result = r.result;
    }
    const o = await rest("smg_orders?select=status&id=eq." + rows[0].order_id + "&limit=1");
    return json(req, { payment: st, result, order_status: o && o[0] ? o[0].status : null });
  } catch (e) { return failure(req, e); }
});
