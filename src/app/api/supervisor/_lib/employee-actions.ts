import { prisma } from "@/lib/prisma";
import { hashPin, businessLoginToken, invalidateEmployeeSessions } from "@/lib/employee-auth";
import { cloudLog } from "@/lib/cloud-logger";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  deriveSupervisorIdempotencyKey as deriveIdempotencyKey,
  withSupervisorContractGuards as withContractGuards,
  isDemoLimitReached,
} from "./contract-helpers";
import { invalidateSupervisorContext } from "./load-context";
import type { SupervisorAction } from "./business-rule-actions";

const CREATE_EMPLOYEE_ACTION = getServerActionMeta("employee.create");
const RESET_PIN_ACTION = getServerActionMeta("employee.reset-pin");

const BANNED_PINS = new Set(["1234", "0000", "1111", "4321", "1212", "0101"]);

// Derive the versioned employee login URL.
// Reads Business.loginTokenVersion so the token rotates when revoked.
async function buildLoginUrl(baseUrl: string, businessId: string): Promise<string> {
  const biz = await prisma.business.findUnique({
    where: { id: businessId },
    select: { loginTokenVersion: true },
  });
  const version = biz?.loginTokenVersion ?? 1;
  const token = businessLoginToken(businessId, version);
  return `${baseUrl}/employee-login?b=${businessId}&t=${token}`;
}

function generatePin(): string {
  let pin: string;
  do {
    pin = String(Math.floor(1000 + Math.random() * 9000));
  } while (BANNED_PINS.has(pin));
  return pin;
}

export interface EmployeeActionResult {
  confirmation: string | null;
  error: string | null;
  // pin === null means read-only credential lookup (PIN hash, can't recover).
  employeeLinks: Array<{ name: string; pin: string | null; loginUrl: string }>;
}

export function isEmployeeAction(action: SupervisorAction): boolean {
  return (
    action.intent === "create_employee" ||
    action.intent === "reset_employee_pin" ||
    action.intent === "get_employee_credentials"
  );
}

export async function executeEmployeeAction(
  action: SupervisorAction,
  businessId: string,
  baseUrl: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<EmployeeActionResult> {
  const data = action.data as Record<string, unknown> | null;
  const name = typeof data?.name === "string" ? data.name.trim().slice(0, 60) : "";
  if (!name) {
    return { confirmation: null, error: "Faltó el nombre del empleado.", employeeLinks: [] };
  }

  if (action.intent === "reset_employee_pin") {
    return resetEmployeePin(name, businessId, baseUrl, actorUserId, idempotencySeed, data);
  }

  if (action.intent === "get_employee_credentials") {
    return getEmployeeCredentials(name, businessId, baseUrl);
  }

  const pin = generatePin();
  const idempotencyKey = deriveIdempotencyKey(idempotencySeed, "create_employee", { name });
  try {
    const guarded = await withContractGuards({
      actionType: CREATE_EMPLOYEE_ACTION.actionType,
      routeScope: CREATE_EMPLOYEE_ACTION.routeScope,
      resourceType: CREATE_EMPLOYEE_ACTION.resourceType,
      businessId,
      actorUserId,
      idempotencyKey,
      requestBody: { name },
      summaryFor: (res: { employeeId: string }) => ({
        summary: `Empleado "${name}" creado`,
        resourceId: res.employeeId,
        payload: { name },
      }),
      exec: async () => {
        const created = await prisma.employee.create({
          data: { businessId, name, pinHash: hashPin(pin), role: "employee", active: true },
          select: { id: true },
        });
        invalidateSupervisorContext(businessId);
        return { employeeId: created.id };
      },
    });
    if ("skipped" in guarded) {
      cloudLog({ severity: "INFO", component: "Supervisor", action: "EMPLOYEE_CREATE_SKIPPED", a2a_transfer: false, message: "Employee create skipped (idempotent replay)", businessId, data: { name } });
      return { confirmation: null, error: null, employeeLinks: [] };
    }
    if (isDemoLimitReached(guarded)) {
      return { confirmation: null, error: guarded.message, employeeLinks: [] };
    }
    const loginUrl = await buildLoginUrl(baseUrl, businessId);
    return { confirmation: `Empleado ${name} creado.`, error: null, employeeLinks: [{ name, pin, loginUrl }] };
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "Supervisor", action: "EMPLOYEE_CREATE_FAILED", a2a_transfer: false, message: "Failed to create employee via supervisor action", businessId, data: { name, error: err instanceof Error ? err.message : String(err) } });
    return { confirmation: null, error: `No se pudo crear el empleado ${name}.`, employeeLinks: [] };
  }
}

async function resetEmployeePin(
  name: string,
  businessId: string,
  baseUrl: string,
  actorUserId: string,
  idempotencySeed: string,
  rawData: Record<string, unknown> | null,
): Promise<EmployeeActionResult> {
  const employees = await prisma.employee.findMany({
    where: { businessId, active: true },
    select: { id: true, name: true },
  });
  const match = employees.find((e) =>
    e.name.toLowerCase().includes(name.toLowerCase())
  );
  if (!match) {
    return { confirmation: null, error: `No encontré una empleada/o llamada/o "${name}".`, employeeLinks: [] };
  }
  const idempotencyKey = deriveIdempotencyKey(idempotencySeed, "reset_employee_pin", { ...rawData, employeeId: match.id });
  const guarded = await withContractGuards({
    actionType: RESET_PIN_ACTION.actionType,
    routeScope: RESET_PIN_ACTION.routeScope,
    resourceType: RESET_PIN_ACTION.resourceType,
    businessId,
    actorUserId,
    idempotencyKey,
    requestBody: { employeeId: match.id, name: match.name },
    summaryFor: (res: { pin: string }) => ({
      summary: `Reset PIN del empleado "${match.name}"`,
      resourceId: match.id,
      // PII redaction inside recordCriticalWriteEvent will redact the pin field.
      payload: { employeeId: match.id, name: match.name, pin: res.pin },
    }),
    exec: async () => {
      const pin = generatePin();
      await prisma.employee.update({ where: { id: match.id }, data: { pinHash: hashPin(pin) } });
      // OWASP session regeneration on privilege change — bumps Employee.sessionVersion so
      // any HMAC cookie issued before the reset is rejected by resolve-actor.ts on the next
      // request. Without this, a compromised pre-reset session retains access for up to 8h.
      // https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
      await invalidateEmployeeSessions(match.id);
      invalidateSupervisorContext(businessId);
      return { pin };
    },
  });
  if ("skipped" in guarded) {
    cloudLog({ severity: "INFO", component: "Supervisor", action: "EMPLOYEE_PIN_RESET_SKIPPED", a2a_transfer: false, message: "PIN reset skipped (idempotent replay)", businessId, data: { employeeId: match.id } });
    return { confirmation: null, error: null, employeeLinks: [] };
  }
  if (isDemoLimitReached(guarded)) {
    return { confirmation: null, error: guarded.message, employeeLinks: [] };
  }
  const loginUrl = await buildLoginUrl(baseUrl, businessId);
  return { confirmation: null, error: null, employeeLinks: [{ name: match.name, pin: guarded.value.pin, loginUrl }] };
}

// Read-only lookup: returns the employee login link without rotating the PIN.
// Employee.pinHash is scrypt-hashed → the plaintext PIN cannot be recovered.
// If the owner lost the PIN, they must explicitly request a reset.
async function getEmployeeCredentials(
  name: string,
  businessId: string,
  baseUrl: string,
): Promise<EmployeeActionResult> {
  const employees = await prisma.employee.findMany({
    where: { businessId, active: true },
    select: { id: true, name: true },
  });
  const match = employees.find((e) =>
    e.name.toLowerCase().includes(name.toLowerCase())
  );
  if (!match) {
    return { confirmation: null, error: `No encontré una empleada/o llamada/o "${name}".`, employeeLinks: [] };
  }
  const loginUrl = await buildLoginUrl(baseUrl, businessId);
  return {
    confirmation: null,
    error: null,
    employeeLinks: [{ name: match.name, pin: null, loginUrl }],
  };
}

export async function executeEmployeeActions(
  actions: SupervisorAction[],
  businessId: string,
  baseUrl: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<{ links: Array<{ name: string; pin: string | null; loginUrl: string }>; errors: string[] }> {
  const employeeActions = actions.filter(isEmployeeAction);
  const results = await Promise.all(
    employeeActions.map((a, idx) =>
      executeEmployeeAction(a, businessId, baseUrl, actorUserId, `${idempotencySeed}|${idx}`),
    ),
  );
  return {
    links: results.flatMap((r) => r.employeeLinks),
    errors: results.flatMap((r) => (r.error ? [r.error] : [])),
  };
}
