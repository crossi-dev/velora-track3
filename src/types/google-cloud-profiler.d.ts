/**
 * Minimal type declarations for @google-cloud/profiler v6.
 * The package ships no bundled TypeScript types and no DefinitelyTyped package
 * exists. Only the `start()` surface used in src/instrumentation/profiler.ts
 * is declared here — everything else is intentionally omitted.
 *
 * Ref: https://cloud.google.com/profiler/docs/profiling-nodejs
 */
declare module "@google-cloud/profiler" {
  interface ServiceContext {
    /** Name of the Cloud Run service. */
    service: string;
    /** Deployed revision / Git SHA. */
    version?: string;
  }

  interface ProfilerConfig {
    serviceContext: ServiceContext;
    /**
     * Log verbosity level (0 = silent).
     * 0 silences all SDK INFO noise in Cloud Logging stdout.
     */
    logLevel?: number;
  }

  /**
   * Start the Cloud Profiler agent.
   * Must be called as early as possible so V8 heap hooks attach before
   * any user code allocates. Returns a Promise that resolves once the
   * agent is registered with the Cloud Profiler service.
   */
  export function start(config: ProfilerConfig): Promise<void>;
}
