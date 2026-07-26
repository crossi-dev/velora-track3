// Edge-runtime session checks used by middleware.ts. Split out to keep
// middleware.ts under the size limit. Edge-compatible: imports only the
// Web Crypto -edge auth modules, no Node crypto.

import type { NextRequest } from "next/server";
import { EMPLOYEE_COOKIE_NAME, verifyEmployeeSession, signEmployeeSessionEdge } from "@/lib/employee-auth-edge";
import { OWNER_NATIVE_HEADER, verifyOwnerNativeToken, signOwnerNativeTokenEdge } from "@/lib/owner-native-auth-edge";

export interface EmployeeSessionCheck {
  isEmployee: boolean;
  shouldRefresh: boolean;
  refreshedCookie?: string;
}

export interface OwnerNativeCheck {
  isOwnerNative: boolean;
  shouldRefresh: boolean;
  refreshedToken?: string;
}

// Detects whether the request carries a valid employee session (signed HMAC
// cookie). verifyEmployeeSession rejects the cookie outright if it's been
// idle for 30+ min (EMPLOYEE_IDLE_TIMEOUT_MS), even if the absolute 8h exp
// hasn't been reached yet. Otherwise, refreshes the cookie when either: the
// absolute exp is <30 min away (slides exp forward, existing sliding-expiry
// behavior), or lastActivity is stale (>5 min) and just needs re-stamping to
// keep idle tracking accurate — that refresh must NOT extend exp, or the
// absolute 8h cap would stop being a real ceiling.
export async function checkEmployeeSession(req: NextRequest): Promise<EmployeeSessionCheck> {
  const cookie = req.cookies.get(EMPLOYEE_COOKIE_NAME)?.value ?? null;
  const result = await verifyEmployeeSession(cookie);
  if (!result) return { isEmployee: false, shouldRefresh: false };
  if (!result.shouldRefresh) return { isEmployee: true, shouldRefresh: false };
  try {
    const refreshedCookie = await signEmployeeSessionEdge(result.payload, {
      extendExpiry: result.extendExpiry,
    });
    return { isEmployee: true, shouldRefresh: true, refreshedCookie };
  } catch {
    return { isEmployee: true, shouldRefresh: false };
  }
}

// Checks the owner-native-token header for Capacitor Android native auth.
// If valid and near-expiry, signs a fresh token for the response header.
export async function checkOwnerNativeSession(req: NextRequest): Promise<OwnerNativeCheck> {
  const token = req.headers.get(OWNER_NATIVE_HEADER);
  const result = await verifyOwnerNativeToken(token);
  if (!result) return { isOwnerNative: false, shouldRefresh: false };
  if (!result.shouldRefresh) return { isOwnerNative: true, shouldRefresh: false };
  try {
    const refreshedToken = await signOwnerNativeTokenEdge({
      userId: result.payload.userId,
      email: result.payload.email,
    });
    return { isOwnerNative: true, shouldRefresh: true, refreshedToken };
  } catch {
    return { isOwnerNative: true, shouldRefresh: false };
  }
}
