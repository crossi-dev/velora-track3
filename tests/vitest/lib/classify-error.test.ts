import { describe, it, expect } from "vitest";
import { classifyError } from "@/app/api/a2a/pubsub-handler/_lib/classify-error";

describe("classifyError — Prisma transient codes", () => {
  for (const code of ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"]) {
    it(`código ${code} → transient`, () => {
      expect(classifyError({ code })).toBe("transient");
    });
  }
});

describe("classifyError — Prisma permanent codes", () => {
  for (const code of ["P2002", "P2003", "P2025"]) {
    it(`código ${code} → permanent`, () => {
      expect(classifyError({ code })).toBe("permanent");
    });
  }
});

describe("classifyError — mensajes de error de red", () => {
  it("ECONNREFUSED → transient", () => {
    expect(classifyError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe("transient");
  });
  it("ETIMEDOUT → transient", () => {
    expect(classifyError(new Error("connect ETIMEDOUT"))).toBe("transient");
  });
  it("network error → transient", () => {
    expect(classifyError(new Error("network connection failed"))).toBe("transient");
  });
  it("mensaje en mayúsculas también detectado (toLowerCase)", () => {
    expect(classifyError(new Error("ECONNREFUSED"))).toBe("transient");
  });
});

describe("classifyError — casos desconocidos → unknown", () => {
  it("error genérico sin code → unknown", () => {
    expect(classifyError(new Error("Something exploded"))).toBe("unknown");
  });
  it("code no Prisma → unknown", () => {
    expect(classifyError({ code: "GRPC_STATUS_14" })).toBe("unknown");
  });
  it("null → unknown", () => {
    expect(classifyError(null)).toBe("unknown");
  });
  it("string → unknown", () => {
    expect(classifyError("error")).toBe("unknown");
  });
  it("undefined → unknown", () => {
    expect(classifyError(undefined)).toBe("unknown");
  });
  it("objeto vacío → unknown", () => {
    expect(classifyError({})).toBe("unknown");
  });
});
