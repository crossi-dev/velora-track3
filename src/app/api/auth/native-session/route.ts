// POST /api/auth/native-session
//
// Exchange a Google idToken (from Capacitor native Sign-In) for a
// Velora owner native token. Cookie-free: returns the token in the
// JSON body so Capacitor WebView can persist it in localStorage.
//
// Allowlisted in middleware (covered by /api/auth prefix).

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyGoogleIdToken } from "@/lib/google-id-token";
import { signOwnerNativeTokenEdge } from "@/lib/owner-native-auth-edge";
import { cloudLog } from "@/lib/cloud-logger";
import {
  checkRateLimit,
  parseJsonBody,
  jsonError,
  internalError,
} from "@/app/api/_lib/route-helpers";

interface RequestBody {
  idToken: string;
}

export async function POST(req: NextRequest) {
  const rateLimit = checkRateLimit(req, "native-session", 10, 60);
  if (rateLimit) return rateLimit;

  const parsed = await parseJsonBody<RequestBody>(req);
  if (!parsed.ok) return parsed.response;

  const { idToken } = parsed.data;
  if (typeof idToken !== "string" || idToken.length === 0) {
    return jsonError("BAD_REQUEST", "idToken is required.", 400);
  }

  let googlePayload: Awaited<ReturnType<typeof verifyGoogleIdToken>>;
  try {
    googlePayload = await verifyGoogleIdToken(idToken);
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "NATIVE_SESSION_VERIFY_FAILED",
      a2a_transfer: false,
      message: "Google idToken verification failed",
      businessId: "",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return jsonError("UNAUTHORIZED", "Invalid or expired Google ID token.", 401);
  }

  const { sub: googleSub, email, email_verified, name, picture } = googlePayload;

  // Reject unverified Google accounts — the desktop OAuth path relies on
  // Google's gate; the native idToken path needs to assert this explicitly.
  if (!email_verified) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "NATIVE_SESSION_EMAIL_UNVERIFIED",
      a2a_transfer: false,
      message: "Rejected native session: Google email not verified",
      businessId: "",
      data: { email },
    });
    return jsonError("UNAUTHORIZED", "Email not verified.", 401);
  }

  try {
    // Upsert the User row by email — matches auth.ts signIn callback exactly.
    const dbUser = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: name || null,
        image: picture || null,
        emailVerified: new Date(),
      },
      update: {
        name: name || undefined,
        image: picture || undefined,
      },
      select: { id: true },
    });

    // Link or update the Account row (google-native provider).
    await prisma.account.upsert({
      where: {
        provider_providerAccountId: {
          provider: "google-native",
          providerAccountId: googleSub,
        },
      },
      create: {
        userId: dbUser.id,
        type: "credentials",
        provider: "google-native",
        providerAccountId: googleSub,
      },
      update: {},
    });

    // Ensure Business placeholder exists — matches auth.ts ensureBusinessPlaceholder.
    const existingBusiness = await prisma.business.findUnique({
      where: { userId: dbUser.id },
      select: { id: true },
    });
    if (!existingBusiness) {
      await prisma.business.create({
        data: { userId: dbUser.id, name: "", type: "", taxRate: 0 },
        select: { id: true },
      });
    }

    const token = await signOwnerNativeTokenEdge({
      userId: dbUser.id,
      email,
    });

    // m1: audit successful native logins with IP/UA for credential-stuffing detection.
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "NATIVE_SESSION_CREATED",
      a2a_transfer: false,
      message: "Native session issued",
      businessId: "",
      data: {
        email,
        userId: dbUser.id,
        ip: req.headers.get("x-forwarded-for") ?? "unknown",
        ua: req.headers.get("user-agent") ?? "unknown",
      },
    });

    // Return only the token — the client doesn't need userId/email, and
    // leaking the internal DB id is unnecessary information disclosure.
    return Response.json({ token });
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "NATIVE_SESSION_UPSERT_FAILED",
      a2a_transfer: false,
      message: "native-session upsert failed",
      businessId: "",
      data: {
        email,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return internalError("Session creation failed.");
  }
}
