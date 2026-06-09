// Acciones server-side para el sub-flow T5b/T5c/T5d del onboarding del owner.
// Separa la creación de producto + seteo de pendingStockProductId de
// business-setup-actions para mantener ese archivo bajo el límite de 300 LOC.
//
// Diseño:
//  - createOnboardingProduct: crea el producto y setea pendingStockProductId.
//  - setOnboardingInitialStock: carga el stock inicial y limpia pendingStockProductId.
//  - clearPendingStockProduct: limpia pendingStockProductId (T5d continue/finish).
//  Todo usa withSupervisorContractGuards para garantizar idempotencia + audit trail.

import { prisma } from "@/lib/prisma";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  deriveSupervisorIdempotencyKey as deriveKey,
  withSupervisorContractGuards as withGuards,
  isDemoLimitReached,
} from "./contract-helpers";
import { invalidateSupervisorContext } from "./load-context";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

const SETUP_ACTION = getServerActionMeta("business-setup.update");
const PRODUCT_CREATE_ACTION = getServerActionMeta("product.create");

export interface OnboardingProductCreatedResult {
  productId: string;
  name: string;
}

/**
 * Crea un producto durante el onboarding (T5b) y persiste su ID en
 * Business.pendingStockProductId para que el siguiente turno (T5c) lo use.
 * Devuelve el ID del producto creado, o null si ya existía (idempotencia).
 */
export async function createOnboardingProduct(args: {
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
  name: string;
  price: number;
}): Promise<OnboardingProductCreatedResult | null> {
  const { businessId, actorUserId, idempotencySeed, name, price } = args;

  const idempKey = deriveKey(idempotencySeed, PRODUCT_CREATE_ACTION.actionType, { name, price });
  const result = await withGuards({
    actionType: PRODUCT_CREATE_ACTION.actionType,
    routeScope: PRODUCT_CREATE_ACTION.routeScope,
    resourceType: PRODUCT_CREATE_ACTION.resourceType,
    businessId,
    actorUserId,
    idempotencyKey: idempKey,
    requestBody: { name, price, stock: 0 },
    summaryFor: (r: OnboardingProductCreatedResult) => ({
      summary: `Onboarding: producto "${r.name}" creado`,
      resourceId: r.productId,
      payload: { name, price },
    }),
    exec: async () => {
      // Derive a simple SKU from name.
      const skuBase = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 20);
      const sku = `${skuBase}-${Date.now().toString(36)}`;
      const product = await prisma.product.create({
        data: {
          businessId,
          name: name.trim(),
          price,
          sku,
          quantity: 0,
        },
        select: { id: true, name: true },
      });
      // Persist the pending product ID so T5c can use it.
      await prisma.business.update({
        where: { id: businessId },
        data: { pendingStockProductId: product.id },
      });
      invalidateSupervisorContext(businessId);
      return { productId: product.id, name: product.name };
    },
  });
  if ("skipped" in result || isDemoLimitReached(result)) {
    // Already created (idempotent replay) or quota blocked — fetch the current pendingStockProductId.
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { pendingStockProductId: true },
    });
    if (!biz?.pendingStockProductId) return null;
    const prod = await prisma.product.findFirst({
      where: { ...buildActiveProductWhere({ businessId }), id: biz.pendingStockProductId },
      select: { id: true, name: true },
    });
    return prod ? { productId: prod.id, name: prod.name } : null;
  }
  return result.value;
}

/**
 * Carga el stock inicial de un producto (T5c) y limpia pendingStockProductId.
 * qty=0 solo limpia el campo, no crea StockMovement.
 */
export async function setOnboardingInitialStock(args: {
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
  productId: string;
  productName: string;
  quantity: number;
}): Promise<void> {
  const { businessId, actorUserId, idempotencySeed, productId, productName, quantity } = args;
  const idempKey = deriveKey(idempotencySeed, "business-setup.update", { field: "initialStock", productId, quantity });
  await withGuards({
    actionType: SETUP_ACTION.actionType,
    routeScope: SETUP_ACTION.routeScope,
    resourceType: SETUP_ACTION.resourceType,
    businessId,
    actorUserId,
    idempotencyKey: idempKey,
    requestBody: { field: "initialStock", productId, quantity },
    summaryFor: () => ({
      summary: `Onboarding: stock inicial de "${productName}" = ${quantity}`,
      resourceId: productId,
      payload: { productId, quantity },
    }),
    exec: async () => {
      if (quantity > 0) {
        await prisma.product.update({
          where: { id: productId },
          data: { quantity },
        });
        await prisma.stockMovement.create({
          data: {
            businessId,
            productId,
            productName,
            quantityBefore: 0,
            quantityAfter: quantity,
            delta: quantity,
            reason: "onboarding-initial",
          },
        });
      }
      await prisma.business.update({
        where: { id: businessId },
        data: { pendingStockProductId: null },
      });
      invalidateSupervisorContext(businessId);
    },
  });
}

/**
 * Limpia pendingStockProductId sin cargar stock (T5d: dueño dice "otro" o
 * "listo" después de T5b). No emite StockMovement.
 *
 * Wrapped in withSupervisorContractGuards so a transient DB failure surfaces
 * as a thrown error to the caller (which falls back to the supervisor LLM
 * instead of silently confirming "listo" while pendingStockProductId stays
 * set — that combination would lock the owner in the stock loop forever).
 */
export async function clearPendingStockProduct(args: {
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
}): Promise<void> {
  const { businessId, actorUserId, idempotencySeed } = args;
  const idempKey = deriveKey(idempotencySeed, SETUP_ACTION.actionType, { field: "clearPendingStockProduct" });
  await withGuards({
    actionType: SETUP_ACTION.actionType,
    routeScope: SETUP_ACTION.routeScope,
    resourceType: SETUP_ACTION.resourceType,
    businessId,
    actorUserId,
    idempotencyKey: idempKey,
    requestBody: { field: "clearPendingStockProduct" },
    summaryFor: () => ({
      summary: "Onboarding: pendingStockProductId limpiado",
      resourceId: null,
      payload: {},
    }),
    exec: async () => {
      await prisma.business.update({
        where: { id: businessId },
        data: { pendingStockProductId: null },
      });
      invalidateSupervisorContext(businessId);
    },
  });
}
