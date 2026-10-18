// SLI_TECH · fulfilment worker. Runs on a schedule (not from a browser). Claims paid orders one at a time,
// submits them to the provider, then follows active orders to their final status.
// The schedule secret lives in the database vault (read through a service-role-only function).
// Secret: SMMFREE_API_KEY (only for a live SmmFree provider).
import { rest, rpc, safeEq } from "./_shared.ts";
import { mockProvider, smmfree, type Provider } from "./provider.ts";

let WORKER_SECRET = "";
const SMMFREE_KEY = Deno.env.get("SMMFREE_API_KEY") || "";
const cache: Record<string, { p: Provider; row: any } | null> = {};

async function providerById(id: string) {
  if (id in cache) return cache[id];
  const rows = await rest("smg_providers?select=*&id=eq." + id + "&is_active=eq.true&limit=1");
  const row = rows && rows[0];
  let p: Provider | null = null;
  if (row) p = row.mode === "mock" ? mockProvider : row.code === "smmfree" && SMMFREE_KEY ? smmfree(SMMFREE_KEY) : null;
  return (cache[id] = p ? { p, row } : null);
}
const logTx = (order: string | null, provider: string, action: string, outcome: string, response: unknown, http?: number) =>
  rest("smg_provider_transactions", { method: "POST", body: JSON.stringify({ order_id: order, provider_id: provider, action, outcome, http_status: http ?? null, response }), headers: { Prefer: "return=minimal" } }).catch(() => {});

Deno.serve(async (req) => {
  if (!WORKER_SECRET) { try { WORKER_SECRET = (await rpc("smg_worker_secret", {})) || ""; } catch (_) { /* not ready */ } }
  if (!safeEq(req.headers.get("x-worker-secret") || "", WORKER_SECRET)) return new Response("forbidden", { status: 403 });
  const out = { submitted: 0, rejected: 0, retried: 0, manual: 0, synced: 0, errors: 0 };
  try {
    // 1. submit paid orders
    for (let i = 0; i < 4; i++) {
      const job = await rpc("smg_claim_job", { p_lease_seconds: 120 });
      if (!job) break;
      try {
        const rows = await rest("smg_service_mappings?select=smg_provider_services(id,provider_id,provider_service_id,rate_per_1000,currency,is_available,min_qty,max_qty)&service_id=eq." + job.service_id + "&limit=1");
        const ps = rows && rows[0] && rows[0].smg_provider_services;
        const prov = ps && ps.is_available ? await providerById(ps.provider_id) : null;
        if (!ps || !prov || job.quantity < ps.min_qty || job.quantity > ps.max_qty) {
          await rpc("smg_finish_job", { p_job: job.job_id, p_token: job.lease_token, p_outcome: "retry", p_provider: null, p_provider_order: null, p_error: "No usable provider mapping for this service.", p_cost: null, p_cost_currency: null });
          out.retried++; continue;
        }
        const r = await prov.p.submit(ps.provider_service_id, job.link, job.quantity);
        await logTx(job.order_id, ps.provider_id, "add", r.outcome === "submitted" ? "ok" : r.outcome === "ambiguous" ? "ambiguous" : "error",
                    r.outcome === "submitted" ? { order: r.providerOrder } : { error: r.error });
        const cost = Number(ps.rate_per_1000) * job.quantity / 1000;
        await rpc("smg_finish_job", {
          p_job: job.job_id, p_token: job.lease_token, p_outcome: r.outcome, p_provider: ps.provider_id,
          p_provider_order: r.outcome === "submitted" ? r.providerOrder : null, p_error: r.outcome === "submitted" ? null : r.error,
          p_cost: r.outcome === "submitted" ? cost : null, p_cost_currency: r.outcome === "submitted" ? ps.currency : null,
        });
        if (r.outcome === "submitted") out.submitted++; else if (r.outcome === "rejected") out.rejected++; else if (r.outcome === "retry") out.retried++; else out.manual++;
      } catch (e) {
        // unknown failure after claiming: leave the lease to expire; the claim step sends it to manual review, never a blind resend
        out.errors++; console.error("job error:", e instanceof Error ? e.message : "");
      }
    }

    // 2. follow active orders (about once a minute each; completed orders are never polled)
    const since = new Date(Date.now() - 60_000).toISOString();
    const active = await rest("smg_orders?select=id,provider_id,provider_order_id,status&status=eq.processing&provider_order_id=not.is.null&updated_at=lt." + since + "&order=updated_at.asc&limit=20");
    for (const o of active || []) {
      const prov = await providerById(o.provider_id);
      if (!prov) continue;
      const s = await prov.p.status(o.provider_order_id);
      if ("error" in s) { await logTx(o.id, o.provider_id, "status", "error", { error: s.error }); out.errors++; continue; }
      const key = s.status.toLowerCase();
      const next = key === "completed" ? "completed" : key === "partial" ? "partial" : key === "canceled" || key === "cancelled" ? "failed" : null;
      const patch: Record<string, unknown> = { remains: s.remains ?? null, start_count: s.start ?? null };
      if (next) patch.status = next;
      if (next === "failed") patch.status_note = "The provider cancelled this order.";
      if (next === "partial") patch.status_note = "Partially delivered by the provider.";
      await rest("smg_orders?id=eq." + o.id + "&status=eq.processing", { method: "PATCH", body: JSON.stringify(patch), headers: { Prefer: "return=minimal" } });
      if (next) await logTx(o.id, o.provider_id, "status", "ok", { status: s.status, remains: s.remains });
      out.synced++;
    }
  } catch (e) {
    console.error("worker error:", e instanceof Error ? e.message : "");
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
  return new Response(JSON.stringify({ ok: true, ...out }), { headers: { "Content-Type": "application/json" } });
});
