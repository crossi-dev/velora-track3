import type { Metadata, Viewport } from "next";
import { Fraunces, DM_Sans, JetBrains_Mono } from "next/font/google";
import { SessionProvider } from "next-auth/react";
import { cookies } from "next/headers";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { CapacitorAppLinkHandler } from "@/components/CapacitorAppLinkHandler";
import { OfflineBanner } from "@/components/OfflineBanner";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { NativeAuthBootstrap } from "@/app/_native-bootstrap";
import { Toaster } from "@/components/ui/sonner";
import { LOCALE_COOKIE } from "@/app/_landing/i18n";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const BASE_URL = "https://somosvelora.com";

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: { default: "Velora — Agentic Commerce, End to End", template: "%s | Velora" },
  description: "An AI agent sells, charges, invoices, and ships autonomously — agent-to-agent over A2A. Operated from Claude, ChatGPT, or Gemini via the open MCP standard.",
  keywords: ["agentic commerce", "MCP server", "AI commerce agent", "A2A interoperability", "Model Context Protocol", "MercadoPago", "ARCA", "Argentina", "Velora"],
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Velora" },
  icons: {
    apple: [
      { url: "/apple-touch-icon.png" },
      { url: "/icon-180.png", sizes: "180x180", type: "image/png" },
    ],
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  },
  // hreflang alternate links — tells crawlers the same URL serves es-AR and en.
  // Source: https://nextjs.org/docs/app/api-reference/functions/generate-metadata#alternates
  alternates: {
    canonical: BASE_URL,
    languages: {
      "es-AR": BASE_URL,
      "en": BASE_URL,
      "x-default": BASE_URL,
    },
  },
  // OG/Twitter copy is BILINGUAL (ES · EN) per owner request — the single shared
  // URL reaches both AR and international audiences, so the link preview carries
  // Spanish + English together. The opengraph-image stays Spanish.
  openGraph: {
    type: "website",
    locale: "es_AR",
    alternateLocale: ["en_US"],
    url: BASE_URL,
    siteName: "Velora",
    title: "Velora — Tu negocio, todo por voz · Your business, all by voice",
    description: "Vendé, cargá stock y consultá la caja hablando · Sell, manage stock and check the register by voice. Gratis / Free.",
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: "Velora — Tu negocio, todo por voz · Your business, all by voice" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Velora — Tu negocio, todo por voz · Your business, all by voice",
    description: "Vendé, cargá stock y consultá la caja hablando · Sell, manage stock and check the register by voice. Gratis / Free.",
    images: ["/opengraph-image"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF6EE" },
    { media: "(prefers-color-scheme: dark)", color: "#0B1628" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Derive html[lang] from the NEXT_LOCALE cookie so screen readers and
  // browser translation get the correct language signal.
  // Default: es-AR (Argentine target market). Cookie=en → lang="en".
  const cookieJar = await cookies();
  const localeCookie = cookieJar.get(LOCALE_COOKIE)?.value ?? null;
  const htmlLang = localeCookie === "en" ? "en" : "es-AR";

  return (
    <html lang={htmlLang} suppressHydrationWarning className={`${fraunces.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <head>
        {/* Sets data-theme="dark" on <html> before first paint — no FOUC.
            Mirrors src/lib/theme.ts logic; keep them in sync. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {/*
          iOS PWA splash screens — apple-touch-startup-image.
          Media queries target logical points (device-width × device-height).
          Splash genérico: /splash-default.svg — Velora mark centrado en bg cream #FAF6EE.
          Reemplazar con PNGs exactos por dimensión cuando estén disponibles (eg. progressier.com).
          Breakpoints cubiertos:
            iPhone SE 2nd/3rd gen    : 375×667 @2x → 750×1334 px
            iPhone 14 / 15           : 390×844 @3x → 1170×2532 px
            iPhone 14 Pro Max / 15+  : 430×932 @3x → 1290×2796 px
        */}
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)"
          href="/splash-default.svg"
        />
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
          href="/splash-default.svg"
        />
        <link
          rel="apple-touch-startup-image"
          media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)"
          href="/splash-default.svg"
        />
      </head>
      <body className="antialiased" style={{ fontFamily: "var(--font-dm-sans), sans-serif" }}>
        {/* WCAG 2.4.1 skip link — CSS-only (Server-Component-safe; no event handlers). */}
        <a href="#main-content" className="skip-to-content">
          Saltar al contenido
        </a>
        <SessionProvider>{children}</SessionProvider>
        <NativeAuthBootstrap />
        <OfflineBanner />
        <CapacitorAppLinkHandler />
        <ServiceWorkerRegistrar />
        <Toaster />
      </body>
    </html>
  );
}
