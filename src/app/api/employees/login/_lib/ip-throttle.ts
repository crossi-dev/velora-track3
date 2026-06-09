// ip-throttle.ts — per-IP+employee in-memory login throttle.
// Extracted from employees/login/route.ts to keep that file under the 300-line server limit.
//
// Module-scoped map. Resets on Cloud Run instance restart — acceptable because
// the durable per-employee DB counter is the real safety net.

import { NextRequest } from "next/server";
import { getClientIp } from "@/lib/client-ip";

interface IpThrottleEntry {
  count: number;
  resetAt: number;
}

export const IP_THROTTLE_WINDOW_MS = 60_000; // 1 minute
export const IP_THROTTLE_MAX_FAILURES = 5;

const ipEmployeeThrottle = new Map<string, IpThrottleEntry>();

/**
 * Returns the real client IP from a Next.js request.
 * Delegates to the shared getClientIp helper (rightmost-trust / GCLB topology).
 */
export function getRequestIp(req: NextRequest): string {
  return getClientIp(req.headers);
}

/** Returns true when this ip:employeeId pair has exceeded the failure threshold. */
export function checkIpThrottle(ip: string, employeeId: string): boolean {
  const key = `${ip}:${employeeId}`;
  const now = Date.now();
  const entry = ipEmployeeThrottle.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= IP_THROTTLE_MAX_FAILURES;
}

/** Increments the failure counter for this ip:employeeId pair. */
export function incrementIpThrottle(ip: string, employeeId: string): void {
  const key = `${ip}:${employeeId}`;
  const now = Date.now();
  const entry = ipEmployeeThrottle.get(key);
  if (!entry || now > entry.resetAt) {
    ipEmployeeThrottle.set(key, { count: 1, resetAt: now + IP_THROTTLE_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

/** Clears the throttle entry on successful login. */
export function clearIpThrottle(ip: string, employeeId: string): void {
  ipEmployeeThrottle.delete(`${ip}:${employeeId}`);
}
