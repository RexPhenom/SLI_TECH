// SLI_TECH · provider adapters. The worker only talks to this interface, so a provider can be swapped.
import { rid } from "./_shared.ts";

export type Submit =
  | { outcome: "submitted"; providerOrder: string }
  | { outcome: "rejected" | "retry" | "ambiguous"; error: string };
export type Status = { status: string; remains?: number; start?: number } | { error: string };
export interface Provider {
  submit(serviceId: string, link: string, qty: number): Promise<Submit>;
  status(orderId: string): Promise<Status>;
  balance(): Promise<{ balance: number; currency: string } | { error: string }>;
}

/** Test provider: nothing real is ever ordered. Special words in the link trigger failure cases. */
export const mockProvider: Provider = {
  async submit(_s, link) {
    if (link.includes("fail-test")) return { outcome: "rejected", error: "Mock: incorrect link" };
    if (link.includes("retry-test")) return { outcome: "retry", error: "Mock: temporary error" };
    if (link.includes("timeout-test")) return { outcome: "ambiguous", error: "Mock: timeout" };
    return { outcome: "submitted", providerOrder: "MOCK-" + rid(10) };
  },
  async status(id) { return id.startsWith("MOCK-") ? { status: "Completed", remains: 0, start: 0 } : { error: "unknown mock order" }; },
  async balance() { return { balance: 100000, currency: "NGN" }; },
};

/** SmmFree adapter, written to https://smmfree.com/api (POST /api/v2, form-encoded, key in the body).
 *  Errors come back as HTTP 200 with an "error" field. Not for production until the account is verified. */
export function smmfree(key: string): Provider {
  const API = "https://smmfree.com/api/v2";
  async function call(params: Record<string, string>) {
    const body = new URLSearchParams({ key, ...params });
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    let j: any = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
    return { httpStatus: r.status, json: j };
  }
  return {
    async submit(serviceId, link, qty) {
      let res;
      try { res = await call({ action: "add", service: serviceId, link, quantity: String(qty) }); }
      catch (_) { return { outcome: "ambiguous", error: "No response from provider (the order may or may not have been placed)." }; }
      const { httpStatus, json } = res;
      if (httpStatus === 429) return { outcome: "retry", error: "Provider rate limit." };
      if (httpStatus >= 500 || httpStatus !== 200 || json === null) return { outcome: "ambiguous", error: "Unclear provider response (HTTP " + httpStatus + ")." };
      if (json.error) {
        const e = String(json.error);
        if (/too many requests/i.test(e)) return { outcome: "retry", error: e };
        if (/incorrect (link|quantity|service)/i.test(e)) return { outcome: "rejected", error: e };
        return { outcome: "retry", error: e };          // invalid key / not enough funds: nothing was ordered, needs attention
      }
      const id = json.order;
      if ((typeof id === "number" || typeof id === "string") && /^\d{1,20}$/.test(String(id))) return { outcome: "submitted", providerOrder: String(id) };
      return { outcome: "ambiguous", error: "Success response without a valid order id." };
    },
    async status(orderId) {
      try {
        const { httpStatus, json } = await call({ action: "status", order: orderId });
        if (httpStatus !== 200 || !json) return { error: "HTTP " + httpStatus };
        if (json.error) return { error: String(json.error) };
        return { status: String(json.status || ""), remains: json.remains != null ? Number(json.remains) : undefined, start: json.start_count != null ? Number(json.start_count) : undefined };
      } catch (_) { return { error: "timeout" }; }
    },
    async balance() {
      try {
        const { json } = await call({ action: "balance" });
        if (!json || json.error) return { error: String((json && json.error) || "no response") };
        return { balance: Number(json.balance), currency: String(json.currency || "") };
      } catch (_) { return { error: "timeout" }; }
    },
  };
}
