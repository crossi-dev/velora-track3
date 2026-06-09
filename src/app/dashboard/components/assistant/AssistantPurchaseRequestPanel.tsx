"use client";

import { useState } from "react";
import type { PurchaseRequestRecord } from "../../lib/types";
import { Button } from "@/components/ui/button";

interface AssistantPurchaseRequestPanelProps {
  latestPurchaseRequest: PurchaseRequestRecord;
  latestPurchaseRequestPayload: PurchaseRequestRecord["payload"] | undefined;
  downloadingPurchaseRequestId: string | null;
  purchaseActionNotice: string | null;
  downloadPurchaseRequestPdf: (requestId: string, requestNumber: string) => void;
  sendPurchaseRequestToSupplier: () => Promise<string | void>;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
}

export function AssistantPurchaseRequestPanel({
  latestPurchaseRequest,
  latestPurchaseRequestPayload,
  downloadingPurchaseRequestId,
  purchaseActionNotice,
  downloadPurchaseRequestPdf,
  sendPurchaseRequestToSupplier,
  moneyFmt,
  t,
}: AssistantPurchaseRequestPanelProps) {
  const [sendingPurchaseWhatsapp, setSendingPurchaseWhatsapp] = useState(false);

  const handleSendPurchaseRequestToSupplier = async () => {
    setSendingPurchaseWhatsapp(true);
    try {
      await sendPurchaseRequestToSupplier();
    } finally {
      setSendingPurchaseWhatsapp(false);
    }
  };

  return (
    <div className="mb-4" style={{ borderRadius: "var(--radius-xl)", overflow: "hidden" }}>
      <div className="assistant-panel p-5 md:p-6" style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, backgroundColor: "transparent" }}>
        <div className="flex flex-wrap items-start justify-between gap-3 pb-3.5">
          <div>
            <p className="text-caption" style={{ color: "var(--tone-muted)", fontWeight: 700 }}>
              {t("Purchase request", "Solicitud de compra")}
            </p>
            <p className="font-fraunces" style={{ fontSize: "1.2rem", color: "var(--tone-strong)", marginTop: "0.22rem" }}>
              {latestPurchaseRequestPayload?.request?.requestNumber ?? latestPurchaseRequest.requestNumber}
            </p>
          </div>
          <p style={{ fontWeight: 700, color: "var(--tone-strong)" }}>
            {moneyFmt(latestPurchaseRequestPayload?.request?.total, latestPurchaseRequestPayload?.business?.currency ?? latestPurchaseRequest.currency)}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={() => void downloadPurchaseRequestPdf(latestPurchaseRequest.id, latestPurchaseRequest.requestNumber)}
            disabled={downloadingPurchaseRequestId === latestPurchaseRequest.id}
            className="rounded-full"
            style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)" }}
          >
            {downloadingPurchaseRequestId === latestPurchaseRequest.id ? t("Downloading...", "Descargando...") : t("Download purchase request", "Descargar solicitud de compra")}
          </Button>
          {(latestPurchaseRequestPayload?.supplier?.phone ?? "").trim().length > 0 && (
            <Button
              type="button"
              onClick={() => void handleSendPurchaseRequestToSupplier()}
              disabled={sendingPurchaseWhatsapp}
              variant="secondary"
              className="rounded-full"
              style={{ minHeight: "44px", fontFamily: "var(--font-dm-sans)" }}
            >
              {sendingPurchaseWhatsapp ? t("Sending...", "Enviando...") : t("Send to supplier", "Enviar a proveedor")}
            </Button>
          )}
        </div>
        {purchaseActionNotice && <p className="text-caption mt-2" style={{ color: "var(--tone-body)" }}>{purchaseActionNotice}</p>}
      </div>
    </div>
  );
}
