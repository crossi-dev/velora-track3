import { describe, expect, it } from "vitest";
import { traceFieldsFromHeaders } from "@/lib/cloud-logger";

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? "my-gcp-project";

function headers(entries: Record<string, string>): { get: (name: string) => string | null } {
  return { get: (name) => entries[name.toLowerCase()] ?? null };
}

describe("traceFieldsFromHeaders", () => {
  it("returns empty object when no X-Cloud-Trace-Context header", () => {
    expect(traceFieldsFromHeaders(headers({}))).toEqual({});
  });

  it("extracts traceId, spanId and sampled=true when o=1", () => {
    const h = headers({ "x-cloud-trace-context": "abc123def456/789;o=1" });
    const result = traceFieldsFromHeaders(h);
    expect(result["logging.googleapis.com/trace"]).toBe(
      `projects/${PROJECT_ID}/traces/abc123def456`
    );
    expect(result["logging.googleapis.com/spanId"]).toBe("789");
    expect(result["logging.googleapis.com/trace_sampled"]).toBe(true);
  });

  it("sets sampled=false when o=0", () => {
    const h = headers({ "x-cloud-trace-context": "abc123/456;o=0" });
    expect(traceFieldsFromHeaders(h)["logging.googleapis.com/trace_sampled"]).toBe(false);
  });

  it("sets sampled=false when no sampling flag present", () => {
    const h = headers({ "x-cloud-trace-context": "abc123/456" });
    expect(traceFieldsFromHeaders(h)["logging.googleapis.com/trace_sampled"]).toBe(false);
  });

  it("omits spanId field when no span in header", () => {
    const h = headers({ "x-cloud-trace-context": "abc123" });
    const result = traceFieldsFromHeaders(h);
    expect(result["logging.googleapis.com/trace"]).toContain("abc123");
    expect(result).not.toHaveProperty("logging.googleapis.com/spanId");
  });

  it("returns empty object when traceId part is empty string", () => {
    const h = headers({ "x-cloud-trace-context": "/456;o=1" });
    expect(traceFieldsFromHeaders(h)).toEqual({});
  });
});
