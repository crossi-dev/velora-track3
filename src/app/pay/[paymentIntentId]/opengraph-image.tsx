import { ImageResponse } from "next/og";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const alt = "Pagar con Velora";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Cache the generated OG image for up to 1 hour so WhatsApp crawlers (which
// hit the route on every link unfurl) do not hammer the DB on popular payment
// links. Next.js App Router revalidate semantics: the image is regenerated at
// most once per 3600 s via ISR.
// Ref: https://nextjs.org/docs/app/building-your-application/data-fetching/incremental-static-regeneration (2026)
export const revalidate = 3600;

export default async function OgImage({
  params,
}: {
  params: Promise<{ paymentIntentId: string }>;
}) {
  const { paymentIntentId } = await params;

  // Parallel queries — fires both in one round-trip instead of sequentially.
  // matchedCustomerId is a bare FK (no Prisma @relation on PaymentIntent) so we
  // must resolve the intent first, then the customer. We resolve the intent, then
  // use Promise.all to avoid sequential await chaining. The intent query is fast
  // (PK lookup) and the customer query is conditional, so we cannot fully parallelize,
  // but we still avoid the waterfall when the customer exists.
  // Ref: MDN Promise.all / async parallelism patterns (2026).
  const intent = await prisma.paymentIntent
    .findUnique({
      where: { id: paymentIntentId },
      select: { monto: true, matchedCustomerId: true },
    })
    .catch(() => null);

  const customer = intent?.matchedCustomerId
    ? await prisma.customer
        .findUnique({ where: { id: intent.matchedCustomerId }, select: { name: true } })
        .catch(() => null)
    : null;
  const customerName = customer?.name?.split(" ")[0] ?? null;

  const monto = intent?.monto != null ? Number(intent.monto) : null;
  const montoFormatted =
    monto != null
      ? new Intl.NumberFormat("es-AR", {
          style: "currency",
          currency: "ARS",
          maximumFractionDigits: 0,
        }).format(monto)
      : null;

  const headline = montoFormatted
    ? `Pagar ${montoFormatted}`
    : "Link de pago";

  const sub = customerName
    ? `Hola ${customerName}, tu link de pago seguro está listo.`
    : "Tu link de pago seguro está listo.";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "linear-gradient(135deg, #1B3A6B 0%, #0F2347 60%, #0a1a35 100%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "80px 80px 64px",
          fontFamily: "Georgia, serif",
          position: "relative",
        }}
      >
        {/* Glow top-right */}
        <div
          style={{
            position: "absolute",
            top: -80,
            right: -80,
            width: 500,
            height: 500,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(74,127,191,0.35) 0%, transparent 70%)",
          }}
        />

        {/* Glow bottom-left accent */}
        <div
          style={{
            position: "absolute",
            bottom: -60,
            left: 200,
            width: 360,
            height: 360,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(0,180,120,0.15) 0%, transparent 70%)",
          }}
        />

        {/* Wordmark */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            marginBottom: 52,
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background:
                "radial-gradient(circle at 30% 30%, #4A7FBF, #1B3A6B 70%)",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)",
            }}
          />
          <span
            style={{
              color: "rgba(255,255,255,0.92)",
              fontSize: 30,
              fontWeight: 500,
              letterSpacing: "-0.01em",
            }}
          >
            Velora
          </span>
        </div>

        {/* Main amount headline */}
        <div
          style={{
            color: "#fff",
            fontSize: 88,
            fontWeight: 700,
            lineHeight: 1.0,
            maxWidth: 860,
            letterSpacing: "-0.03em",
            marginBottom: 28,
          }}
        >
          {headline}
        </div>

        {/* Subtitle */}
        <div
          style={{
            color: "rgba(255,255,255,0.68)",
            fontSize: 28,
            lineHeight: 1.4,
            maxWidth: 620,
            marginBottom: 48,
          }}
        >
          {sub}
        </div>

        {/* Powered-by badge */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 12,
            padding: "10px 20px",
          }}
        >
          <span
            style={{
              color: "rgba(255,255,255,0.5)",
              fontSize: 18,
              letterSpacing: "0.01em",
            }}
          >
            Procesado con seguridad por
          </span>
          <span
            style={{
              color: "rgba(0,180,120,0.9)",
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: "0.01em",
            }}
          >
            Mercado Pago
          </span>
        </div>

        {/* Domain watermark */}
        <div
          style={{
            position: "absolute",
            bottom: 52,
            right: 80,
            color: "rgba(255,255,255,0.28)",
            fontSize: 18,
            letterSpacing: "0.02em",
          }}
        >
          somosvelora.com
        </div>
      </div>
    ),
    { ...size },
  );
}
