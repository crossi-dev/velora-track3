// employee-handler.stages-qa.ts — Operational Q&A stage (Behaviour 5b).
//
// Intercepts employee how-to / what-to-do questions BEFORE the generic fallback
// (preFilterStage) can dismiss them as small talk or log them as narrative notes.
//
// Runs only when the question did NOT resolve to a deterministic intent upstream.
// Phase: ShapeResponse — registered just BEFORE preFilterStage.

import { bg, type PipelineStage } from "./employee-handler.ctx";
import { isOperationalQuestion } from "./franchise-guards";
import { getActiveBusinessRules } from "./active-rules-selector";
import { findRelevantProcedures, formatProceduresForPrompt } from "./employee-procedures";
import { getGeminiTextModel } from "./gemini-client";
import { saveEmployeeNote } from "./employee-note-handler";
import { cloudLog } from "@/lib/cloud-logger";

export const operationalQuestionStage: PipelineStage = {
  name: "operationalQuestion",
  run: async (ctx) => {
    const { text, businessId, respond, trace, loadedContext } = ctx.params;

    // Already resolved by an upstream stage to a concrete action — skip.
    const hasResolved = ctx.safeIntent && ctx.safeIntent !== "answer";
    if (hasResolved) return null;

    const { isOperationalQuestion: isOpQ, questionType } = isOperationalQuestion(text);
    if (!isOpQ) return null;

    trace.add("operationalQuestion", `type=${questionType ?? "general"}`);

    // Build context for the Q&A prompt:
    //   1. activeRules from loaded context (already fetched, free).
    //   2. Behavior-specific rules from DB only as fallback when context has none.
    //   3. Relevant procedures from local constant (no DB call needed).
    const activeRules = loadedContext.context.activeRules ?? [];

    const rulesCtx =
      activeRules.length > 0
        ? activeRules.map((r) => `- [${r.kind}] ${r.message}`).join("\n")
        : await getActiveBusinessRules(businessId, "behavior-based")
            .then((rows) =>
              rows.length > 0
                ? rows.map((r) => `- ${r.message}`).join("\n")
                : "Sin reglas activas.",
            )
            .catch(() => "Sin reglas activas.");

    const procedures = findRelevantProcedures(text);
    const proceduresText =
      procedures.length > 0
        ? formatProceduresForPrompt(procedures)
        : "Registrar venta, consultar stock, crear cliente, solicitud de compra, reportar evento.";

    const qaPrompt =
      `El empleado tiene una duda operativa: "${text}"\n\n` +
      `Reglas activas del negocio:\n${rulesCtx}\n\n` +
      `Procedimientos de referencia:\n${proceduresText}\n\n` +
      `Respondé en AR voseo cálido y directo (2-3 oraciones máx):\n` +
      `- Si la duda tiene respuesta clara basada en reglas + skills disponibles: ` +
      `respondé con un ejemplo concreto del comando si aplica.\n` +
      `- Si la duda requiere decisión del dueño (compleja, sin precedente): decí exactamente: ` +
      `"Buena pregunta, esa la decide el dueño. ¿Querés que se la pase para que te aclare?"\n` +
      `- Si la duda es ambigua: pedí UNA aclaración corta.\n` +
      `NO uses "buenísimo", "genial", "bárbaro". Confirmá con datos, no con elogios.`;

    try {
      const model = getGeminiTextModel();
      const result = await model.generateContent(qaPrompt);
      const rawAnswer =
        result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";

      // Empty response — fall through to preFilterStage.
      if (!rawAnswer) return null;

      cloudLog({
        severity: "INFO",
        component: "Employee",
        action: "OPERATIONAL_QA_ANSWERED",
        a2a_transfer: false,
        message: `operational question answered (type=${questionType ?? "general"})`,
        businessId,
        actorEmployeeId: ctx.params.actorEmployeeId ?? undefined,
        data: { questionType, textLength: text.length },
      });

      // If the model suggests owner escalation → also save as EmployeeNote.
      const suggestsEscalation =
        /decide el due[ñn]o|le paso al due[ñn]o|quer[eé]s que se la pase/i.test(rawAnswer);
      if (suggestsEscalation && ctx.params.actorEmployeeId) {
        bg(
          saveEmployeeNote({
            businessId,
            employeeId: ctx.params.actorEmployeeId,
            content: `Duda operativa: ${text}`,
          }),
        );
      }

      return respond({ answer: rawAnswer, ...trace.toJSON() });
    } catch {
      // Non-fatal — fall through to preFilterStage.
      return null;
    }
  },
};
