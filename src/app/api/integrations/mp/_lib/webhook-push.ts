// Push fan-out helpers for MP webhook — extracted from webhook/route.ts to
// stay under the 300-line file-size contract.

import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import type { PushPayload } from "@/app/api/_lib/web-push";

interface PushOnConfirmArgs {
  businessId: string;
  paymentIntentId: string;
  monto: number;
  createdByEmployeeId: string | null;
  customerName: string | null;
}

// Fire-and-forget push to owner. createdByEmployeeId is always null now
// (employee concept removed, 0 rows in production, Stage 1 cleanup) —
// kept in the args shape for caller compatibility, no longer acted on.
export function pushOnConfirm({
  businessId,
  paymentIntentId,
  monto,
  customerName,
}: PushOnConfirmArgs): void {
  const who = customerName ?? "Cliente";
  const pushPayload: PushPayload = {
    title: "Pago recibido 💳",
    body: `${who} pagó $${monto.toLocaleString("es-AR")}`,
    url: "/dashboard",
    notificationCategory: "sale_confirmation",
    entityId: paymentIntentId,
  };

  sendPushToOwner(businessId, pushPayload).catch((err) => {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MP_WEBHOOK_PUSH_FAILED",
      a2a_transfer: false,
      message: "Push to owner threw after confirm — non-blocking.",
      businessId,
      data: { paymentIntentId, error: err instanceof Error ? err.message : String(err) },
    });
  });
}
