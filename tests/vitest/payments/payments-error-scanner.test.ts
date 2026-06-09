// Unit tests for the payments prose error scanner.
//
// The scanner is a LIVE fallback path on the payments agent — it catches
// free-text error narration from Gemini when the structured V-7 dataPart is
// absent. These tests lock in all 7 patterns with representative AR-Spanish
// prose (including accented / voseo forms) and guard against false positives.

import { describe, it, expect } from "vitest";
import { extractPaymentsErrorCode } from "@/app/api/agents/payments/jsonrpc/_lib/payments-error-scanner";

describe("extractPaymentsErrorCode", () => {
  // ── mp_token_expired ────────────────────────────────────────────────────
  describe("mp_token_expired", () => {
    it("matches 'expiró' form", () => {
      expect(extractPaymentsErrorCode("El token de Mercado Pago expiró. Reconectalo en Ajustes.")).toBe("mp_token_expired");
    });
    it("matches 'expirado' past-participle form", () => {
      expect(extractPaymentsErrorCode("Tu token de Mercado Pago está expirado, necesitás reconectarte.")).toBe("mp_token_expired");
    });
    it("matches 'expirada' feminine form", () => {
      expect(extractPaymentsErrorCode("La credencial de Mercado Pago está expirada.")).toBe("mp_token_expired");
    });
    it("matches 'reconectalo en Ajustes' alone", () => {
      expect(extractPaymentsErrorCode("Por favor reconectalo en Ajustes para continuar.")).toBe("mp_token_expired");
    });
    it("matches Mercado Pago + expiró near phrase", () => {
      expect(extractPaymentsErrorCode("Tu conexión con Mercado Pago expiró hace unos días.")).toBe("mp_token_expired");
    });
  });

  // ── mp_not_connected ────────────────────────────────────────────────────
  describe("mp_not_connected", () => {
    it("matches 'Conecta tu Mercado Pago' (neutral imperative)", () => {
      expect(extractPaymentsErrorCode("Conecta tu Mercado Pago desde la sección de configuración.")).toBe("mp_not_connected");
    });
    it("matches 'Conectá tu Mercado Pago' (voseo imperative)", () => {
      expect(extractPaymentsErrorCode("Conectá tu Mercado Pago para poder generar links de pago.")).toBe("mp_not_connected");
    });
    it("matches 'MP no conectado'", () => {
      expect(extractPaymentsErrorCode("MP no conectado — no puedo generar el link.")).toBe("mp_not_connected");
    });
    it("matches 'no conectada ... Mercado Pago'", () => {
      expect(extractPaymentsErrorCode("La cuenta no está conectada con Mercado Pago.")).toBe("mp_not_connected");
    });
  });

  // ── mp_token_decrypt_error ──────────────────────────────────────────────
  describe("mp_token_decrypt_error", () => {
    it("matches 'leer el token de Mercado Pago'", () => {
      expect(extractPaymentsErrorCode("No pude leer el token de Mercado Pago almacenado.")).toBe("mp_token_decrypt_error");
    });
    it("matches 'No se pudo ... token'", () => {
      expect(extractPaymentsErrorCode("No se pudo descifrar el token de acceso.")).toBe("mp_token_decrypt_error");
    });
  });

  // ── missing_origin_postal_code ──────────────────────────────────────────
  describe("missing_origin_postal_code", () => {
    it("matches 'código postal' near 'negocio'", () => {
      expect(extractPaymentsErrorCode("Falta el código postal del negocio para calcular el envío.")).toBe("missing_origin_postal_code");
    });
    it("matches 'código postal' near 'origen'", () => {
      expect(extractPaymentsErrorCode("No tengo el código postal de origen configurado.")).toBe("missing_origin_postal_code");
    });
    it("matches 'cOdigo postal' (case-insensitive)", () => {
      expect(extractPaymentsErrorCode("Necesito el Código Postal del negocio.")).toBe("missing_origin_postal_code");
    });
  });

  // ── missing_destination_postal_code ────────────────────────────────────
  describe("missing_destination_postal_code", () => {
    it("matches 'código postal ... destino'", () => {
      expect(extractPaymentsErrorCode("No tengo el código postal de destino del cliente.")).toBe("missing_destination_postal_code");
    });
    it("matches 'CP del cliente'", () => {
      expect(extractPaymentsErrorCode("Por favor indicame el CP del cliente para cotizar.")).toBe("missing_destination_postal_code");
    });
  });

  // ── shipping_quote_failed ───────────────────────────────────────────────
  describe("shipping_quote_failed", () => {
    it("matches 'Error al cotizar'", () => {
      expect(extractPaymentsErrorCode("Error al cotizar el envío con Andreani.")).toBe("shipping_quote_failed");
    });
    it("matches 'Error cotizando'", () => {
      expect(extractPaymentsErrorCode("Error cotizando el flete — reintentá en unos minutos.")).toBe("shipping_quote_failed");
    });
    it("matches 'no pude cotizar'", () => {
      expect(extractPaymentsErrorCode("Lo siento, no pude cotizar el envío en este momento.")).toBe("shipping_quote_failed");
    });
  });

  // ── payment_links_blocked ───────────────────────────────────────────────
  describe("payment_links_blocked", () => {
    it("matches 'alias ... CBU'", () => {
      expect(extractPaymentsErrorCode("El negocio tiene configurado alias/CBU, no se pueden generar links.")).toBe("payment_links_blocked");
    });
    it("matches 'generar links de pago por alias'", () => {
      expect(extractPaymentsErrorCode("No es posible generar links de pago por alias en este momento.")).toBe("payment_links_blocked");
    });
  });

  // ── null / empty guards ─────────────────────────────────────────────────
  describe("null and empty inputs", () => {
    it("returns null for empty string", () => {
      expect(extractPaymentsErrorCode("")).toBeNull();
    });
    it("returns null for unrelated text", () => {
      expect(extractPaymentsErrorCode("La venta fue registrada con éxito.")).toBeNull();
    });
  });

  // ── false-positive guards ───────────────────────────────────────────────
  describe("false-positive guards", () => {
    it("does not match 'expirado' in unrelated context", () => {
      // 'expirado' without Mercado Pago / token context must not match
      expect(extractPaymentsErrorCode("El cupón está expirado.")).toBeNull();
    });
    it("does not match 'conectada' alone without Mercado Pago near it", () => {
      expect(extractPaymentsErrorCode("La red está conectada correctamente.")).toBeNull();
    });
    it("does not match 'código postal' without negocio/origen/destino", () => {
      expect(extractPaymentsErrorCode("El código postal es requerido.")).toBeNull();
    });
  });
});
