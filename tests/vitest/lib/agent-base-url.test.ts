// tests/vitest/lib/agent-base-url.test.ts
//
// Proves the getAgentsBaseUrl() contract:
//   - AGENTS_BASE_URL unset → returns VELORA_APP_URL (current behavior preserved)
//   - AGENTS_BASE_URL set   → returns AGENTS_BASE_URL (new routing seam active)
//   - Trailing slashes are stripped in both cases.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Must import AFTER env is set to avoid module-level capture.
// We re-import the module fresh in each test via dynamic require to get
// a clean process.env read (the helper reads env at call time, not load time).
import { getAgentsBaseUrl } from "@/lib/agent-base-url";

const VELORA = "https://somosvelora.com";
const AGENTS = "https://agents.somosvelora.com";

describe("getAgentsBaseUrl()", () => {
  let savedVelora: string | undefined;
  let savedAgents: string | undefined;

  beforeEach(() => {
    savedVelora = process.env.VELORA_APP_URL;
    savedAgents = process.env.AGENTS_BASE_URL;
  });

  afterEach(() => {
    if (savedVelora === undefined) {
      delete process.env.VELORA_APP_URL;
    } else {
      process.env.VELORA_APP_URL = savedVelora;
    }
    if (savedAgents === undefined) {
      delete process.env.AGENTS_BASE_URL;
    } else {
      process.env.AGENTS_BASE_URL = savedAgents;
    }
  });

  it("returns VELORA_APP_URL when AGENTS_BASE_URL is unset", () => {
    process.env.VELORA_APP_URL = VELORA;
    delete process.env.AGENTS_BASE_URL;
    expect(getAgentsBaseUrl()).toBe(VELORA);
  });

  it("returns AGENTS_BASE_URL when set (Phase A cutover seam)", () => {
    process.env.VELORA_APP_URL = VELORA;
    process.env.AGENTS_BASE_URL = AGENTS;
    expect(getAgentsBaseUrl()).toBe(AGENTS);
  });

  it("strips trailing slash from VELORA_APP_URL", () => {
    process.env.VELORA_APP_URL = `${VELORA}/`;
    delete process.env.AGENTS_BASE_URL;
    expect(getAgentsBaseUrl()).toBe(VELORA);
  });

  it("strips trailing slash from AGENTS_BASE_URL", () => {
    process.env.AGENTS_BASE_URL = `${AGENTS}/`;
    expect(getAgentsBaseUrl()).toBe(AGENTS);
  });

  it("falls back to localhost:3000 when neither var is set", () => {
    delete process.env.VELORA_APP_URL;
    delete process.env.AGENTS_BASE_URL;
    expect(getAgentsBaseUrl()).toBe("http://localhost:3000");
  });
});
