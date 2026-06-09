const TRANSIENT_PRISMA_CODES = new Set([
  "P1001", "P1002", "P1008", "P1017", "P2024", "P2034",
]);

const PERMANENT_PRISMA_CODES = new Set([
  "P2002", "P2003", "P2025",
]);

export function classifyError(err: unknown): "transient" | "permanent" | "unknown" {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") {
    if (TRANSIENT_PRISMA_CODES.has(code)) return "transient";
    if (PERMANENT_PRISMA_CODES.has(code)) return "permanent";
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  if (msg.includes("econnrefused") || msg.includes("etimedout") || msg.includes("network")) return "transient";
  return "unknown";
}
