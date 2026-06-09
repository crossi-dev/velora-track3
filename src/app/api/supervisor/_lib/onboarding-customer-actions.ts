// Acciones server-side para el sub-flow T12 del onboarding del owner.
// Separa la creación de clientes del onboarding de business-setup-actions
// para mantener ese archivo bajo el límite de 300 LOC.
//
// Diseño:
//  - createOnboardingCustomer: crea el cliente con nombre + whatsapp opcional.
//  Todo usa withSupervisorContractGuards para garantizar idempotencia + audit trail.

import { prisma } from "@/lib/prisma";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  deriveSupervisorIdempotencyKey as deriveKey,
  withSupervisorContractGuards as withGuards,
  isDemoLimitReached,
} from "./contract-helpers";
import { invalidateSupervisorContext } from "./load-context";

const CUSTOMER_CREATE_ACTION = getServerActionMeta("customer.create");

export interface OnboardingCustomerCreatedResult {
  customerId: string;
  name: string;
}

/**
 * Crea un cliente durante el onboarding (T12 inline) con idempotencia.
 * Devuelve el resultado, o null si la cuota demo lo bloqueó.
 */
export async function createOnboardingCustomer(args: {
  businessId: string;
  actorUserId: string;
  idempotencySeed: string;
  name: string;
  whatsapp: string | null;
}): Promise<OnboardingCustomerCreatedResult | null> {
  const { businessId, actorUserId, idempotencySeed, name, whatsapp } = args;

  const idempKey = deriveKey(idempotencySeed, CUSTOMER_CREATE_ACTION.actionType, { name, whatsapp });
  const result = await withGuards({
    actionType: CUSTOMER_CREATE_ACTION.actionType,
    routeScope: CUSTOMER_CREATE_ACTION.routeScope,
    resourceType: CUSTOMER_CREATE_ACTION.resourceType,
    businessId,
    actorUserId,
    idempotencyKey: idempKey,
    requestBody: { name, phone: whatsapp },
    summaryFor: (r: OnboardingCustomerCreatedResult) => ({
      summary: `Onboarding: cliente "${r.name}" creado`,
      resourceId: r.customerId,
      payload: { name, phone: whatsapp },
    }),
    exec: async () => {
      const customer = await prisma.customer.create({
        data: {
          businessId,
          name: name.trim(),
          ...(whatsapp ? { phone: whatsapp } : {}),
        },
        select: { id: true, name: true },
      });
      invalidateSupervisorContext(businessId);
      return { customerId: customer.id, name: customer.name };
    },
  });

  if ("skipped" in result) {
    // Already created — idempotent replay. Treat as success.
    return { customerId: "idempotent-skip", name };
  }
  if (isDemoLimitReached(result)) return null;
  return result.value;
}
