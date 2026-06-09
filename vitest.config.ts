import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/vitest/**/*.test.ts"],
    env: {
      // Prevents validateEnv() in src/lib/env.ts from throwing at import time.
      // Use-case tests mock prisma/demo-quota; these values are never used against a real DB.
      SKIP_ENV_VALIDATION: "1",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      AUTH_SECRET: "vitest-test-secret",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Stub out Next.js server-only marker so vitest can import server modules.
      "server-only": path.resolve(__dirname, "./tests/_stubs/server-only.js"),
      // @velora/core-utils — pure shared utilities package (Phase 2 S1).
      // Sub-path aliases MUST come before the barrel alias so Vite matches the
      // most-specific prefix first (alias resolution is first-match).
      "@velora/core-utils/mp-token-cipher": path.resolve(__dirname, "./src/packages/core-utils/mp-token-cipher.ts"),
      "@velora/core-utils/jsonrpc-types": path.resolve(__dirname, "./src/packages/core-utils/jsonrpc-types.ts"),
      "@velora/core-utils/missing-business-data": path.resolve(__dirname, "./src/packages/core-utils/missing-business-data.ts"),
      "@velora/core-utils": path.resolve(__dirname, "./src/packages/core-utils/index.ts"),
    },
  },
});
