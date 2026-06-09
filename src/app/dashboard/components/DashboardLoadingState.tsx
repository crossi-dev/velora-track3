"use client";

import { Card } from "./Card";
import { SkeletonRow } from "./SkeletonRow";
import { Button } from "@/components/ui/button";

interface DashboardLoadingStateProps {
  loadingPage: boolean;
  pageError: string | null;
  onRetry?: () => void;
  t: (en: string, es: string) => string;
}

export function DashboardLoadingState({ loadingPage, pageError, onRetry, t }: DashboardLoadingStateProps) {
  if (loadingPage) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1.5rem 0" }}>
        <SkeletonRow count={1} />
        <SkeletonRow count={4} />
      </div>
    );
  }

  if (pageError) {
    return (
      <Card title={t("Dashboard unavailable", "Panel no disponible")}>
        <p style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", marginBottom: onRetry ? "1rem" : undefined }}>{pageError}</p>
        {onRetry && (
          <Button type="button" onClick={onRetry} size="sm">
            {t("Retry", "Reintentar")}
          </Button>
        )}
      </Card>
    );
  }

  return null;
}
