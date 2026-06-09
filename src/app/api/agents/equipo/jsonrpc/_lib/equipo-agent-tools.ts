// equipo-agent-tools.ts — FunctionTool factories for the Equipo ADK agent.
//
// Pattern C: every tool returns a structured intent { intent, data, summary }
// instead of executing a mutation. The handler downstream (owner-handler.ts via
// agent-call-actions.ts) materializes the intents through the existing
// idempotent + audited mutation pipeline. Schemas mirror the shapes
// supervisor-action-mapper.ts expects.

import { z } from "zod/v3";
import { FunctionTool } from "@google/adk";

// ── Factory ──────────────────────────────────────────────────────────────────

interface IntentResult<T = unknown> {
  intent: string;
  data: T;
  summary: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ADK ships a nested zod copy with nominally distinct types; the cast happens at the SDK boundary only.
function buildIntentTool<S extends z.ZodSchema<any>>(opts: {
  name: string;
  description: string;
  schema: S;
  summary: (input: z.infer<S>) => string;
}): FunctionTool {
  return new FunctionTool({
    name: opts.name,
    description: opts.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same SDK-boundary cast as above.
    parameters: opts.schema as any,
    execute: async (input) => {
      const parsed = input as z.infer<S>;
      const result: IntentResult<z.infer<S>> = {
        intent: opts.name,
        data: parsed,
        summary: opts.summary(parsed),
      };
      return result;
    },
  });
}

// ── Schemas (mirror of supervisor intent payloads) ──────────────────────────

const createEmployeeParams = z.object({
  name: z.string().describe(
    "Full name as the owner spoke it. Include name + surname when available. Do NOT include the PIN — the server generates it.",
  ),
});

const resetEmployeePinParams = z.object({
  name: z.string().describe("Existing employee name — must match the catalog"),
});

const getEmployeeCredentialsParams = z.object({
  name: z.string().describe("Existing employee name — must match the catalog"),
});

const broadcastEmployeesParams = z.object({
  message: z.string().describe(
    "Exact text of the immediate (one-time) announcement to all employees. Use this only for urgent puntual messages — recurring instructions on a fixed schedule belong to create_business_rule.",
  ),
});

// ── Tool exports ─────────────────────────────────────────────────────────────

export function buildEquipoTools(): FunctionTool[] {
  return [
    buildIntentTool({
      name: "create_employee",
      description:
        "Creates a new employee. The server generates the PIN — never include it in the call. The employee can register sales and consult stock only; prices and catalog stay owner-only.",
      schema: createEmployeeParams,
      summary: (d) => `Crear empleado: ${d.name}`,
    }),
    buildIntentTool({
      name: "reset_employee_pin",
      description:
        "DESTRUCTIVE. Rotates the employee PIN: generates a new one and invalidates the previous one. Use ONLY when the owner explicitly asks to reset/regenerate/change/new PIN, or confirms a reset after saying the PIN was lost. NEVER use for 'dame el pin' — that is get_employee_credentials.",
      schema: resetEmployeePinParams,
      summary: (d) => `Resetear PIN: ${d.name}`,
    }),
    buildIntentTool({
      name: "get_employee_credentials",
      description:
        "READ-ONLY. Returns the existing PIN/link of an employee without rotating anything. Use when the owner wants to see/recall the link or pin of an already-created employee with NO destructive intent.",
      schema: getEmployeeCredentialsParams,
      summary: (d) => `Ver credenciales: ${d.name}`,
    }),
    buildIntentTool({
      name: "broadcast_employees",
      description:
        "Sends an immediate one-time announcement to all employees. Use for urgent puntual messages ('avisales que cerramos antes hoy'). Recurring instructions on a fixed schedule MUST go through create_business_rule instead.",
      schema: broadcastEmployeesParams,
      summary: (d) => `Aviso: ${d.message.slice(0, 60)}${d.message.length > 60 ? "…" : ""}`,
    }),
  ];
}
