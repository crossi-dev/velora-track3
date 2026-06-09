"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { FormHero } from "./_lib/fields";
import styles from "./_lib/login.module.css";

export default function EmployeeLoginPage() {
  return (
    <Suspense
      fallback={
        <main className={styles.page}>
          <div
            className={styles.card}
            aria-hidden="true"
            style={{ padding: "2rem", display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            {/* Hero strip skeleton */}
            <div style={{ height: "100px", borderRadius: "var(--radius-lg)", backgroundColor: "var(--surface-subtle)", opacity: 0.6 }} />
            {/* Field skeletons */}
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ height: "44px", borderRadius: "var(--radius-md)", backgroundColor: "var(--surface-subtle)", opacity: 0.4 }} />
            ))}
          </div>
        </main>
      }
    >
      <EmployeeLoginForm />
    </Suspense>
  );
}

function EmployeeLoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlBusinessId = searchParams.get("b") ?? "";
  const hasBusinessPrefilled = urlBusinessId.length > 0;

  const [manualBusinessId, setManualBusinessId] = useState("");
  const businessId = urlBusinessId || manualBusinessId;

  const [businessName, setBusinessName] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!urlBusinessId) return;
    const controller = new AbortController();
    fetch(`/api/business/public?b=${encodeURIComponent(urlBusinessId)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { name?: string } | null) => {
        if (d?.name) setBusinessName(d.name);
      })
      .catch((err: unknown) => {
        // Ignore abort errors — component unmounted or urlBusinessId changed.
        if (err instanceof Error && err.name === "AbortError") return;
      });
    return () => controller.abort();
  }, [urlBusinessId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessId.trim() || !name.trim() || !pin.trim()) {
      setError("Completá todos los campos.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/employees/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId: businessId.trim(),
          name: name.trim(),
          pin: pin.trim(),
        }),
      });
      if (res.ok) {
        try {
          if (typeof window !== "undefined") {
            localStorage.setItem(
              "velora-last-employee-business",
              businessId.trim(),
            );
          }
        } catch {
          /* localStorage lleno o deshabilitado — ignorar silenciosamente */
        }
        router.push("/dashboard");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      if (res.status === 429) {
        if (body.code === "ACCOUNT_LOCKED") {
          setError(
            "Cuenta bloqueada. Pedile a tu jefe que la desbloquee desde la app.",
          );
        } else {
          setError("Demasiados intentos. Esperá un minuto y volvé a intentar.");
        }
        return;
      }
      setError(
        body.code === "INVALID_CREDENTIALS"
          ? "No encontré ese nombre o PIN. Pedile al dueño que te confirme cómo te cargó."
          : (body.message ?? "Credenciales inválidas."),
      );
    } catch {
      setError("Error de red. Probá de nuevo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <FormHero
          businessName={hasBusinessPrefilled ? businessName : null}
          showBusinessCodeHelp={!hasBusinessPrefilled}
        />

        <form onSubmit={handleSubmit} className={styles.formBody} noValidate>
          {!hasBusinessPrefilled && (
            <label className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>Código del negocio</span>
              <input
                type="text"
                value={manualBusinessId}
                onChange={(e) => setManualBusinessId(e.target.value)}
                placeholder="(te lo pasa tu jefe)"
                disabled={loading}
                autoFocus
                className={styles.fieldInput}
              />
            </label>
          )}

          <label className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Tu nombre</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Como te conoce el dueño"
              autoComplete="username"
              disabled={loading}
              autoFocus={hasBusinessPrefilled}
              aria-describedby="name-hint"
              className={styles.fieldInput}
            />
            <span id="name-hint" className={styles.fieldHint}>
              Escribilo igual que te lo dio tu jefe (mayúsculas y tildes incluidas).
            </span>
          </label>

          <label className={styles.fieldGroup}>
            <span className={styles.fieldLabel}>Tu PIN</span>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="· · · ·"
              disabled={loading}
              autoComplete="current-password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={8}
              className={styles.pinInput}
            />
          </label>

          {error && (
            <div className={styles.errorBox} role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className={styles.submitBtn}
          >
            {loading ? "Entrando…" : "Ingresar con PIN"}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className={styles.srOnly}
            >
              {loading ? "Verificando credenciales..." : ""}
            </div>
          </button>
        </form>

        <div className={styles.backLinkWrap}>
          <Link href="/" className={styles.backLink}>
            ¿Sos el dueño?
          </Link>
        </div>
      </div>
    </main>
  );
}
