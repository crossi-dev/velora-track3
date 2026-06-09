// Push fan-out helpers for MP webhook — extracted from webhook/route.ts to
// stay under the 300-line file-size contract.

import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { sendPushToEmployee } from "@/app/api/_lib/employee-push";
import type { PushPayload } from "@/app/api/_lib/web-push";

interface PushOnConfirmArgs {
  businessId: string;
  paymentIntentId: string;
  monto: number;
  createdByEmployeeId: string | null;
  customerName: string | null;
}

// Fire-and-forget push to owner and (if available) to the employee who
// created the cobro. Non-blocking — push outages must not block the 200
// back to MP (which would cause MP to retry an already-confirmed intent).
export function pushOnConfirm({
  businessId,
  paymentIntentId,
  monto,
  createdByEmployeeId,
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

  if (createdByEmployeeId) {
    sendPushToEmployee(businessId, createdByEmployeeId, pushPayload).catch((err) => {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MP_WEBHOOK_PUSH_EMPLOYEE_FAILED",
        a2a_transfer: false,
        message: "Push to employee threw after confirm — non-blocking.",
        businessId,
        data: { paymentIntentId, employeeId: createdByEmployeeId, error: err instanceof Error ? err.message : String(err) },
      });
    });
  }
}
