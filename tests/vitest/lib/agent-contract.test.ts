import { describe, it, expect } from "vitest";
import { formatEventTextSummary, parseEmployeeEvent } from "@/lib/agent-contract";
import type { EmployeeEvent } from "@/domain/events";

const BASE = {
  protocol: "velora.employee.event" as const,
  protocolVersion: "1.0.0" as const,
  eventId: "evt-001",
  emittedAt: "2024-01-01T00:00:00.000Z",
  businessId: "biz-001",
  actorEmployeeId: "emp-001",
};

// ── formatEventTextSummary ────────────────────────────────────────────────────

describe("formatEventTextSummary — LOW_STOCK", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "LOW_STOCK",
    saleId: "sale-001",
    alerts: [
      { productId: "p1", productName: "Yerba", remainingUnits: 2, reorderThreshold: 5 },
      { productId: "p2", productName: "Mate", remainingUnits: 0, reorderThreshold: 3 },
    ],
  };
  it("incluye saleId", () => expect(formatEventTextSummary(ev)).toContain("saleId=sale-001"));
  it("incluye productName y unidades", () => expect(formatEventTextSummary(ev)).toContain("Yerba (2/5)"));
  it("múltiples alertas separadas por coma", () => expect(formatEventTextSummary(ev)).toContain("Mate (0/3)"));
  it("empieza con LOW_STOCK", () => expect(formatEventTextSummary(ev)).toMatch(/^LOW_STOCK/));
});

describe("formatEventTextSummary — SHIFT_START", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "SHIFT_START",
    actorEmployeeId: "emp-001",
    loginAt: "2024-01-01T08:00:00.000Z",
  };
  it("incluye employeeId y hora de login", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("employeeId=emp-001");
    expect(txt).toContain("at=2024-01-01T08:00:00.000Z");
  });
  it("empieza con SHIFT_START", () => expect(formatEventTextSummary(ev)).toMatch(/^SHIFT_START/));
});

describe("formatEventTextSummary — SHIFT_END", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "SHIFT_END",
    actorEmployeeId: "emp-001",
    logoutAt: "2024-01-01T17:00:00.000Z",
    durationMinutes: 480,
  };
  it("incluye employeeId y duración", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("employeeId=emp-001");
    expect(txt).toContain("duration=480min");
  });
});

describe("formatEventTextSummary — CASH_AT_RISK", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "CASH_AT_RISK",
    actorEmployeeId: "emp-001",
    pattern: "pending_sales_spike",
    count: 5,
    windowMinutes: 60,
    totalAmount: 500,
  };
  it("incluye patrón, count, window y total", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("pattern=pending_sales_spike");
    expect(txt).toContain("count=5");
    expect(txt).toContain("window=60min");
    expect(txt).toContain("total=500");
  });
});

describe("formatEventTextSummary — BULK_IMPORT_COMPLETED", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "BULK_IMPORT_COMPLETED",
    resource: "products",
    inserted: 10,
    updated: 2,
    skipped: 1,
    fileName: "products.xlsx",
  };
  it("incluye resource, counts y filename", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("resource=products");
    expect(txt).toContain("inserted=10");
    expect(txt).toContain("updated=2");
    expect(txt).toContain("skipped=1");
    expect(txt).toContain("file=products.xlsx");
  });
});

describe("formatEventTextSummary — CHAT_MESSAGE", () => {
  it("texto corto → sin truncar", () => {
    const ev: EmployeeEvent = { ...BASE, type: "CHAT_MESSAGE", text: "Hola", locale: null, actorRole: "employee", clientMessageId: null };
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain('actor=employee');
    expect(txt).toContain('"Hola"');
  });
  it("texto largo (>60 chars) → truncado exactamente en 60 + ellipsis", () => {
    const longText = "A".repeat(70);
    const ev: EmployeeEvent = { ...BASE, type: "CHAT_MESSAGE", text: longText, locale: null, actorRole: "owner", clientMessageId: null };
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("…");
    expect(txt).not.toContain(longText);
    // Preview = primeros 60 chars + "…", rodeado de comillas
    expect(txt).toContain(`"${"A".repeat(60)}…"`);
  });
  it("actorRole 'owner' reflejado", () => {
    const ev: EmployeeEvent = { ...BASE, type: "CHAT_MESSAGE", text: "Test", locale: null, actorRole: "owner", clientMessageId: null };
    expect(formatEventTextSummary(ev)).toContain("actor=owner");
  });
});

describe("formatEventTextSummary — COMPANION_RESPONSE", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "COMPANION_RESPONSE",
    inReplyToEventId: "evt-000",
    intent: "answer",
    safeIntent: "business_query",
    answer: "Sí",
    confidence: null,
    requiresClarification: true,
    actionsEmitted: ["adjust_stock", "report_event"],
  };
  it("incluye safeIntent, clarif y actions", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("intent=business_query");
    expect(txt).toContain("clarif=true");
    expect(txt).toContain("adjust_stock");
    expect(txt).toContain("report_event");
  });
});

describe("formatEventTextSummary — SUPERVISOR_QUERY", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "SUPERVISOR_QUERY",
    inReplyToEventId: "evt-000",
    escalationKind: "owner_direct",
    supervisorAnswer: "Entendido.",
  };
  it("incluye escalationKind e inReplyToEventId", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("kind=owner_direct");
    expect(txt).toContain("inReplyTo=evt-000");
  });
});

describe("formatEventTextSummary — STOCK_INGRESS_REQUEST", () => {
  const ev: EmployeeEvent = {
    ...BASE,
    type: "STOCK_INGRESS_REQUEST",
    items: [
      { productName: "Yerba", quantity: 10, unitCostPrice: 100 },
      { productName: "Mate", quantity: 5, unitCostPrice: 50 },
    ],
    supplierName: "Proveedor SA",
    totalEstimatedValue: 1250,
    maxIngressTicket: 500,
  };
  it("incluye items, total, maxTicket y supplier", () => {
    const txt = formatEventTextSummary(ev);
    expect(txt).toContain("Yerba x10");
    expect(txt).toContain("Mate x5");
    expect(txt).toContain("total=1250");
    expect(txt).toContain("maxTicket=500");
    expect(txt).toContain("supplier=Proveedor SA");
  });
  it("supplierName null → 'N/A'", () => {
    const txt = formatEventTextSummary({ ...ev, supplierName: null });
    expect(txt).toContain("supplier=N/A");
  });
});

// ── parseEmployeeEvent ────────────────────────────────────────────────────────

describe("parseEmployeeEvent", () => {
  it("evento LOW_STOCK válido → devuelve el evento", () => {
    const raw = { ...BASE, type: "LOW_STOCK", saleId: "s1", alerts: [] };
    const result = parseEmployeeEvent(raw);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("LOW_STOCK");
  });

  it("evento SHIFT_START válido → devuelve el evento", () => {
    const raw = { ...BASE, type: "SHIFT_START", actorEmployeeId: "emp-001", loginAt: "2024-01-01T08:00:00.000Z" };
    const result = parseEmployeeEvent(raw);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("SHIFT_START");
  });

  it("tipo desconocido → null", () => {
    expect(parseEmployeeEvent({ ...BASE, type: "FAKE_TYPE" })).toBeNull();
  });

  it("sin campo type → null", () => {
    expect(parseEmployeeEvent(BASE)).toBeNull();
  });

  it("null → null", () => {
    expect(parseEmployeeEvent(null)).toBeNull();
  });

  it("string → null", () => {
    expect(parseEmployeeEvent("not an object")).toBeNull();
  });

  it("protocol incorrecto → null", () => {
    expect(parseEmployeeEvent({ ...BASE, protocol: "other", type: "LOW_STOCK", saleId: "s", alerts: [] })).toBeNull();
  });

  it("round-trip: parsea y los datos coinciden", () => {
    const raw = {
      ...BASE,
      type: "BULK_IMPORT_COMPLETED" as const,
      resource: "customers",
      inserted: 50,
      updated: 0,
      skipped: 2,
      fileName: "clientes.xlsx",
    };
    const result = parseEmployeeEvent(raw);
    expect(result?.type).toBe("BULK_IMPORT_COMPLETED");
    if (result?.type === "BULK_IMPORT_COMPLETED") {
      expect(result.inserted).toBe(50);
      expect(result.fileName).toBe("clientes.xlsx");
    }
  });
});
