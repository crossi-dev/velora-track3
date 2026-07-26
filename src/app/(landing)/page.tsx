import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import LandingPage from "../LandingPage";
import { LOCALE_COOKIE, pickLocale } from "../_landing/i18n";
import { buildJsonLd } from "../_landing/data";

export default async function HomePage() {
  const session = await auth();

  // Validate that the JWT-authenticated user still exists in the DB. After a
  // wipe (or admin delete), the JWT cookie remains valid client-side but
  // points at a User row that no longer exists. Without this check the user
  // would be redirected into the dashboard with a phantom session and crash.
  const user = session?.user?.id
    ? await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true } })
    : null;

  if (!user) {
    const hdrs = await headers();
    const cookieJar = await cookies();
    const rawCookieHeader = hdrs.get("cookie");
    const localeCookieValue = cookieJar.get(LOCALE_COOKIE)?.value ?? null;
    const locale = pickLocale(hdrs.get("accept-language"), localeCookieValue);
    // TEMP DIAGNOSTIC (2026-07-26) — remove once the switcher bug is confirmed
    // fixed live. Carlos reported the ES/EN switcher does nothing even after
    // the cookie is confirmed set client-side and a real reload is confirmed
    // to hit the origin. This logs exactly what the server sees per request.
    console.log(JSON.stringify({
      severity: "INFO", component: "System", action: "LANDING_LOCALE_DEBUG",
      a2a_transfer: false, message: "landing page locale resolution",
      localeCookieValue, resolvedLocale: locale,
      rawCookiePresent: !!rawCookieHeader,
      rawCookieLength: rawCookieHeader?.length ?? 0,
      acceptLanguage: hdrs.get("accept-language"),
    }));
    return (
      <>
        {/* JSON-LD is server-rendered here so it's in the initial HTML payload
            (not deferred by client JS). The client LandingPage component does NOT
            inject a duplicate — this is the single source. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: buildJsonLd(locale) }}
        />
        <LandingPage locale={locale} />
      </>
    );
  }

  // Authenticated + user exists. Always land in /dashboard. The dashboard
  // itself detects the no-Business state and renders the conversational
  // onboarding inline (chat with the supervisor, no separate form/wizard).
  redirect("/dashboard");
}
