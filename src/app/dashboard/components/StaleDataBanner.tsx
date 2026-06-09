"use client";

interface StaleDataBannerProps {
  visible: boolean;
  onRetry: () => void;
  t: (en: string, es: string) => string;
}

export function StaleDataBanner({ visible, onRetry, t }: StaleDataBannerProps) {
  if (!visible) return null;

  return (
    <div
      role="status"
      className="text-caption"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "10px 16px",
        backgroundColor: "var(--warning-soft, #fef3c7)",
        borderBottom: "1px solid var(--warning, #f59e0b)",
        fontFamily: "var(--font-dm-sans)",
        color: "var(--tone-strong)",
        flexShrink: 0,
      }}
    >
      <span>
        {t(
          "Data may be out of date.",
          "Los datos pueden estar desactualizados."
        )}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="text-caption"
        style={{
          background: "none",
          border: "1px solid var(--warning, #f59e0b)",
          borderRadius: "var(--radius-md, 8px)",
          padding: "4px 12px",
          fontFamily: "var(--font-dm-sans)",
          fontWeight: 600,
          color: "var(--tone-strong)",
          cursor: "pointer",
          flexShrink: 0,
          minHeight: "44px",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        {t("Retry", "Reintentar")}
      </button>
    </div>
  );
}
