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
    // NEXT_LOCALE cookie confirmed (2026-07-26, via a temporary server-side
    // diagnostic log) to not reliably reach the origin on a real browser
    // navigation to "/" — some layer between the browser and Cloud Run
    // strips the Cookie header (Firebase Hosting/CDN, not app code; a plain
    // curl test misleadingly "worked" only because it sent no
    // Accept-Language header, hitting the es-AR DEFAULT by coincidence).
    // This is still the correct value for FIRST paint / SEO (Accept-Language
    // negotiation), but the switcher no longer depends on this cookie ever
    // reaching the server — see LanguageSwitcher.tsx, which switches locale
    // as client state instead.
    const locale = pickLocale(hdrs.get("accept-language"), cookieJar.get(LOCALE_COOKIE)?.value ?? null);
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
