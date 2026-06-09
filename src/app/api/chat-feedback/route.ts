import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { redactInput } from "@/lib/redact-pii";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { bypassIfTester, checkRateLimit } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { maybeSaveFewShotFromFeedback } from "@/app/api/business-assistant/_lib/few-shot-learner-feedback";
import { maybeRelabelFromNegativeFeedback } from "@/app/api/business-assistant/_lib/few-shot-learner-relabeler";

const chatFeedbackSchema = z.object({
  clientMessageId: z.string().min(1),
  feedback: z.enum(["up", "down"]),
  userInput: z.string().optional(),
  assistantAnswer: z.string().optional(),
}).strict();

export const maxDuration = 10;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await resolveActor(req);
  if (!ctx) return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;

  const parsed = await parseZodBody(req, chatFeedbackSchema);
  if (!parsed.ok) return parsed.response;

  const { clientMessageId, feedback, userInput, assistantAnswer } = parsed.data;

  const cleanId = clientMessageId.replace(/^msg:/, "");

  await prisma.messageFeedback.upsert({
    where: { businessId_clientMessageId: { businessId: ctx.businessId, clientMessageId: cleanId } },
    create: { businessId: ctx.businessId, clientMessageId: cleanId, feedback, userInput, assistantAnswer },
    update: { feedback, userInput, assistantAnswer },
  });

  cloudLog({
    severity: feedback === "down" ? "WARNING" : "INFO",
    component: "Feedback",
    action: feedback === "up" ? "FEEDBACK_POSITIVE" : "FEEDBACK_NEGATIVE",
    a2a_transfer: false,
    message: `user rated response ${feedback}`,
    businessId: ctx.businessId,
    data: {
      clientMessageId: cleanId,
      userInput: userInput != null ? redactInput(userInput, 120) : null,
      assistantAnswer: assistantAnswer != null ? redactInput(assistantAnswer, 120) : null,
    },
  });

  if (feedback === "up" && userInput && assistantAnswer) {
    void maybeSaveFewShotFromFeedback({ businessId: ctx.businessId, userInput, assistantAnswer }).catch(() => { /* best-effort */ });
  }

  if (feedback === "down" && userInput) {
    void maybeRelabelFromNegativeFeedback({ businessId: ctx.businessId, userInput }).catch(() => { /* best-effort */ });
  }

  return NextResponse.json({ ok: true });
}
