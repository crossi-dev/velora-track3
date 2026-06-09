import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimitExpensive, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { toPrismaTx } from "@/infrastructure/persistence/tx-client";
import { parseWorkbook } from "./_lib/import-parsing";
import {
  formatRowValidationError,
  validateImportForm,
  MAX_DATA_ROWS,
} from "./_lib/import-validation";
import { importProductRows, type ImportCounters } from "./_lib/import-products";
import { importCustomerRows } from "./_lib/import-customers";
import { importSupplierRows } from "./_lib/import-suppliers";
import { auditImportCompleted } from "./_lib/import-audit";
import {
  buildBulkImportCompletedEvent,
  publishEmployeeEvent,
} from "@/app/api/_lib/agent-events";
import { cloudLog, reportError } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "import.create",
} as const satisfies RouteMutationDeclaration;
const IMPORT_CREATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(req: NextRequest) {
  // Bulk import: up to 500 rows, sha256 hash, DB transaction — expensive limit (5 req/min).
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = ctx;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ code: "INVALID_FORM", message: "The form data is invalid." }, { status: 400 });
  }

  const validated = validateImportForm(formData);
  if (!validated.ok) return validated.response;
  const { file, fileName, type } = validated;

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = await parseWorkbook(buffer, fileName);
  if (!parsed) return NextResponse.json({ code: "EMPTY_FILE", message: "The file is empty." }, { status: 400 });

  const { headers, dataRows } = parsed;
  if (dataRows.length === 0) {
    return NextResponse.json({ code: "EMPTY_FILE", message: "The file has no data rows." }, { status: 400 });
  }

  if (dataRows.length > MAX_DATA_ROWS) {
    return NextResponse.json(
      { code: "FILE_TOO_MANY_ROWS", message: "File exceeds the 500-row limit. Split it into smaller parts and import each separately." },
      { status: 422 }
    );
  }

  const bufferHash = createHash("sha256").update(buffer).digest("hex");
  const idempotency = await prismaIdempotencyAdapter.begin({
    businessId,
    actionType: IMPORT_CREATE_ACTION.actionType,
    idempotencyKey: `${type}:${bufferHash}`,
    requestBody: { type, bufferHash },
  });

  if (idempotency.kind === "replay") return NextResponse.json(idempotency.body, { status: idempotency.status });
  if (idempotency.kind !== "execute") return NextResponse.json({ code: "IDEMPOTENCY_ERROR", message: "Idempotency check failed." }, { status: 422 });

  const idempotencyRecordId = idempotency.recordId;
  let counters: ImportCounters = { imported: 0, skipped: 0 };

  try {
    if (type === "products") {
      const earlyResponse = await prismaTransactionAdapter.run(async (tx) => {
        const result = await importProductRows(toPrismaTx(tx), { businessId, headers, dataRows });
        if (!result.ok) return result.response;
        counters = result.counters;

        await prismaIdempotencyAdapter.complete(tx, idempotencyRecordId, 200, { imported: counters.imported, skipped: counters.skipped });
        return null;
      });
      if (earlyResponse) return earlyResponse;
    } else if (type === "customers") {
      const earlyResponse = await prismaTransactionAdapter.run(async (tx) => {
        const result = await importCustomerRows(toPrismaTx(tx), { businessId, headers, dataRows });
        if (!result.ok) return result.response;
        counters = result.counters;

        await prismaIdempotencyAdapter.complete(tx, idempotencyRecordId, 200, { imported: counters.imported, skipped: counters.skipped });
        return null;
      });
      if (earlyResponse) return earlyResponse;
    } else if (type === "suppliers") {
      const earlyResponse = await prismaTransactionAdapter.run(async (tx) => {
        const result = await importSupplierRows(toPrismaTx(tx), { businessId, headers, dataRows });
        if (!result.ok) return result.response;
        counters = result.counters;

        await prismaIdempotencyAdapter.complete(tx, idempotencyRecordId, 200, { imported: counters.imported, skipped: counters.skipped });
        return null;
      });
      if (earlyResponse) return earlyResponse;
    } else {
      // Exhaustiveness guard — validateImportForm should prevent this, but reject
      // rather than silently returning a false 200 with zero imports.
      await prismaIdempotencyAdapter.release(idempotencyRecordId);
      return NextResponse.json({ code: "UNKNOWN_IMPORT_TYPE", message: "Unknown import type." }, { status: 400 });
    }

    await auditImportCompleted({
      actorUserId,
      businessId,
      action: IMPORT_CREATE_ACTION,
      type,
      bufferHash,
      imported: counters.imported,
      skipped: counters.skipped,
      rowCount: dataRows.length,
    });

    void publishEmployeeEvent(
      buildBulkImportCompletedEvent({
        businessId,
        actorEmployeeId: null,
        resource: type,
        inserted: counters.imported,
        updated: 0,
        skipped: counters.skipped,
        fileName,
      }),
    ).catch((err) => {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "BULK_IMPORT_PUBLISH_FAILED",
        a2a_transfer: false,
        message: `Excel import published to A2A bus but publish failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { resource: type, fileName },
        businessId,
      });
    });

    return NextResponse.json({ imported: counters.imported, skipped: counters.skipped });
  } catch (error) {
    await prismaIdempotencyAdapter.release(idempotencyRecordId);
    const rowError = formatRowValidationError(error);
    if (rowError) return rowError;
    reportError(error, { type, businessId });
    return NextResponse.json({ code: "IMPORT_FAILED", message: "Internal server error during import." }, { status: 500 });
  }
}
