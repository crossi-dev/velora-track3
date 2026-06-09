// Re-export from shared lib — logic moved to src/lib/shipping-quote.ts so it
// can be consumed by both the Payments Agent and the call_ventas_agent
// pre-resolver without introducing a lib → app/api import direction inversion.
export type { ShippingAddressSnapshot, ShippingQuoteResult, ResolveShippingInput } from "@/lib/shipping-quote";
export { resolveShippingQuote, extractCheapestPrice, isValidPostalCode } from "@/lib/shipping-quote";
