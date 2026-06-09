"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: error.message, digest: error.digest, scope: "error-boundary.root" }),
    }).catch(() => {});
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-2xl font-semibold">Algo salió mal</h2>
      <p className="text-base text-muted-foreground max-w-sm">
        Ocurrió un error inesperado. Podés reintentar o volver más tarde.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-primary px-4 py-2 text-base font-medium text-primary-foreground hover:bg-primary/90"
      >
        Reintentar
      </button>
    </div>
  );
}
