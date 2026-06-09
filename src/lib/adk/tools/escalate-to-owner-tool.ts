import "server-only";
// FunctionTool wrapper for escalate_to_owner.
//
// The Companion calls this when an employee situation exceeds their authority
// or warrants the owner's attention (e.g. an angry customer, an emergency,
// a borderline-policy decision the employee doesn't want to make alone).
//
// Writes an owner_only ChatMessage + sends push to the owner. Mirrors the
// pattern in permission-escalation.ts but is callable from inside the agent
// loop rather than detected externally by regex.

import { FunctionTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";

export interface EscalateToOwnerToolContext {
  businessId: string;
  /** Null when the caller is not bound to a specific employee (e.g. Supervisor → Companion A2A). */
  actorEmployeeId: string | null;
  /** Optional display name for the push body; falls back to "El empleado". */
  actorName: string | null;
}

const ESCALATE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    reason: {
      type: Type.STRING,
      description:
        "Short, concrete reason the owner should be notified. Will be quoted to the owner verbatim. Example: 'cliente reclama producto defectuoso y pide reembolso'.",
    },
    urgency: {
      type: Type.STRING,
      description:
        "How urgent. 'high' = owner should respond now (security, money, angry customer). 'medium' = within the hour. 'low' = whenever they check.",
      enum: ["low", "medium", "high"],
    },
  },
  required: ["reason"],
};

const URGENCY_PREFIX: Record<string, string> = {
  high: "🚨 URGENTE",
  medium: "⚠️ Aviso",
  low: "ℹ️ Para tu info",
};

const ESC_PREFIX = "agent-esc:";

export function createEscalateToOwnerTool(ctx: EscalateToOwnerToolContext) {
  return new FunctionTool({
    name: "escalate_to_owner",
    description:
      "Notify the business owner about a situation that needs their attention. Use sparingly — only when the situation truly exceeds the employee's authority (returns, large discounts, customer disputes, emergencies, safety). Writes an owner_only message + sends a push.",
    parameters: ESCALATE_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as { reason?: string; urgency?: "low" | "medium" | "high" };
      const reason = (input?.reason ?? "").trim().slice(0, 280);
      if (!reason) {
        return { ok: false, error: "missing_reason", answer: "Necesito que me digas para qué querés avisar al dueño." };
      }
      const urgency = input?.urgency ?? "medium";
      const prefix = URGENCY_PREFIX[urgency] ?? URGENCY_PREFIX.medium;
      const actorName = ctx.actorName?.trim() || "El empleado";
      const alertText = `${prefix} · ${actorName}: "${reason}"`;

      const clientMessageId = `${ESC_PREFIX}${ctx.actorEmployeeId ?? "system"}:${Date.now()}`;

      try {
        await prisma.chatMessage.create({
          data: {
            businessId: ctx.businessId,
            clientMessageId,
            kind: "reply",
            source: "manager",
            visibility: "owner_only",
            text: alertText,
          },
        });
      } catch (err) {
        cloudLog({
          severity: "ERROR",
          component: "Companion",
          action: "ESCALATE_TO_OWNER_WRITE_FAILED",
          a2a_transfer: false,
          message: "Failed to write escalate_to_owner notification",
          businessId: ctx.businessId,
          data: { err: err instanceof Error ? err.message : String(err) },
        });
        return { ok: false, error: "write_failed", answer: "No pude avisarle al dueño. Probá de nuevo." };
      }

      void sendPushToOwner(ctx.businessId, {
        title: `Velora · ${prefix}`,
        body: alertText.slice(0, 100),
        url: "/dashboard",
        notificationCategory: "anomaly",
        entityId: ctx.actorEmployeeId ?? ctx.businessId,
      }).catch(() => {});

      cloudLog({
        severity: urgency === "high" ? "WARNING" : "INFO",
        component: "Companion",
        action: "ESCALATE_TO_OWNER",
        a2a_transfer: false,
        message: `Companion escalated to owner (urgency=${urgency})`,
        businessId: ctx.businessId,
        data: { urgency, actorEmployeeId: ctx.actorEmployeeId },
      });

      return {
        ok: true,
        urgency,
        answer: `Le avisé al dueño: "${reason}". Te aviso cuando responda.`,
      };
    },
  });
}
