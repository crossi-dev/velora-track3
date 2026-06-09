/**
 * Landing-only layout segment.
 *
 * The public landing follows the user's theme: the root layout's
 * THEME_BOOT_SCRIPT sets [data-theme="dark"] on <html> when the OS (or the
 * stored preference) is dark, before first paint. The landing's design tokens
 * (--color-bg, --color-ink, … defined in globals.css) have light AND dark
 * values, so the whole page — and the document scrollbar, via the <html>
 * color-scheme — flips with the theme. No light-only isolation anymore.
 *
 * The wrapper paints the page background/foreground from the tokens so the
 * area outside the sections also adapts. Route group `(landing)` keeps the
 * URL flat (still `/`).
 */
export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        backgroundColor: "var(--color-bg)",
        color: "var(--color-ink)",
        minHeight: "100vh",
      }}
    >
      {children}
    </div>
  );
}
