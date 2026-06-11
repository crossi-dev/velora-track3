// /en route — sets NEXT_LOCALE=en cookie and redirects to / so the landing page
// renders in English. Idiomatic Next.js App Router route handler (no client JS).
//
// Pattern: https://nextjs.org/docs/app/building-your-application/routing/route-handlers
// Cookie-based i18n: https://nextjs.org/docs/app/building-your-application/routing/internationalization

import { NextResponse } from "next/server";
import { LOCALE_COOKIE } from "@/app/_landing/i18n";

export function GET(): NextResponse {
  const res = NextResponse.redirect(new URL("/", process.env.NEXTAUTH_URL ?? "https://somosvelora.com"), 307);
  res.cookies.set(LOCALE_COOKIE, "en", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
  });
  return res;
}
