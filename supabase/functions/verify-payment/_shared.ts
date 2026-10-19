// SLI_TECH shared helpers. Secrets come from Supabase Edge Function secrets, never from code.
export const URL_ = Deno.env.get("SUPABASE_URL")!;
export const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
export const PSK = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
export const SITE = (Deno.env.get("SITE_URL") || "").replace(/\/?$/, "/");
const SITE_ORIGIN = SITE.length > 1 ? new URL(SITE).origin : "";
const H = { apikey: SRK, Authorization: "Bearer " + SRK, "Content-Type": "application/json" };

export function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const ok = !!o && (o === SITE_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
  return {
    "Access-Control-Allow-Origin": ok ? o : SITE_ORIGIN || "null",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
  };
}
export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

export async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(URL_ + "/rest/v1/" + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(path.split("?")[0] + " " + r.status);
  return t ? JSON.parse(t) : null;
}
/** Calls a database function. Raised errors (e.g. "checkout_disabled") come back as Error.message. */
export async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(URL_ + "/rest/v1/rpc/" + name, { method: "POST", headers: H, body: JSON.stringify(args) });
  const t = await r.text();
  let j: any = null; try { j = t ? JSON.parse(t) : null; } catch (_) { /* not json */ }
  if (!r.ok) throw new Error((j && j.message) || "db_error");
  return j;
}
export async function userFrom(req: Request): Promise<{ id: string; email: string } | null> {
  const a = req.headers.get("authorization") || "";
  if (!/^Bearer\s+[\w.-]+$/.test(a)) return null;
  const r = await fetch(URL_ + "/auth/v1/user", { headers: { apikey: ANON || SRK, Authorization: a } });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? { id: u.id, email: u.email || "" } : null;
}
export async function ps(path: string, init: RequestInit = {}) {
  const r = await fetch("https://api.paystack.co" + path, {
    ...init, headers: { Authorization: "Bearer " + PSK, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && j.status === true, data: j.data, message: j.message as string | undefined };
}
export async function hmac512(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(s)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function safeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export function rid(len: number) {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const b = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(b).map((x) => c[x % c.length]).join("");
}
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REF_RE = /^SLI-[A-Za-z0-9]{10,40}$/;

/** Friendly, safe messages for errors raised by the database functions. */
export const FRIENDLY: Record<string, [number, string]> = {
  maintenance: [503, "SLI_TECH is in maintenance mode. Please try again soon."],
  checkout_disabled: [503, "Checkout is not open yet."],
  invalid_link: [400, "Please enter a valid link starting with http:// or https://."],
  invalid_quantity: [400, "That quantity is outside the allowed range for this service."],
  service_unavailable: [404, "This service is not available right now."],
  too_many_pending: [429, "You have too many unpaid orders. Please pay or wait before ordering again."],
  amount_too_small: [400, "The order total is below the minimum amount."],
  order_not_payable: [409, "This order can no longer be paid."],
  already_paid: [409, "This order is already paid."],
  order_not_found: [404, "Order not found."],
  bad_request: [400, "Invalid request."],
};
export function failure(req: Request, e: unknown) {
  const m = e instanceof Error ? e.message : "";
  const f = FRIENDLY[m];
  if (f) return json(req, { error: f[1], code: m }, f[0]);
  console.error("error:", m);
  return json(req, { error: "Something went wrong. Please try again." }, 500);
}
