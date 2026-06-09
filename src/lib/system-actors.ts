// System actor IDs used as actorUserId for automated/webhook-driven mutations.
//
// These IDs appear in IdempotencyRecord.actorUserId, CriticalWriteEvent audit rows,
// and are checked by WEBHOOK_CANCEL_ACTORS / isWebhookConfirm allow-lists in the
// payment-intent use-case. Centralised here so a rename is a single-file change
// and grep across the codebase always hits this file.

/** MP Checkout Pro / in-store QR webhook-driven confirm or cancel. */
export const SYSTEM_ACTOR_MP_WEBHOOK = "system-mp-webhook";

/** MODO QR webhook-driven confirm or cancel. */
export const SYSTEM_ACTOR_MODO_WEBHOOK = "system-modo-webhook";

/** MP reconcile cron — confirms or cancels stale intents. */
export const SYSTEM_ACTOR_MP_RECONCILE = "system-mp-reconcile";
