const assert = require("node:assert/strict");
const test = require("node:test");

// Solo testeamos el builder de system prompt — pulls SUPERVISOR_PROMPT
// (constante string) sin levantar la cadena prisma/auth. El builder es
// pura concatenación: prompt base + directiva de idioma según `lang`.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-for-production";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const { buildSupervisorPrompt } = require("../../src/app/api/supervisor/_lib/supervisor-prompt-builder.ts");

test("buildSupervisorPrompt('en') injects RESPONSE LANGUAGE directive in English", () => {
  const prompt = buildSupervisorPrompt("en");
  assert.match(prompt, /RESPONSE LANGUAGE:/);
  assert.match(prompt, /ALWAYS respond in English/);
  // Spanish directive must NOT be present in EN mode.
  assert.doesNotMatch(prompt, /IDIOMA DE RESPUESTA:/);
});

test("buildSupervisorPrompt('es-AR') injects IDIOMA DE RESPUESTA in Spanish", () => {
  const prompt = buildSupervisorPrompt("es-AR");
  assert.match(prompt, /IDIOMA DE RESPUESTA:/);
  assert.match(prompt, /español rioplatense/);
  // English directive must NOT be present in ES mode.
  assert.doesNotMatch(prompt, /RESPONSE LANGUAGE:/);
});

test("buildSupervisorPrompt() defaults to es-AR when lang omitted", () => {
  const prompt = buildSupervisorPrompt();
  assert.match(prompt, /IDIOMA DE RESPUESTA:/);
  assert.doesNotMatch(prompt, /RESPONSE LANGUAGE:/);
});

test("buildSupervisorPrompt preserves the base SUPERVISOR_PROMPT body", () => {
  // Sanity check: regardless of lang, the core role definition stays.
  const en = buildSupervisorPrompt("en");
  const es = buildSupervisorPrompt("es-AR");
  for (const p of [en, es]) {
    assert.match(p, /Sos el SUPERVISOR de Velora/);
    assert.match(p, /ASK, NEVER ASSUME/);
    // 2026-05-24: T1-T14 onboarding block migrated to the OnboardingAgent.
    // The supervisor now carries an awareness reference, not the executable
    // turn machine. Asserts the new awareness section is present.
    assert.match(p, /ONBOARDING \(sub-agente dedicado\)/);
    // Belt-and-suspenders: the old T1-T14 body must NOT be in the prompt anymore.
    assert.doesNotMatch(p, /PROGRESSIVE ONBOARDING/);
  }
});

// ── USE_OWNER_ASSISTANT prompt-tool consistency tests ────────────────────────
// Principle: only declare tools you provide.
// Ref: https://ai.google.dev/gemini-api/docs/function-calling

test("call_ventas_agent IS declared in TOOLS_ACTIVE_BLOCK when USE_OWNER_ASSISTANT is off", () => {
  delete process.env.USE_OWNER_ASSISTANT;
  const prompt = buildSupervisorPrompt("es-AR", /* adkEnabled */ true);
  assert.match(prompt, /call_ventas_agent/);
  assert.match(prompt, /cuatro agentes/);
});

test("call_ventas_agent is NOT declared in TOOLS_ACTIVE_BLOCK when USE_OWNER_ASSISTANT=true", () => {
  process.env.USE_OWNER_ASSISTANT = "true";
  try {
    const prompt = buildSupervisorPrompt("es-AR", /* adkEnabled */ true);
    assert.doesNotMatch(prompt, /call_ventas_agent.*Agente de Ventas/s);
    assert.match(prompt, /tres agentes/);
  } finally {
    delete process.env.USE_OWNER_ASSISTANT;
  }
});

test("TOOLS_ACTIVE_BLOCK is omitted entirely when adkEnabled=false regardless of USE_OWNER_ASSISTANT", () => {
  process.env.USE_OWNER_ASSISTANT = "true";
  try {
    const prompt = buildSupervisorPrompt("es-AR", /* adkEnabled */ false);
    assert.doesNotMatch(prompt, /HERRAMIENTAS DE DELEGACIÓN ACTIVAS/);
  } finally {
    delete process.env.USE_OWNER_ASSISTANT;
  }
});
