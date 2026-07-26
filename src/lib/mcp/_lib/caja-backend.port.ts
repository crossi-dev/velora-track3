// src/lib/mcp/_lib/caja-backend.port.ts — Backend-agnostic port for caja ADK tools.
//
// Decouples the three caja tools from Velora's concrete Prisma layer.
// A future adapter (e.g. a cloud-based cash-drawer provider) implements this interface
// and requires ZERO changes to the tool files or the agent factory.
//
// Design mirrors payments-backend.port.ts / catalog-backend.port.ts:
//   port (this file) → adapter (velora-caja.adapter.ts) → factory (caja-backend.factory.ts)
//
// tenantId / businessId: the tools pass a primitive businessId string; the port accepts
// it opaquely under method-specific input types so no Velora vocabulary leaks here.
//
// Input/output types use primitive fields only — no Prisma Decimal, no Prisma enums.
// The adapter maps internally. This is what makes the port vendor-neutral: a Square or
// Fudo Cash-Drawer implementor never sees Prisma types.
//
// HARD CONSTRAINTS (money path — do NOT relax):
//   - idempotency and audit-write logic live INSIDE the tools (beginIdempotentMutation +
//     recordCriticalWriteEvent). The port does NOT model them.
//   - The adapter must scope every query by businessId — tenant isolation requirement.
//   - Methods return plain primitives / Date objects; never Prisma Decimal.

// ── consultar_saldo — read types ─────────────────────────────────────────────

export interface OpenSessionResult {
  id: string;
  openedAt: Date;
  openedCashAmount: number;
}

export interface ClosedSessionResult {
  id: string;
  closedAt: string | null;
  closedCashAmount: number | null;
  variance: number | null;
}

export interface MovementResult {
  /** Pre-signed amount: inflows positive, outflows negative. */
  amount: number;
  // JD integration-map finding (2026-07-26): the OPEN caja-status view only ever
  // showed aggregate Ingresos/Egresos/Movimientos totals — the owner couldn't audit
  // which line was a sale vs. a manual movement without leaving the widget, even
  // though the data was already unified in one CashMovement table. Optional so
  // callers that only need the sum (caja-saldo-tool, caja-ciclo-tool) are unaffected.
  type?: string;
  description?: string | null;
  date?: string;
}

// ── ciclo_caja — open/close types ────────────────────────────────────────────

export interface CreateSessionInput {
  businessId: string;
  openedCashAmount: number;
  openNote: string | null;
  openedByEmployeeId: string | null;
}

export interface CreateSessionResult {
  id: string;
  openedAt: Date;
}

export interface CloseSessionInput {
  sessionId: string;
  businessId: string;
  closedCashAmount: number;
  expectedCashAmount: number;
  variance: number;
  closedAt: Date;
  closeNote: string | null;
  closedByEmployeeId: string | null;
}

export interface CloseSessionResult {
  closedAt: Date | null;
}

// ── registrar_movimiento — write types ───────────────────────────────────────

export interface CreateMovementInput {
  businessId: string;
  /** Domain type string (e.g. "income", "purchase", "withdrawal"). */
  domainType: string;
  description: string;
  /** Caller-supplied positive amount; adapter applies sign convention. */
  amount: number;
  /** Server-derived idempotency key used as CashMovement.clientMessageId. */
  clientMessageId: string;
}

export interface CreateMovementResult {
  id: string;
  /** Signed amount as stored (outflows negative, inflows positive). */
  amount: number;
}

// ── findCashMovementsForSession — shared by saldo + ciclo ────────────────────

export interface FindMovementsInput {
  businessId: string;
  fromDate: Date;
  /** When omitted, no upper bound is applied (used by consultar_saldo). */
  toDate?: Date;
}

// ── Port interface ────────────────────────────────────────────────────────────

/**
 * Backend-agnostic caja port for the three caja ADK tools.
 *
 * Method mapping:
 *   findOpenSession            → ciclo_caja pre-check (duplicate open guard)
 *   findOpenSessionWithAmount  → consultar_saldo + ciclo_caja close path
 *   findLastClosedSession      → consultar_saldo fallback (no open session)
 *   createSession              → ciclo_caja (action=abrir)
 *   closeSession               → ciclo_caja (action=cerrar)
 *   findCashMovementsForSession → consultar_saldo + ciclo_caja (expected calc)
 *   createMovement             → registrar_movimiento
 *
 * Tenant isolation is enforced by each adapter via the businessId field.
 *
 * HARD CONSTRAINTS:
 *   - Do NOT add retry or idempotency at this level (tools own that).
 *   - Methods return plain JS types — no Prisma Decimal, no Prisma enums.
 *   - All writes must be scoped by businessId to preserve multi-tenant safety.
 */
export interface CajaBackend {
  /** Quick existence check — returns only id + openedAt (no amount needed). */
  findOpenSession(businessId: string): Promise<{ id: string; openedAt: Date } | null>;

  /** Full session data needed for balance calculation and close-shift flow. */
  findOpenSessionWithAmount(businessId: string): Promise<OpenSessionResult | null>;

  /** Last closed session — used when no open session exists (consultar_saldo fallback). */
  findLastClosedSession(businessId: string): Promise<ClosedSessionResult | null>;

  /** Create a new open shift. */
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;

  /** Update an open shift to CLOSED state. */
  closeSession(input: CloseSessionInput): Promise<CloseSessionResult>;

  /**
   * Query cash-only movements for a session window.
   * C1 invariant: only "efectivo" or null paymentMethod rows count toward
   * physical cash balance. The adapter enforces this filter internally.
   */
  findCashMovementsForSession(input: FindMovementsInput): Promise<MovementResult[]>;

  /**
   * Persist a new cash movement. The adapter applies the sign convention
   * (outflows stored negative) via the shared cash-mutations utility.
   */
  createMovement(input: CreateMovementInput): Promise<CreateMovementResult>;
}
