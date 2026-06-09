"use client";

import { useT } from "../../lib/DashboardLangContext";
import type { CustomerSelectContext } from "../../lib/types";

interface AssistantCustomerSelectProps {
  customerSelectContext: CustomerSelectContext;
  handleCustomerSelect: (customerName: string) => void;
}

export function AssistantCustomerSelect({
  customerSelectContext,
  handleCustomerSelect,
}: AssistantCustomerSelectProps) {
  const t = useT();
  const heading = t("Select a customer", "Seleccioná un cliente");

  return (
    <div
      className="assistant-panel p-4 md:p-5"
      style={{ backgroundColor: "transparent" }}
    >
      <p
        className="text-caption"
        style={{
          fontFamily: "var(--font-dm-sans)",
          fontWeight: 600,
          color: "var(--tone-muted)",
          marginBottom: "0.5rem",
        }}
      >
        {heading}
      </p>
      {customerSelectContext.clients.length === 0 ? (
        <p
          className="text-caption"
          style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)" }}
        >
          {t("No customers yet", "Todavía no hay clientes cargados")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {customerSelectContext.clients.map((client) => (
            <button
              key={client.id}
              type="button"
              onClick={() => handleCustomerSelect(client.name)}
              className="text-caption inline-flex items-center rounded-full px-3 py-1.5 font-medium transition-colors"
              style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-body)", border: "none", backgroundColor: "var(--surface)", minHeight: "44px", minWidth: "44px" }}
            >
              {client.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
