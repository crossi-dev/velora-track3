import { describe, it, expect } from "vitest";
import {
  detectPriceOutlier,
  detectStockShortfall,
  validateSaleTotal,
  validateSaleItems,
  validateSaleItemQuantity,
  DEFAULT_PRICE_OUTLIER_THRESHOLD,
} from "@/domain/rules/sale.rules";

// Helper that mirrors the production guard in sale-inventory.ts
function checkStock(requested: number, available: number, allowNegativeStock: boolean) {
  if (allowNegativeStock) return null;
  return detectStockShortfall(requested, available);
}

// ── detectPriceOutlier ────────────────────────────────────────────────────────

describe("detectPriceOutlier", () => {
  describe("escenario canónico: producto de $1000", () => {
    it("venta a $1 → bloqueada (99% por debajo)", () => {
      const result = detectPriceOutlier(1, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD);
      expect(result).not.toBeNull();
      expect(result?.direction).toBe("below");
      expect(result?.expected).toBe(1000);
    });

    it("venta a $100.000 → bloqueada (9900% por encima)", () => {
      const result = detectPriceOutlier(100_000, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD);
      expect(result).not.toBeNull();
      expect(result?.direction).toBe("above");
      expect(result?.expected).toBe(1000);
    });

    it("venta a $999 → permitida (0.1% de desvío)", () => {
      expect(detectPriceOutlier(999, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD)).toBeNull();
    });

    it("venta a $1500 → en el límite exacto (50%) → permitida", () => {
      expect(detectPriceOutlier(1500, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD)).toBeNull();
    });

    it("venta a $1501 → un peso sobre el límite → bloqueada", () => {
      const result = detectPriceOutlier(1501, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD);
      expect(result).not.toBeNull();
      expect(result?.direction).toBe("above");
    });
  });

  describe("valores extremos y guardas", () => {
    it("precio ingresado = Infinity → null (no finito)", () => {
      expect(detectPriceOutlier(Infinity, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD)).toBeNull();
    });

    it("precio catálogo = Infinity → null (no finito)", () => {
      expect(detectPriceOutlier(1000, Infinity, DEFAULT_PRICE_OUTLIER_THRESHOLD)).toBeNull();
    });

    it("precio decimal: $999.99 sobre catálogo $1000 → permitido", () => {
      expect(detectPriceOutlier(999.99, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD)).toBeNull();
    });

    it("precio decimal: $0.01 sobre catálogo $1000 → bloqueado", () => {
      const result = detectPriceOutlier(0.01, 1000, DEFAULT_PRICE_OUTLIER_THRESHOLD);
      expect(result).not.toBeNull();
      expect(result?.direction).toBe("below");
    });
  });

  describe("threshold = 0 (franquicia sin tolerancia)", () => {
    it("precio exacto → null (0% de desvío cae dentro del threshold 0)", () => {
      expect(detectPriceOutlier(1000, 1000, 0)).toBeNull();
    });
    it("cualquier desvío > 0% → bloqueado", () => {
      expect(detectPriceOutlier(1001, 1000, 0)).not.toBeNull();
      expect(detectPriceOutlier(999, 1000, 0)).not.toBeNull();
    });
  });

  describe("threshold personalizado por franquicia", () => {
    it("franquicia A con threshold 20% bloquea desvío de 25%", () => {
      const result = detectPriceOutlier(1250, 1000, 0.2);
      expect(result).not.toBeNull();
      expect(result?.direction).toBe("above");
    });

    it("franquicia B con threshold 50% permite el mismo desvío de 25%", () => {
      expect(detectPriceOutlier(1250, 1000, 0.5)).toBeNull();
    });

    it("misma venta, distintos thresholds → decisiones independientes (multi-tenant)", () => {
      const ventaPrecio = 1300;
      const catalogo = 1000;
      const resultFranchiseA = detectPriceOutlier(ventaPrecio, catalogo, 0.2); // 30% > 20% → bloqueado
      const resultFranchiseB = detectPriceOutlier(ventaPrecio, catalogo, 0.5); // 30% < 50% → permitido
      expect(resultFranchiseA).not.toBeNull();
      expect(resultFranchiseB).toBeNull();
    });
  });
});

// ── validateSaleTotal ─────────────────────────────────────────────────────────

describe("validateSaleTotal", () => {
  it("total positivo → válido", () => expect(validateSaleTotal(100)).toBeNull());
  it("total = 0 → error", () => expect(validateSaleTotal(0)).not.toBeNull());
  it("total negativo → error", () => expect(validateSaleTotal(-1)).not.toBeNull());
  it("total decimal > 0 → válido", () => expect(validateSaleTotal(0.01)).toBeNull());
});

// ── validateSaleItems ─────────────────────────────────────────────────────────

describe("validateSaleItems", () => {
  it("array con un ítem → válido", () => expect(validateSaleItems([{ quantity: 1 }])).toBeNull());
  it("array vacío → error", () => expect(validateSaleItems([])).not.toBeNull());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  it("null → error", () => expect(validateSaleItems(null as any)).not.toBeNull());
  it("múltiples ítems → válido", () => expect(validateSaleItems([{ quantity: 1 }, { quantity: 2 }])).toBeNull());
});

// ── validateSaleItemQuantity ──────────────────────────────────────────────────

describe("validateSaleItemQuantity", () => {
  it("cantidad = 1 → válida", () => expect(validateSaleItemQuantity(1)).toBeNull());
  it("cantidad = 0 → error", () => expect(validateSaleItemQuantity(0)).not.toBeNull());
  it("cantidad negativa → error", () => expect(validateSaleItemQuantity(-1)).not.toBeNull());
  it("NaN → error", () => expect(validateSaleItemQuantity(NaN)).not.toBeNull());
  it("Infinity → error", () => expect(validateSaleItemQuantity(Infinity)).not.toBeNull());
  it("decimal positivo → inválido (se requiere entero, commit 84f1a57e)", () => expect(validateSaleItemQuantity(0.5)).not.toBeNull());
});

// ── detectStockShortfall ──────────────────────────────────────────────────────

describe("detectStockShortfall", () => {
  describe("cantidades decimales", () => {
    it("2.5 solicitadas con 2.3 disponibles → shortfall", () => {
      const result = detectStockShortfall(2.5, 2.3);
      expect(result).not.toBeNull();
      expect(result?.requested).toBe(2.5);
      expect(result?.available).toBe(2.3);
    });

    it("2.3 solicitadas con 2.5 disponibles → permitido", () => {
      expect(detectStockShortfall(2.3, 2.5)).toBeNull();
    });

    it("0.1 solicitadas con 0.09 disponibles → shortfall", () => {
      expect(detectStockShortfall(0.1, 0.09)).not.toBeNull();
    });
  });

  describe("stock disponible negativo (inventario desincronizado)", () => {
    it("stock disponible = -3, solicitado = 1 → shortfall (1 > -3 es falso... wait)", () => {
      // -3 < 1 → shortfall. El sistema no debe permitir vender con stock negativo.
      const result = detectStockShortfall(1, -3);
      expect(result).not.toBeNull();
      expect(result?.available).toBe(-3);
    });

    it("stock disponible = -3, solicitado = -5 → no shortfall (-5 <= -3)", () => {
      // Caso matemático puro: -5 <= -3 → sin shortfall. Documentamos el comportamiento.
      expect(detectStockShortfall(-5, -3)).toBeNull();
    });
  });

  describe("multi-tenancy: allowNegativeStock por franquicia", () => {
    const PRODUCTO_STOCK = 2;
    const CANTIDAD_SOLICITADA = 5;

    it("franquicia SIN permiso de stock negativo → venta bloqueada", () => {
      const result = checkStock(CANTIDAD_SOLICITADA, PRODUCTO_STOCK, false);
      expect(result).not.toBeNull();
      expect(result?.available).toBe(2);
      expect(result?.requested).toBe(5);
    });

    it("franquicia CON permiso de stock negativo → venta permitida", () => {
      expect(checkStock(CANTIDAD_SOLICITADA, PRODUCTO_STOCK, true)).toBeNull();
    });

    it("la config de una franquicia no afecta a la otra (aislamiento)", () => {
      // Simula dos negocios distintos procesando la misma venta
      const bizA = { allowNegativeStock: true };
      const bizB = { allowNegativeStock: false };

      const resultA = checkStock(CANTIDAD_SOLICITADA, PRODUCTO_STOCK, bizA.allowNegativeStock);
      const resultB = checkStock(CANTIDAD_SOLICITADA, PRODUCTO_STOCK, bizB.allowNegativeStock);

      expect(resultA).toBeNull();       // bizA permite
      expect(resultB).not.toBeNull();   // bizB bloquea
      // La decisión de bizA no contaminó a bizB
    });
  });
});
