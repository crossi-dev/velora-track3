"use client";

import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  tabName?: string;
  t?: (en: string, es: string) => string;
}

interface State {
  error: Error | null;
}

export class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[TabErrorBoundary]", this.props.tabName ?? "unknown", error);
  }

  handleRetry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      const t = this.props.t ?? ((_en: string, es: string) => es);
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "3rem 1.5rem",
            textAlign: "center",
            fontFamily: "var(--font-dm-sans)",
          }}
        >
          <p
            style={{
              fontSize: "1rem",
              color: "var(--tone-muted)",
              margin: 0,
              maxWidth: "320px",
            }}
          >
            {t(
              "Something went wrong in this section. You can retry or reload the page.",
              "Algo falló en esta sección. Podés reintentar o recargar la página."
            )}
          </p>
          <Button type="button" onClick={this.handleRetry} variant="secondary" size="sm">
            {t("Retry", "Reintentar")}
          </Button>
          <Button
            type="button"
            onClick={() => { if (typeof window !== "undefined") window.location.reload(); }}
            variant="ghost"
            size="sm"
          >
            {t("Reload page", "Recargar página")}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
