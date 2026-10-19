// SLI_TECH · Paystack webhook. Trusts nothing in the request except a correct signature, then
// re-checks the transaction with Paystack and lets the database apply it once (replay-safe).
import { ps, rpc, hmac512, safeEq, PSK, REF_RE } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!PSK) return new Response("not configured", { status: 503 });
  const text = await req.text();
  if (text.length > 100000) return new Response("too large", { status: 413 });
  const sig = req.headers.get("x-paystack-signature") || "";
  if (!safeEq(sig, await hmac512(PSK, text))) return new Response("invalid signature", { status: 401 });
  let ev: any; try { ev = JSON.parse(text); } catch (_) { return new Response("ok", { status: 200 }); }
  const d = ev && ev.data ? ev.data : {};
  const ref = typeof d.reference === "string" ? d.reference : "";
  if (ev.event === "charge.success" && REF_RE.test(ref)) {
    try {
      const v = await ps("/transaction/verify/" + encodeURIComponent(ref));
      if (!v.ok || !v.data) return new Response("verify failed", { status: 500 });   // Paystack will retry
      if (v.data.status === "success") {
        await rpc("smg_apply_payment", {
          p_reference: ref, p_amount_kobo: Number(v.data.amount), p_currency: String(v.data.currency), p_status: "success",
          p_gateway_tx: String(v.data.id), p_event_key: "charge.success:" + String(v.data.id), p_event_type: "charge.success",
        });
      }
    } catch (e) {
      console.error("webhook error:", e instanceof Error ? e.message : "");
      return new Response("error", { status: 500 });
    }
  }
  return new Response("ok", { status: 200 });
});
