/**
 * client-ip.ts — Shared helper for extracting the real client IP address.
 *
 * TOPOLOGY: Velora runs on Cloud Run behind Google Cloud Load Balancer (GCLB).
 * GCLB APPENDS the real client IP as the LAST entry in X-Forwarded-For.
 * Cloud Run may append its own internal hop before GCLB reaches the app,
 * but GCLB's client IP is always the last entry it adds — still rightmost
 * from the application's perspective.
 *
 * WHY RIGHTMOST (NOT LEFTMOST):
 * The leftmost entry in X-Forwarded-For is supplied by the caller and can be
 * freely spoofed — an attacker can send "X-Forwarded-For: 1.2.3.4" before
 * reaching GCLB and it will be prepended to the chain as the first entry.
 * Trusting [0] (leftmost) means trusting whatever the attacker says their IP is.
 *
 * The LAST entry is appended by GCLB itself, which is a trusted infrastructure
 * component we control. Attackers cannot forge it without bypassing GCLB.
 *
 * FALLBACK CHAIN: X-Forwarded-For (last) → X-Real-IP → "unknown".
 */

type HeadersLike = {
  get(name: string): string | null | undefined;
};

/**
 * Extracts the real client IP from a request's headers.
 *
 * Accepts either a Web API `Headers` object or a plain record
 * (e.g. `{ "x-forwarded-for": "...", "x-real-ip": "..." }`)
 * so it works in both Edge Runtime (middleware) and Node.js route handlers.
 *
 * @param headers - A `Headers`-like object with a `.get()` method.
 * @returns The real client IP string, or "unknown" if no header is present.
 */
export function getClientIp(headers: HeadersLike): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    // GCLB appends the client IP as the last comma-separated entry.
    const last = forwarded.split(",").at(-1)?.trim();
    if (last) return last;
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp;

  return "unknown";
}
