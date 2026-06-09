import { normalizeInput, normalizeNullableInput } from "@/lib/normalize";
import type { BusinessRepositoryPort, BusinessForUpdate, BusinessUpdateData } from "@/domain/ports/business.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface UpdateBusinessInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  body: {
    name?: string; type?: string; email?: string | null; cuit?: string | null;
    address?: string | null; phone?: string | null; whatsappPhone?: string | null;
    alias?: string | null;
    openingTime?: string | null; closingTime?: string | null; currency?: string;
    taxRate?: number; ivaCondition?: string | null; puntoVenta?: string | null;
    iibb?: string | null; activityStart?: string | null; allowNegativeStock?: boolean;
    defaultCustomer?: string; allowSaleWithoutCustomer?: boolean;
    openReceiptAfterSale?: boolean; autoCreateProductOnStockLoad?: boolean;
    suggestWhatsappAfterSale?: boolean; lowStockThreshold?: number;
    notifyLowStockWa?: boolean;
    postalCode?: string | null; courierPreference?: string | null;
    /** E.164 WhatsApp Business phone — lightweight pre-Embedded-Signup capture. */
    whatsappBusinessPhoneE164?: string | null;
  };
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type UpdateBusinessResult =
  | { outcome: "updated"; business: BusinessForUpdate }
  | { outcome: "not_found" }
  | { outcome: "missing_name" | "missing_type" | "invalid_tax_rate" | "invalid_cuit" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" | "idempotency_conflict" | "idempotency_in_flight" };

interface Ports {
  business: BusinessRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

const MAX = 500;
function has<T extends object>(obj: T, key: keyof T) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function updateBusinessUseCase(ports: Ports) {
  return {
    async execute(input: UpdateBusinessInput): Promise<UpdateBusinessResult> {
      const { businessId, actorUserId, actorEmployeeId, body, idempotencyKey, requestBody, actionMeta } = input;

      const existing = await ports.business.findForUpdate(businessId);
      if (!existing) return { outcome: "not_found" };

      const nextName = has(body, "name") ? normalizeInput(body.name, MAX) : existing.name;
      if (!nextName) return { outcome: "missing_name" };

      // type is optional on partial profile updates — onboarding/create enforces it.
      // Don't block saving other fields (phone, whatsapp, address) when type is empty,
      // and never clear an already-set type if the form submits a blank value.
      const nextType = has(body, "type") ? (normalizeInput(body.type, MAX) || existing.type) : existing.type;

      const nextCurrency = has(body, "currency")
        ? normalizeInput(body.currency, MAX).toUpperCase().slice(0, 8) || existing.currency
        : existing.currency;

      let nextTaxRate = existing.taxRate;
      if (has(body, "taxRate")) {
        const parsed = Number(body.taxRate);
        if (!Number.isFinite(parsed) || parsed < 0) return { outcome: "invalid_tax_rate" };
        nextTaxRate = parsed;
      }

      // Schema already strips hyphens → expect 11 bare digits here.
      // The legacy hyphenated pattern is kept as a fallback for callers that
      // bypass the Zod schema (direct use-case injection in tests).
      const nextCuit = has(body, "cuit") ? normalizeNullableInput(body.cuit, MAX)?.replace(/-/g, "") ?? null : existing.cuit;
      if (nextCuit !== null && !/^\d{11}$/.test(nextCuit)) return { outcome: "invalid_cuit" };

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const data: BusinessUpdateData = {
          name: nextName, type: nextType, currency: nextCurrency, taxRate: nextTaxRate,
          cuit: nextCuit,
          email: has(body, "email") ? normalizeNullableInput(body.email, MAX) : existing.email,
          address: has(body, "address") ? normalizeNullableInput(body.address, MAX) : existing.address,
          phone: has(body, "phone") ? normalizeNullableInput(body.phone, MAX) : existing.phone,
          whatsappPhone: has(body, "whatsappPhone") ? normalizeNullableInput(body.whatsappPhone, MAX) : existing.whatsappPhone,
          alias: has(body, "alias") ? normalizeNullableInput(body.alias, MAX) : existing.alias,
          openingTime: has(body, "openingTime") ? normalizeNullableInput(body.openingTime, 10) : existing.openingTime,
          closingTime: has(body, "closingTime") ? normalizeNullableInput(body.closingTime, 10) : existing.closingTime,
          ivaCondition: has(body, "ivaCondition") ? normalizeNullableInput(body.ivaCondition, MAX) : existing.ivaCondition,
          puntoVenta: has(body, "puntoVenta") ? normalizeNullableInput(body.puntoVenta, MAX) : existing.puntoVenta,
          iibb: has(body, "iibb") ? normalizeNullableInput(body.iibb, MAX) : existing.iibb,
          activityStart: has(body, "activityStart") ? normalizeNullableInput(body.activityStart, MAX) : existing.activityStart,
          allowNegativeStock: has(body, "allowNegativeStock") ? body.allowNegativeStock === true : existing.allowNegativeStock,
          defaultCustomer: has(body, "defaultCustomer") ? normalizeInput(body.defaultCustomer, MAX) || existing.defaultCustomer : existing.defaultCustomer,
          allowSaleWithoutCustomer: has(body, "allowSaleWithoutCustomer") ? body.allowSaleWithoutCustomer === true : existing.allowSaleWithoutCustomer,
          openReceiptAfterSale: has(body, "openReceiptAfterSale") ? body.openReceiptAfterSale === true : existing.openReceiptAfterSale,
          autoCreateProductOnStockLoad: has(body, "autoCreateProductOnStockLoad") ? body.autoCreateProductOnStockLoad === true : existing.autoCreateProductOnStockLoad,
          suggestWhatsappAfterSale: has(body, "suggestWhatsappAfterSale") ? body.suggestWhatsappAfterSale === true : existing.suggestWhatsappAfterSale,
          lowStockThreshold: has(body, "lowStockThreshold") && Number.isFinite(body.lowStockThreshold) && (body.lowStockThreshold ?? -1) >= 0
            ? (body.lowStockThreshold as number)
            : existing.lowStockThreshold,
          postalCode: has(body, "postalCode") ? normalizeNullableInput(body.postalCode, 10) : existing.postalCode,
          courierPreference: has(body, "courierPreference") ? (body.courierPreference ?? null) : existing.courierPreference,
          notifyLowStockWa: has(body, "notifyLowStockWa") ? body.notifyLowStockWa === true : existing.notifyLowStockWa,
          whatsappBusinessPhoneE164: has(body, "whatsappBusinessPhoneE164")
            ? (normalizeNullableInput(body.whatsappBusinessPhoneE164, 16) ?? null)
            : existing.whatsappBusinessPhoneE164,
        };

        const updated = await ports.transaction.run(async (tx) => {
          const result = await ports.business.updateInTransaction(tx, businessId, data);
          await ports.idempotency.complete(tx, recordId, 200, { ok: true, business: result });
          return result;
        });

        await ports.audit.recordCriticalWrite({
          businessId, actorUserId, actorEmployeeId,
          routeScope: actionMeta.routeScope, actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType, resourceId: updated.id,
          summary: `Configuración del negocio actualizada: ${updated.name}`,
          payload: { before: existing, after: updated },
        });

        return { outcome: "updated", business: updated };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
