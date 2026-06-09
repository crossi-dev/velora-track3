// Businesses that get mock-mode ON and AI rate/quota limiters OFF (Carlos's demos / internal).
// Set DEMO_BUSINESS_IDS=id1,id2 in Cloud Run env. Adding a demo business = env update, no code change.
const DEMO_BIZ_IDS: ReadonlySet<string> = new Set(
  (process.env.DEMO_BUSINESS_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

export function isDemoBusiness(businessId: string | null | undefined): boolean {
  return !!businessId && DEMO_BIZ_IDS.has(businessId);
}
