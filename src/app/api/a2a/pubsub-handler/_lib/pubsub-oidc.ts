import { OAuth2Client } from "google-auth-library";
import { cloudLog } from "@/lib/cloud-logger";
import type { NextRequest } from "next/server";

export interface PubSubPushBody {
  message?: {
    data?: string; // base64-encoded
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
  };
  subscription?: string;
}

const oauth2Client = new OAuth2Client();

export async function verifyOidc(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const audience = process.env.PUBSUB_PUSH_AUDIENCE;
  if (!audience) {
    cloudLog({ severity: "ERROR", component: "System", action: "PUBSUB_CONFIG_MISSING_AUDIENCE", a2a_transfer: false, message: "PUBSUB_PUSH_AUDIENCE not set — Pub/Sub OIDC auth will always fail; all pushes rejected" });
    return false;
  }
  try {
    const ticket = await oauth2Client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    // Exact issuer match — `includes("google")` would accept google-fake.xyz.
    if (!payload || !payload.iss) return false;
    const validIssuer =
      payload.iss === "https://accounts.google.com" ||
      payload.iss === "accounts.google.com";
    if (!validIssuer) return false;
    const expectedEmail = process.env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
    if (!expectedEmail) {
      if (process.env.NODE_ENV === "production") {
        cloudLog({ severity: "ERROR", component: "System", action: "PUBSUB_CONFIG_MISSING_SA_EMAIL", a2a_transfer: false, message: "PUBSUB_SERVICE_ACCOUNT_EMAIL not set in production — rejecting all Pub/Sub pushes (zero-trust enforcement)" });
        return false;
      }
      cloudLog({ severity: "WARNING", component: "System", action: "PUBSUB_CONFIG_MISSING_SA_EMAIL", a2a_transfer: false, message: "PUBSUB_SERVICE_ACCOUNT_EMAIL not set — service account email is not validated; set it for full OIDC enforcement" });
    } else if (payload.email !== expectedEmail) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
