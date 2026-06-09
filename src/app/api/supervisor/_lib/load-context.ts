import { fetchSupervisorContext } from "./load-context.fetch";

export interface ActiveDelegationPolicy {
  scope: string;
  maxValue: number | null;
  requiresOwner: boolean;
  conditions: string;
}

export interface SupervisorBusinessContext {
  activeRules: Array<{ kind: string; trigger: string; message: string }>;
  activePolicies: ActiveDelegationPolicy[];
  products: Array<{ id: string; name: string; price: number; stock: number }>;
  employees: Array<{ name: string; role: string }>;
  cashBalance: number;
  currency: string;
  productCount: number;
  productsWithoutStock: number;
  employeeCount: number;
  ackedAlerts: Array<{ employeeName: string; text: string }>;
  // Onboarding setup flags. True once the matching update_business_setup action
  // persisted the corresponding column on Business.
  businessNameSet: boolean;
  businessTypeSet: boolean;
  paymentMethodsSet: boolean;
  openingCashSet: boolean;
  // T3b: true when paymentMethods does NOT include "Transferencia"
  // OR Business.alias is a non-null string.
  transferAliasSet: boolean;
  // Raw fields exposed so detectPendingTurn can derive the alias-need check
  // without depending solely on the pre-computed transferAliasSet boolean.
  paymentMethodsIncludeTransferencia: boolean;
  transferAlias: string | null;
  // T4: true when Business.postalCode is a valid 4-5 digit string.
  postalCodeSet: boolean;
  // T5 courier: true when Business.courierPreference is non-empty.
  courierPreferenceSet: boolean;
  // Raw courier preference value ("Andreani" | "OCA" | "Correo" | "ninguno" | null).
  // Needed by the T14 builder to render the chip label/panel for the right courier.
  courierPreference: string | null;
  // T6 WhatsApp: true when Business.whatsappPhone is not null/undefined
  // (empty string "" is valid as a "deferred" sentinel).
  whatsappPhoneSet: boolean;
  // Raw phone value carried alongside the boolean so the OAuth-ack flip
  // comparator can apply a strict non-empty check (needed to distinguish the
  // deferred sentinel "" from a real phone number). Null when the column is
  // null/undefined. Must NOT be used for display — use whatsappPhoneSet only.
  whatsappPhoneRaw: string | null;
  // T7b: seteado mientras el dueño está en el sub-flow de carga de stock
  // inicial. Incluye productId (del campo Business.pendingStockProductId) para
  // que el adjust_stock del cliente use el ID real. Null cuando no aplica.
  pendingStockProduct: { productId: string; name: string } | null;
  // T9: true si paymentMethods incluye "Mercado Pago" (determinado en T3).
  mercadoPagoSelected: boolean;
  // T9: true si ya existe una fila MpConnection para este negocio.
  mercadoPagoConnected: boolean;
  // T9: true si el dueño eligió diferir la conexión MP durante el onboarding.
  mercadoPagoOnboardingDeferred: boolean;
  // Unit 2: código postal del negocio (origen para cotizaciones Andreani).
  // null cuando Business.postalCode aún no fue configurado.
  originPostalCode: string | null;
  // Raw business name for use in greeting copy (e.g., proactive nudge).
  // null when not yet set (onboarding T1 not completed).
  businessName: string | null;
  // Fiscal setup: true when Business.cuit is a non-empty string.
  // Used by the fiscal-setup stage to know whether to intercept invoice intents.
  cuitSet: boolean;
  // Fiscal setup: true when Business.ivaCondition is non-empty.
  ivaConditionSet: boolean;
  // Fiscal setup: true when Business.puntoVenta is non-empty (including "0" sentinel).
  puntoVentaSet: boolean;
  // ARCA cert: true when ArcaCredential row exists for this business
  // (owner uploaded .p12 + passphrase via SettingsFiscalCertCard).
  arcaCertConnected: boolean;
  // Courier credentials: true when CourierCredential exists matching the
  // owner's courierPreference (e.g. Andreani picked + Andreani creds saved).
  courierCredentialsConnected: boolean;
  // MODO wallet: true when ModoConnection row exists for this business.
  modoConnected: boolean;
  // T12 onboarding: number of customers for this business. When > 0, the
  // T_CUSTOMERS onboarding turn is considered done.
  customerCount: number;
  // T12 defer: owner explicitly chose "Saltar por ahora" — suppresses T_CUSTOMERS
  // prompt even when customerCount is still 0. Persistent flag on Business.
  customersOnboardingSkipped: boolean;
  // T13 defer: owner explicitly chose "Más tarde" on the ARCA connect step —
  // suppresses T_ARCA prompt even when arcaCertConnected is still false.
  arcaOnboardingDeferred: boolean;
  // T14 defer: owner explicitly chose "Más tarde" on the Andreani connect step —
  // suppresses T_ANDREANI prompt even when courierCredentialsConnected is still false.
  andreaniOnboardingDeferred: boolean;
  // BYOA pending steps — non-null when the owner clicked "connect" and opened the
  // external provider portal, but hasn't pasted the credential back yet.
  // T13: "awaiting_cuit" | null. T14: "awaiting_token" | null.
  arcaPendingStep: string | null;
  andreaniPendingStep: string | null;
  // Onboarding redesign 2026-05-25 flags.
  skippedCatalog: boolean;
  firstSalePromptShown: boolean;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { value: SupervisorBusinessContext; expiresAt: number }>();
const inflight = new Map<string, Promise<SupervisorBusinessContext>>();

export function invalidateSupervisorContext(businessId: string): void {
  cache.delete(businessId);
  // Also evict any in-flight promise for this key. Without this, a rapid
  // second request after a write can grab the pre-write inflight promise
  // (singleflight dedup returns the stale promise), skipping the DB re-fetch
  // and serving state that predates the mutation. Root cause of the
  // "CUIT persisted null / T13 chips repeat" bug (2026-05-25).
  inflight.delete(businessId);
}

export async function loadSupervisorContext(businessId: string): Promise<SupervisorBusinessContext> {
  const cached = cache.get(businessId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;

  const existing = inflight.get(businessId);
  if (existing) return existing;

  const promise = fetchSupervisorContext(businessId)
    .then((ctx) => {
      cache.set(businessId, { value: ctx, expiresAt: Date.now() + CACHE_TTL_MS });
      inflight.delete(businessId);
      return ctx;
    })
    .catch((err) => {
      inflight.delete(businessId);
      throw err;
    });

  inflight.set(businessId, promise);
  return promise;
}
