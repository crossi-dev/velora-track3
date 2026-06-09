// Public payment landing page — no auth required.
// Serves a Velora-branded intermediate page with high-res OG metadata
// (1200×630) so WhatsApp renders a rich preview instead of the tiny
// MP default thumbnail. After 3 s (or immediately if JS runs) the user
// is forwarded to the MP checkout URL.
//
// Security note: the paymentIntentId is a CUID — opaque and unguessable.
// We intentionally do NOT filter by businessId here because the public
// caller has no auth context. We expose only: monto + customerFirstName.
// No PII beyond the first name, no internal IDs in the HTML.
//
// Open-redirect mitigation: checkoutUrl is validated against an MP origin
// allowlist before being emitted into HTML or JS. Any tampered URL causes
// notFound() + CRITICAL log. OWASP ASVS 5.1.5 / OWASP Testing Guide OTG-CLIENT-004
// (2026): validate redirect targets against a strict allowlist, never trust DB values
// without re-validation at render time.
// Ref: https://owasp.org/www-community/attacks/Open_redirect (2026 guidance)

import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { PayLandingClient } from "./_lib/PayLandingClient";
import { PayLandingError } from "./_lib/PayLandingError";

interface Props {
  params: Promise<{ paymentIntentId: string }>;
}

// OWASP open-redirect allowlist: only Mercado Pago checkout domains are permitted.
// Ref: https://owasp.org/www-community/attacks/Open_redirect (2026 guidance)
const MP_CHECKOUT_ALLOWED_ORIGINS = [
  "https://www.mercadopago.com.ar/",
  "https://www.mercadopago.com/",
  "https://www.mercadopago.com.br/",
  "https://www.mercadopago.cl/",
  "https://www.mercadopago.com.co/",
  "https://www.mercadopago.com.mx/",
  "https://www.mercadopago.com.pe/",
  "https://www.mercadopago.com.uy/",
];

function isAllowedCheckoutUrl(url: string): boolean {
  return MP_CHECKOUT_ALLOWED_ORIGINS.some((origin) => url.startsWith(origin));
}

// React cache() deduplicates DB calls within a single render cycle (generateMetadata + Page).
// Ref: https://react.dev/reference/react/cache — "server-only data fetching and memoization" (2026)
const resolveIntent = cache(async (id: string) => {
  return prisma.paymentIntent
    .findUnique({
      where: { id },
      select: {
        checkoutUrl: true,
        monto: true,
        matchedCustomerId: true,
        estado: true,
      },
    })
    .catch(() => null);
});

const resolveCustomerName = cache(async (customerId: string | null): Promise<string | null> => {
  if (!customerId) return null;
  const customer = await prisma.customer
    .findUnique({ where: { id: customerId }, select: { name: true } })
    .catch(() => null);
  return customer?.name?.split(" ")[0] ?? null;
});

// ── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { paymentIntentId } = await params;
  const intent = await resolveIntent(paymentIntentId);

  if (!intent) {
    return { title: "Link no encontrado — Velora" };
  }

  const monto = Number(intent.monto);
  const montoFormatted = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(monto);

  const ogUrl = `https://somosvelora.com/pay/${paymentIntentId}`;
  const ogImageUrl = `${ogUrl}/opengraph-image`;

  return {
    title: `Pagar ${montoFormatted} — Velora`,
    description: `Link de pago seguro por ${montoFormatted}. Procesado por Mercado Pago.`,
    openGraph: {
      title: `Pagar ${montoFormatted}`,
      description: `Tu link de pago seguro está listo. Procesado por Mercado Pago.`,
      url: ogUrl,
      siteName: "Velora",
      images: [
        {
          url: ogImageUrl,
          width: 1200,
          height: 630,
          alt: `Pagar ${montoFormatted} con Velora`,
        },
      ],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: `Pagar ${montoFormatted} — Velora`,
      description: `Link de pago seguro. Procesado por Mercado Pago.`,
      images: [ogImageUrl],
    },
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function PayPage({ params }: Props) {
  const { paymentIntentId } = await params;
  const intent = await resolveIntent(paymentIntentId);

  if (!intent || !intent.checkoutUrl) {
    notFound();
  }

  // Allowlist-only estado check: only expose "pending" and "confirmed" as active pay links.
  // Any other status (cancelled, expired, refunded, future states) shows a branded "link venció"
  // page — NOT a bare 404. Explicit allowlist is safer than a blocklist; new states default to
  // the expired page, not an exposed redirect.
  // Ref: Next.js App Router — notFound() is reserved for "record doesn't exist"; controlled
  // business states render inline branded components instead.
  // https://nextjs.org/docs/app/api-reference/file-conventions/error (Next.js 16, 2026)
  if (!["pending", "confirmed"].includes(intent.estado)) {
    return (
      <PayLandingError
        variant="expired"
        paymentIntentId={paymentIntentId}
      />
    );
  }

  // Open-redirect mitigation: validate checkoutUrl against MP origin allowlist before
  // writing it into <meta http-equiv="refresh"> or window.location.href. A tampered DB
  // value (e.g. via SQL injection or misconfigured webhook) must never redirect users
  // to an attacker-controlled URL. OWASP ASVS 5.1.5 / OTG-CLIENT-004 (2026).
  if (!isAllowedCheckoutUrl(intent.checkoutUrl)) {
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "PAY_LANDING_OPEN_REDIRECT_BLOCKED",
      a2a_transfer: false,
      message: `checkoutUrl failed MP origin allowlist — open redirect blocked for intent ${paymentIntentId}`,
      data: { paymentIntentId, urlPrefix: intent.checkoutUrl.slice(0, 40) },
    });
    // Render branded "link inválido" page — NOT a bare 404. notFound() is reserved for
    // "record doesn't exist". A tampered/invalid URL is a known error state that deserves
    // a human-readable explanation, not a generic Next.js 404 shell.
    // OWASP ASVS 5.1.5 / OTG-CLIENT-004 (2026): block the redirect AND inform the user clearly.
    return (
      <PayLandingError
        variant="invalid"
        paymentIntentId={paymentIntentId}
      />
    );
  }

  const customerName = await resolveCustomerName(intent.matchedCustomerId ?? null);
  const monto = Number(intent.monto);
  const montoFormatted = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(monto);

  return (
    <>
      {/* Meta-refresh fallback for browsers / crawlers that don't run JS */}
      <meta httpEquiv="refresh" content={`3; url=${intent.checkoutUrl}`} />

      <PayLandingClient
        checkoutUrl={intent.checkoutUrl}
        montoFormatted={montoFormatted}
        customerName={customerName}
      />
    </>
  );
}
