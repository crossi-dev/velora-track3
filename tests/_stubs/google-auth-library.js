// Stub for google-auth-library in unit tests.
//
// cron-auth.ts instantiates `new OAuth2Client()` at module-load time and calls
// `client.verifyIdToken({ idToken, audience })` per-request. Under ts-node CJS
// the real package is unusable (native addons + JWK network fetch). This stub
// provides the minimal constructor + method surface so cron-auth.ts loads and
// returns the correct shape for OIDC mocking in tests.
//
// Also provides GoogleAuth used by agent-engine-client.ts and embeddings.ts.

class OAuth2Client {
  constructor() {}

  async verifyIdToken({ idToken, audience } = {}) {
    // Default: token is invalid. Tests that need a valid token override
    // Module._cache["google-auth-library"] directly (see cloud-tasks-confirm-payment.test.cjs).
    throw Object.assign(new Error("Token is invalid (test stub default)"), { code: 401 });
  }
}

class GoogleAuth {
  constructor() {}

  async getClient() {
    return {
      async getAccessToken() {
        return { token: "stub-access-token" };
      },
    };
  }
}

module.exports = { OAuth2Client, GoogleAuth };
