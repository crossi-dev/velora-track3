export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // ── OpenTelemetry / Cloud Trace wiring ───────────────────────────────────
    // @google/adk 1.1.0 ships maybeSetOtelProviders + getGcpExporters which
    // register a NodeTracerProvider backed by the Cloud Trace OTLP exporter.
    // All OTel transitive deps are already in node_modules (ADK brings them).
    //
    // Gate: OTEL_TRACING_ENABLED=true (default off so local dev stays clean).
    // In prod, set via Cloud Run env vars — no redeploy needed to toggle.
    //
    // The eval-based require pattern mirrors profiler.ts: avoids Turbopack
    // static-trace of the @google/adk package graph at build time.
    if (process.env.OTEL_TRACING_ENABLED === "true") {
      void (async () => {
        try {
          const adk = (await import("@google/adk")) as unknown as {
            getGcpExporters: (cfg: { enableTracing?: boolean; enableMetrics?: boolean }) => Promise<{
              spanProcessors?: unknown[];
              metricReaders?: unknown[];
              logRecordProcessors?: unknown[];
            }>;
            maybeSetOtelProviders: (hooks: unknown[]) => void;
          };
          const exporters = await adk.getGcpExporters({ enableTracing: true });
          adk.maybeSetOtelProviders([exporters]);

          const { cloudLog } = await import("./lib/cloud-logger");
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "OTEL_TRACING_REGISTERED",
            a2a_transfer: false,
            message: "OpenTelemetry Cloud Trace exporter registered via @google/adk",
            data: { spanProcessors: (exporters.spanProcessors ?? []).length },
          });
        } catch (err: unknown) {
          // Non-fatal: OTel failure must never crash the server.
          // getGcpExporters logs its own warning if GCP project ID is absent.
          console.warn("[velora] OTel Cloud Trace init failed:", err instanceof Error ? err.message : String(err));
        }
      })();
    }

    // Emit a structured log when the instance initializes so cold-start latency
    // is visible in Cloud Logging. Compare this timestamp against the first request
    // log to isolate cold-start contribution from request processing time.
    const coldStartAt = Date.now();
    // Deferred import so the log fires after env validation below catches missing vars.
    void (async () => {
      const { cloudLog } = await import("./lib/cloud-logger");
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "INSTANCE_COLD_START",
        a2a_transfer: false,
        message: `Cold start completed in ${Date.now() - coldStartAt}ms`,
        data: { nodeVersion: process.version, env: process.env.NODE_ENV },
      });
    })();

    // Cloud Profiler — must start before other requires so V8 heap hooks attach early.
    // Opt-in via USE_CLOUD_PROFILER=true. Default off so first deploy is safe.
    if (process.env.USE_CLOUD_PROFILER === "true") {
      const { startCloudProfiler } = await import("./instrumentation/profiler");
      // PERF-T3-8: void instead of await — Cloud Profiler attaches V8 heap hooks
      // asynchronously and does not need to complete before the server is ready.
      // Awaiting it added ~200–400 ms to cold start with zero benefit to request
      // handling. Errors are still caught inside startCloudProfiler itself.
      void startCloudProfiler().catch((err: unknown) => {
        // Non-fatal: profiling failure must never crash the server.
        console.warn("[velora] Cloud Profiler failed to start:", err);
      });
    }

    // Fail fast at boot if critical env vars are missing — surfaces all
    // missing vars in one error instead of failing on first request.
    const { validateEnvVars } = await import("./lib/env");
    validateEnvVars();
  }
}
