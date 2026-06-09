import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { checkRateLimitExpensive } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { beginIdempotentMutation, completeIdempotentMutation, releaseIdempotentMutation } from "@/app/api/_lib/idempotency";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { createProductInTransaction } from "@/infrastructure/shared/product-mutations";
import { createCustomerInTransaction } from "@/infrastructure/shared/customer-mutations";
import { initInventory } from "@/infrastructure/shared/product-stock";

export const maxDuration = 30;

const MAX_ROWS = 500;

const MUTATION_ACTIONS = {
  POST: "upload-file-execute.create",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

const importRowSchema = z.object({
  name: z.string().min(1).max(200),
  price: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
  stock: z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
}).strict();

const executeBodySchema = z.object({
  importType: z.enum(["products", "customers"]),
  rows: z.array(importRowSchema).min(1).max(MAX_ROWS),
}).strict();

export async function POST(req: NextRequest) {
  // Bulk DB write: up to 500 rows in individual transactions — expensive limit (5 req/min).
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const { businessId, actorUserId } = ctx;

  const parsed = await parseZodBody(req, executeBodySchema);
  if (!parsed.ok) return parsed.response;
  const { importType, rows } = parsed.data;

  const capped = rows.slice(0, MAX_ROWS);

  // Derived idempotency key: sha256 of importType + rows JSON (submission order).
  // The preview step returns the parsed rows; double-submit of the exact same batch
  // from the same preview session is identified by this content hash.
  const bodyHash = createHash("sha256")
    .update(JSON.stringify({ importType, rows: capped }))
    .digest("hex");

  const idempotencyRecord = await beginIdempotentMutation({
    client: prisma,
    businessId,
    actionType: ACTION_META.actionType,
    idempotencyKey: bodyHash,
    requestBody: { importType, rowCount: capped.length, bodyHash },
    req: { url: req.url },
  });

  if (idempotencyRecord.kind === "replay") return idempotencyRecord.response;
  if (idempotencyRecord.kind !== "execute") {
    return NextResponse.json({ code: "IDEMPOTENCY_ERROR", message: "Idempotency check failed." }, { status: 422 });
  }

  const recordId = idempotencyRecord.recordId;
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    if (importType === "products") {
      for (const row of capped) {
        if (!row.name?.trim()) { skipped++; continue; }
        try {
          await prisma.$transaction(async (tx) => {
            const prismaTx = tx as unknown as Prisma.TransactionClient;
            const product = await createProductInTransaction(prismaTx, {
              businessId,
              name: row.name,
              price: row.price ?? 0,
            });
            if (row.stock != null && row.stock > 0) {
              await initInventory(prismaTx, {
                businessId,
                productId: product.id,
                productName: product.name,
                initialStock: row.stock,
                stockReason: "import_bulk",
                stockReferenceId: null,
              });
            }
          });
          imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "error";
          if (msg.includes("PRODUCT_NAME_TAKEN") || msg.includes("Unique")) {
            skipped++;
          } else {
            errors.push(`${row.name}: ${msg}`);
          }
        }
      }
    } else {
      for (const row of capped) {
        if (!row.name?.trim()) { skipped++; continue; }
        try {
          await prisma.$transaction(async (tx) => {
            await createCustomerInTransaction(tx as unknown as Prisma.TransactionClient, {
              businessId,
              name: row.name,
              phone: row.phone,
              email: row.email,
            });
          });
          imported++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "error";
          if (msg.includes("CUSTOMER_NAME_TAKEN") || msg.includes("Unique")) {
            skipped++;
          } else {
            errors.push(`${row.name}: ${msg}`);
          }
        }
      }
    }

    const responseBody = { imported, skipped, errors: errors.slice(0, 5) };

    await completeIdempotentMutation({ client: prisma, recordId, responseStatus: 200, responseBody });

    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId,
      routeScope: ACTION_META.routeScope,
      actionType: ACTION_META.actionType,
      resourceType: ACTION_META.resourceType,
      resourceId: `${importType}:${bodyHash.slice(0, 16)}`,
      summary: `Bulk Settings import (${importType}) completed`,
      payload: { importType, imported, skipped, rowCount: capped.length },
    });

    return NextResponse.json(responseBody);
  } catch (error) {
    await releaseIdempotentMutation({ client: prisma, recordId });
    return NextResponse.json({ code: "IMPORT_FAILED", message: "Internal server error during import." }, { status: 500 });
  }
}
