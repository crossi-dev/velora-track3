/**
 * Shared parser for stock_below trigger expressions.
 *
 * Format: `stock_below:PRODUCT_NAME:THRESHOLD`
 * Product names may contain colons — only the last segment is the threshold.
 * Both callers (condition-stock-rules.ts and planner-threshold.ts) must use
 * this function so parsing logic cannot diverge.
 */
export function parseTrigger(trigger: string): { name: string; threshold: number } | null {
  const parts = trigger.split(":");
  if (parts.length < 3 || parts[0] !== "stock_below") return null;
  const threshold = parseInt(parts[parts.length - 1], 10);
  if (isNaN(threshold) || threshold < 0) return null;
  const name = parts.slice(1, -1).join(":");
  return name.trim() ? { name: name.trim(), threshold } : null;
}
