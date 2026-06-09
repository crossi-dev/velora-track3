import { NextResponse } from "next/server";
import { buildConfirmationRequest, looksLikeUndoRequest } from "../confirmation";
import { enforcePolicy, policyDeniedResponse } from "@/app/api/_lib/policy-evaluator";
import { prisma } from "@/lib/prisma";
import type { IntentHandler } from "./types";

// Maximum undoCount honored on the LLM path. The deterministic fast-path
// (looksLikeUndoRequest → executeUndo in dispatch.ts) already enforces ≤ 10
// via the text parser; mirroring the same ceiling here keeps both paths in sync.
const MAX_UNDO_COUNT = 10;

export const handleReturnSale: IntentHandler = async ({ safeIntent, businessId, actorRole, actorUserId, actorEmployeeId, text }) => {
  if (safeIntent !== "return_sale") return null;

  // Extract the requested count from the user's text. The LLM companion schema
  // does not carry an undoCount field — the count lives in the raw message.
  // "deshacé las últimas 3 ventas" → undoMatch.count = 3.
  // Fallback to 1 when the text parser cannot determine a count (covers the
  // common "deshacé la última venta" single-undo case).
  const undoMatch = looksLikeUndoRequest(text);
  const undoCount = Math.min(
    Math.max(1, undoMatch?.count ?? 1),
    MAX_UNDO_COUNT,
  );

  // Owners bypass delegation policy (evaluator returns null for owner role).
  // For employees (if return_sale is ever opened to them), enforce maxReturnAmount.
  //
  // We fetch the actual most-recent sale from the DB rather than relying on
  // context.recentSales[0], which is a snapshot captured earlier in the request
  // pipeline and may be stale. Using the snapshot amount could allow a bypass:
  // if recentSales is empty or undefined, the amount would be null, and the
  // policy evaluator treats null amount as "no limit to check" (allowed).
  const undoCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const latestSale = await prisma.sale.findFirst({
    where: { businessId, date: { gte: undoCutoff } },
    orderBy: { date: "desc" },
    select: { totalAmount: true },
  });
  const targetAmount = latestSale ? Number(latestSale.totalAmount) : null;

  const policyDecision = await enforcePolicy({
    businessId,
    actorId: actorEmployeeId ?? actorUserId,
    actorRole,
    action: { type: "return-sale", data: { amount: targetAmount } },
  });
  if (!policyDecision.allowed) return policyDeniedResponse(policyDecision);

  const message = undoCount === 1
    ? "¿Deshacer la última venta? Esto revierte el stock y la caja."
    : `¿Deshacer las últimas ${undoCount} ventas? Esto revierte el stock y la caja.`;
  const answerText = undoCount === 1
    ? "¿Deshacemos la última venta registrada?"
    : `¿Deshacemos las últimas ${undoCount} ventas registradas?`;

  return NextResponse.json({
    answer: answerText,
    confirmationRequest: buildConfirmationRequest({
      severity: "critical",
      title: "Devolver venta",
      message,
      action: { type: "undo", undoTarget: "sale", undoCount },
    }),
  });
};
