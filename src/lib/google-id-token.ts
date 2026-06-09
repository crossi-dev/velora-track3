import { OAuth2Client } from "google-auth-library";

// Singleton — reuse across requests to benefit from cert caching.
let _client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!_client) {
    _client = new OAuth2Client();
  }
  return _client;
}

export interface GoogleIdTokenPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
  picture: string;
}

/**
 * Verifies a Google ID token issued by native Sign-In (Android/iOS).
 *
 * The token's `aud` claim must match `GOOGLE_WEB_CLIENT_ID` — native Sign-In
 * with `serverClientId` set to the Web client produces tokens with that aud,
 * which is the only audience the server trusts.
 *
 * Throws if the token is invalid, expired, or the audience doesn't match.
 */
export async function verifyGoogleIdToken(
  idToken: string
): Promise<GoogleIdTokenPayload> {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  if (!clientId) {
    throw new Error("[google-id-token] GOOGLE_WEB_CLIENT_ID is not set.");
  }

  const ticket = await getClient().verifyIdToken({
    idToken,
    audience: clientId,
  });

  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error("[google-id-token] Empty payload after verify.");
  }
  if (!payload.email) {
    throw new Error("[google-id-token] ID token has no email claim.");
  }

  return {
    sub: payload.sub,
    email: payload.email,
    // email_verified may be undefined in old tokens; default to false for safety.
    email_verified: payload.email_verified ?? false,
    name: payload.name ?? "",
    picture: payload.picture ?? "",
  };
}
