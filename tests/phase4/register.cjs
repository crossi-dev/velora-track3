process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({
  module: "commonjs",
  moduleResolution: "node",
});

require("ts-node/register/transpile-only");

// Inline tsconfig "@/*" → "src/*" alias resolver. Avoids pulling in
// tsconfig-paths just for tests. Mirrors the paths block in tsconfig.json.
const path = require("path");
const Module = require("module");
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (typeof request === "string") {
    // Next.js `server-only` marker: real package would throw on client import;
    // tests bypass it via a no-op stub.
    if (request === "server-only") {
      return path.join(REPO_ROOT, "tests", "_stubs", "server-only.js");
    }
    // @phosphor-icons/react ships a .cjs.js file in a "type": "module" package
    // which Node refuses to load through the CJS test loader. Tests don't render
    // icons, so we redirect imports to a Proxy stub.
    if (request === "@phosphor-icons/react" || request.startsWith("@phosphor-icons/react/")) {
      return path.join(REPO_ROOT, "tests", "_stubs", "phosphor-icons.js");
    }
    // @/lib/prisma calls validateEnv() at module load (requires AUTH_SECRET +
    // DATABASE_URL). Unit tests don't hit the DB, so redirect to a no-op stub
    // that satisfies the import without crashing on missing env vars.
    // Intercepted at multiple forms:
    //   - "@/lib/prisma" (TypeScript alias form, before ts-node resolves it)
    //   - "./prisma" (relative form emitted by ts-node when resolving from src/lib/)
    //   - absolute path (any resolved form ending in src/lib/prisma.ts)
    if (
      request === "@/lib/prisma" ||
      (request === "./prisma" && parent?.filename && parent.filename.includes(path.join("src", "lib"))) ||
      (typeof request === "string" && request.endsWith(path.join("src", "lib", "prisma.ts")))
    ) {
      return path.join(REPO_ROOT, "tests", "_stubs", "prisma.js");
    }
    // google-auth-library: native + network-dependent (JWK fetch), unusable
    // under ts-node CJS. cron-auth.ts calls `new OAuth2Client()` at module-load
    // time, so any test that transitively requires it needs the stub in place
    // BEFORE that import resolves — a per-test setMockModule() call is too late
    // if cron-auth.ts loads earlier in the same process. Redirect globally here,
    // same pattern as server-only/phosphor-icons/prisma above.
    if (request === "google-auth-library") {
      return path.join(REPO_ROOT, "tests", "_stubs", "google-auth-library.js");
    }
    // @velora/core-utils → src/packages/core-utils (mirrors the tsconfig paths
    // block). Without this, any test importing the A2A jsonrpc-types chain fails
    // to load under the CJS test loader.
    if (request === "@velora/core-utils") {
      return originalResolve.call(this, path.join(REPO_ROOT, "src", "packages", "core-utils", "index.ts"), parent, ...rest);
    }
    if (request.startsWith("@velora/core-utils/")) {
      return originalResolve.call(this, path.join(REPO_ROOT, "src", "packages", "core-utils", request.slice("@velora/core-utils/".length)), parent, ...rest);
    }
    if (request.startsWith("@/")) {
      return originalResolve.call(this, path.join(REPO_ROOT, "src", request.slice(2)), parent, ...rest);
    }
  }
  return originalResolve.call(this, request, parent, ...rest);
};
