"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[GlobalError]", error);
    // Report to server — global-error catches layout-level crashes which are the
    // most severe and most likely to go unnoticed without explicit logging.
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: error.message, digest: error.digest, scope: "error-boundary.global" }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="es-AR">
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <h2 className="text-2xl font-semibold">Tuvimos un problema serio</h2>
          <p className="text-base max-w-sm">
            La app se cruzó. Probá recargar la página.
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-blue-600 px-4 py-2 text-base font-medium text-white hover:bg-blue-700"
          >
            Reintentar
          </button>
        </div>
      </body>
    </html>
  );
}
