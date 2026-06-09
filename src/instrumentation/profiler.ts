/**
 * Google Cloud Profiler bootstrap for Velora.
 *
 * Enables continuous CPU (wall-clock) + heap profiling via the
 * @google-cloud/profiler SDK. Profiles are collected automatically
 * (~10 s per minute per replica) and sent to the Cloud Profiler service.
 * No manual span.start/end calls — the SDK instruments the V8 runtime.
 *
 * PREREQUISITES:
 *   1. Cloud Run SA needs: roles/cloudprofiler.agent
 *      gcloud projects add-iam-policy-binding my-gcp-project \
 *        --member="serviceAccount:<SA_EMAIL>" \
 *        --role="roles/cloudprofiler.agent"
 *   2. Dockerfile builder stage needs python3 + make + g++ for native pprof:
 *      (see Dockerfile — the deps stage must NOT use --ignore-scripts)
 *   3. Set USE_CLOUD_PROFILER=true in Cloud Run env vars to activate.
 *
 * OVERHEAD: <5% CPU during 10-s collection window; amortised across replicas
 * ~0.5% in practice. Official Google Cloud docs figure. Sampled, not tracing.
 *
 * DEPRECATION NOTE: cloud-profiler-nodejs repo was archived 2026-02-20 and
 * content moved to googleapis/google-cloud-node. The npm package @google-cloud/profiler
 * v6.0.4 continues to ship from that monorepo and remains the canonical package
 * per Cloud Profiler Node.js docs (cloud.google.com/profiler/docs/profiling-nodejs).
 */

/**
 * Start the Cloud Profiler agent.
 * Must be called as early as possible (before any other requires) because the
 * heap profiler patches V8's allocation hooks at attach time.
 * logLevel: 0 silences all SDK INFO logs that would otherwise pollute Cloud Logging.
 *
 * IMPORTANT: We require the SDK through `eval("require")` so that Turbopack
 * does NOT statically trace it. The transitive pprof/node-pre-gyp tree
 * contains an index.html asset (unknown module type), an `aws-sdk` require
 * (not installed), AND a binary.napi_versions field shape that crashes the
 * Turbopack NodePreGyp resolver. Marking @google-cloud/profiler in
 * serverExternalPackages is not enough — Turbopack still resolves nested
 * package.json bindings before deciding whether to bundle. The eval-built
 * require sidesteps the trace completely; runtime resolution is unaffected.
 */
type ProfilerStart = (config: {
  serviceContext: { service: string; version: string };
  logLevel?: number;
}) => Promise<void>;

export async function startCloudProfiler(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-implied-eval
  const req = eval("require") as NodeRequire;
  const mod = req("@google-cloud/profiler") as { start: ProfilerStart };
  await mod.start({
    serviceContext: {
      service: "velora",
      version: process.env.GIT_SHA ?? "manual",
    },
    // 0 = silent; avoids SDK INFO spam ("Received profile request", etc.)
    // in Cloud Logging where every stdout line becomes a log entry.
    logLevel: 0,
  });
}
