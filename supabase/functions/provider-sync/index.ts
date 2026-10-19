// SLI_TECH · provider-sync. Admin-only, READ-ONLY toward SmmFree: checks the wallet balance and copies the
// provider's service list into smg_provider_services. It never places an order and never spends money.
// Secret: SMMFREE_API_KEY (Supabase Edge Function secret, never in code or the browser).
import { cors, json, rest, userFrom, URL_, SRK } from "./_shared.ts";

const KEY = Deno.env.get("SMMFREE_API_KEY") || "";
async function smm(params: Record<string, string>) {
  const r = await fetch("https://smmfree.com/api/v2", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: KEY, ...params }), signal: AbortSignal.timeout(25000),
  });
  const t = await r.text(); let j: any = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  return { http: r.status, j };
}
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "Not found" }, 404);
  const user = await userFrom(req);
  if (!user) return json(req, { error: "Please sign in." }, 401);
  const adm = await rest("smg_admin_roles?select=role&user_id=eq." + user.id + "&limit=1");
  if (!adm || !adm.length) return json(req, { error: "Admins only." }, 403);
  if (!KEY) return json(req, { error: "SMMFREE_API_KEY is not set yet. Add it in Supabase → Edge Functions → Secrets." }, 503);
  let b: any; try { b = JSON.parse(await req.text()); } catch (_) { return json(req, { error: "Invalid request." }, 400); }
  try {
    const prov = (await rest("smg_providers?select=id,currency&code=eq.smmfree&limit=1"))[0];
    if (!prov) return json(req, { error: "SmmFree is not registered (run migration 005)." }, 400);

    if (b.action === "balance") {
      const r = await smm({ action: "balance" });
      if (r.http !== 200 || !r.j) return json(req, { error: "SmmFree did not answer properly (HTTP " + r.http + ")." }, 502);
      if (r.j.error) return json(req, { error: "SmmFree says: " + String(r.j.error) }, 400);
      await rest("smg_providers?id=eq." + prov.id, { method: "PATCH", body: JSON.stringify({ last_balance: num(r.j.balance), last_checked_at: new Date().toISOString(), last_error: null }), headers: { Prefer: "return=minimal" } });
      return json(req, { balance: r.j.balance, currency: r.j.currency || null });
    }

    if (b.action === "sync") {
      const started = new Date().toISOString();
      const r = await smm({ action: "services" });
      if (r.http !== 200 || r.j === null) return json(req, { error: "SmmFree did not answer properly (HTTP " + r.http + ")." }, 502);
      if (!Array.isArray(r.j)) return json(req, { error: "SmmFree says: " + String((r.j && r.j.error) || "unexpected reply") }, 400);
      const rows: any[] = []; let skipped = 0;
      for (const s of r.j) {
        const id = String(s.service ?? s.id ?? ""), rate = num(s.rate), mn = Math.trunc(num(s.min)), mx = Math.trunc(num(s.max));
        if (!/^\d{1,12}$/.test(id) || !(rate >= 0) || !(mn > 0) || !(mx >= mn) || typeof s.name !== "string") { skipped++; continue; }
        rows.push({ provider_id: prov.id, provider_service_id: id, name: s.name.slice(0, 200), rate_per_1000: rate, currency: prov.currency, min_qty: mn, max_qty: mx,
          refill: s.refill === true || s.refill === 1 || s.refill === "1" ? true : s.refill == null ? null : false,
          cancel: s.cancel === true || s.cancel === 1 || s.cancel === "1" ? true : s.cancel == null ? null : false, is_available: true, last_synced_at: started });
      }
      if (!rows.length) return json(req, { error: "No usable services in the reply; nothing was changed." }, 502);
      for (let i = 0; i < rows.length; i += 400) {
        await rest("smg_provider_services?on_conflict=provider_id,provider_service_id", { method: "POST", body: JSON.stringify(rows.slice(i, i + 400)), headers: { Prefer: "resolution=merge-duplicates,return=minimal" } });
      }
      // anything the provider no longer lists becomes unavailable (so those services drop out of the shop)
      await rest("smg_provider_services?provider_id=eq." + prov.id + "&last_synced_at=lt." + encodeURIComponent(started), { method: "PATCH", body: JSON.stringify({ is_available: false }), headers: { Prefer: "return=minimal" } });
      return json(req, { synced: rows.length, skipped });
    }
    return json(req, { error: "Unknown action." }, 400);
  } catch (e) {
    console.error("sync error:", e instanceof Error ? e.message : "");
    return json(req, { error: "Something went wrong. Please try again." }, 500);
  }
});
