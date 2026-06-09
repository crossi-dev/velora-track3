import { createHash, randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { checkAiPerMinuteLimit, checkAiRateLimit } from "@/app/api/_lib/ai-rate-limit";
import { extractRules } from "../_lib/extract-rules";
import { parseDocumentPages } from "../_lib/document-parser-pages";
import { chunkPageTexts } from "@/lib/document-chunker";
import { ingestBusinessDocument } from "@/lib/document-recall";
import { executeRuleAction } from "@/app/api/supervisor/_lib/business-rule-actions";
import type { SupervisorAction } from "@/app/api/supervisor/_lib/business-rule-actions";
import type { ExtractedRule } from "../_lib/extract-rules";

// Heavy OCR + rule extraction job (Gemini multimodal — both paths). maxDuration raised to
// allow large PDFs without Cloud Run default 60s timeout killing the request.
export const maxDuration = 600;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;

  // AI quota: import-document calls Gemini Pro — mirror the same guards used
  // in the supervisor POST to prevent bypassing AI minute/daily quotas.
  if (!(await checkAiPerMinuteLimit(ctx.actorUserId))) {
    return NextResponse.json({ code: "RATE_LIMITED", message: "Too many requests. Please wait a moment." }, { status: 429 });
  }
  const aiAllowed = await checkAiRateLimit(ctx.actorUserId);
  if (!aiAllowed) {
    return NextResponse.json({ code: "DAILY_LIMIT_REACHED", message: "Daily request limit reached. Try again tomorrow." }, { status: 429 });
  }

  const formData = await req.formData().catch(() => null);
  const file = formData?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ code: "MISSING_FILE", message: "No file was provided." }, { status: 400 });
  }

  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ code: "FILE_TOO_LARGE", message: "File exceeds the 10 MB limit." }, { status: 413 });
  }

  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!["pdf", "docx"].includes(ext ?? "")) {
    return NextResponse.json({ code: "INVALID_FILE_TYPE", message: "Only PDF or Word (.docx) files are accepted." }, { status: 415 });
  }

  const buffer = await file.arrayBuffer();
  // Hash the bytes up front; each parallel consumer gets its own slice so
  // neither base64 encoding pass can affect the other's view of the buffer.
  const docHash = createHash("sha256").update(new Uint8Array(buffer)).digest("hex");

  // Rule extraction (Gemini 2.5 Pro multimodal) + RAG ingest run in parallel.
  const [extractSettled, ragResult] = await Promise.allSettled([
    extractRules(buffer.slice(0), file.name),
    parseDocumentPages(buffer.slice(0), file.name)
      .then((pages) =>
        ingestBusinessDocument({
          businessId: ctx.businessId,
          sourceFile: file.name,
          chunks: chunkPageTexts(pages),
        })
      )
      .catch(() => ({ stored: 0 })),
  ]);

  if (extractSettled.status === "rejected") {
    logRouteError("/api/business/business-rules/import-document", extractSettled.reason);
    return NextResponse.json(
      { code: "FILE_PARSE_FAILED", message: "Could not read the file." },
      { status: 422 },
    );
  }

  const extractResult = extractSettled.value;
  const chunks =
    ragResult.status === "fulfilled"
      ? (ragResult.value as { stored: number }).stored
      : 0;

  // No rules found — honest empty result, no silent HTTP 200 with 0 count
  if (extractResult.rules.length === 0) {
    return NextResponse.json({
      imported: 0,
      rules: [],
      truncated: false,
      chunks,
      message: "Leímos el documento pero no encontramos reglas operativas.",
    });
  }

  // Stable sort so re-uploading the same file produces the same idempotency
  // seeds regardless of the order Gemini returns rules.
  const sortedRules = [...extractResult.rules].sort((a, b) => {
    const byTrigger = a.trigger.localeCompare(b.trigger);
    return byTrigger !== 0 ? byTrigger : a.message.localeCompare(b.message);
  });

  const actions: SupervisorAction[] = sortedRules.map((rule: ExtractedRule) => ({
    intent: "create_business_rule",
    data: {
      kind: rule.kind,
      // time-based rules use the cron as the trigger (matches business-rule-actions.ts validation)
      trigger: rule.kind === "time-based" && rule.cron ? rule.cron : rule.trigger,
      message: rule.message,
    },
    summary: rule.trigger,
  }));

  const seed = `${ctx.businessId}|import-document|${docHash || randomUUID()}`;

  // Execute sequentially — the trigger upsert inside executeRuleAction is not
  // concurrency-safe (two rules with the same trigger would both insert). The
  // index-based idempotency seed matches the scheme executeRuleActions used
  // internally, so re-uploading the same file still deduplicates correctly.
  const perRuleResults: Awaited<ReturnType<typeof executeRuleAction>>[] = [];
  for (let index = 0; index < actions.length; index++) {
    perRuleResults.push(
      await executeRuleAction(actions[index], ctx.businessId, ctx.actorUserId, `${seed}|${index}`),
    );
  }

  const importedRules: { trigger: string; message: string }[] = [];
  const rejectedRules: { trigger: string; error: string }[] = [];

  for (let i = 0; i < sortedRules.length; i++) {
    const outcome = perRuleResults[i];
    const rule = sortedRules[i];
    if (outcome && outcome.affected === 1) {
      importedRules.push({ trigger: rule.trigger, message: rule.message });
    } else if (outcome && outcome.error) {
      rejectedRules.push({ trigger: rule.trigger, error: outcome.error });
    }
  }

  const imported = importedRules.length;

  if (extractResult.truncated) {
    return NextResponse.json({
      imported,
      rules: importedRules,
      rejected: rejectedRules,
      truncated: true,
      chunks,
      message:
        "El documento tiene demasiadas reglas para procesar de una vez — dividilo en partes.",
    });
  }

  return NextResponse.json({
    imported,
    rules: importedRules,
    rejected: rejectedRules,
    truncated: false,
    chunks,
  });
}
