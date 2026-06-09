import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { seedProducts, seedCustomers } from "@/app/api/onboarding/_lib/initial-data";
import { normalizeInput } from "@/lib/normalize";
import type { ParsedOnboardingData } from "./orchestrator-parser";

export interface OrchestrationStep {
  label: string;
  status: "done" | "error";
}

export interface OrchestrationResult {
  businessId: string;
  steps: OrchestrationStep[];
}

const MAX_NAME_LENGTH = 200;

export async function executeOnboardingOrchestration(
  userId: string,
  userEmail: string | null | undefined,
  userName: string | null | undefined,
  userImage: string | null | undefined,
  data: ParsedOnboardingData,
): Promise<OrchestrationResult> {
  const steps: OrchestrationStep[] = [];

  const businessId = await prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as Prisma.TransactionClient;
    await tx.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: userEmail ?? null,
        name: userName ?? null,
        image: userImage ?? null,
      },
    });

    const business = await tx.business.create({
      data: {
        name: normalizeInput(data.businessName, MAX_NAME_LENGTH) || data.businessName.slice(0, MAX_NAME_LENGTH),
        type: data.businessType,
        // FIX 2: use currency from chat onboarding; fall back to ARS
        currency: data.currency ?? "ARS",
        taxRate: 0,
        openingTime: data.openingTime,
        closingTime: data.closingTime,
        // FIX 1: persist contact/fiscal/payment fields collected in chat
        cuit: data.cuit ?? null,
        address: data.address ?? null,
        phone: data.phone ?? null,
        alias: data.alias ?? null,
        userId,
      },
    });
    steps.push({ label: `Negocio "${business.name}" creado`, status: "done" });

    const validProducts = data.products
      .filter((p) => p.name.trim().length > 0)
      .map((p) => ({ name: p.name.trim(), price: p.price ?? 0, stock: p.stock ?? 0 }));
    if (validProducts.length > 0) {
      await seedProducts(tx, business.id, validProducts);
      steps.push({ label: `${validProducts.length} producto(s) creado(s)`, status: "done" });
    }

    const validCustomers = data.customers.filter((c) => c.name.trim().length > 0);
    if (validCustomers.length > 0) {
      await seedCustomers(tx, business.id, validCustomers.map((c) => ({ name: c.name, phone: c.phone ?? undefined })));
      steps.push({ label: `${validCustomers.length} cliente(s) creado(s)`, status: "done" });
    }

    return business.id;
  });

  return { businessId, steps };
}
