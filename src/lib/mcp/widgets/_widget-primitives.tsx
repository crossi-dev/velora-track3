// _widget-primitives.tsx — NOT a widget entry point.
// Shared presentational primitives bundled into the MCP widgets that import this
// file. Kept separate so the two checkout widgets (payment-link-wizard, catalog-selector)
// don't duplicate the same definitions. esbuild (scripts/build-widget.mjs) resolves
// relative imports and inlines this into each widget bundle independently — no shared
// runtime, no module federation needed.

import React from "react";

/** Inline Velora mark (crossi-dev/velora public/velora-mark.svg) — every Velora
 *  product carries the mark. No external asset load (CSP-safe). Shared here
 *  (moved from business-overview.tsx, the reference implementation) so every
 *  widget's header can carry the same brand identity, not just one. */
export function VeloraMark({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label="Velora">
      <rect x="4" y="4" width="56" height="56" rx="14" fill="#1B3A6B" />
      <path d="M20 44V20M20 44L44 20M44 20V34" stroke="#FAF6EE" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** style is optional so widgets can add hostContext.safeAreaInsets padding on
 *  top of the base p-5 (claude.com/docs/connectors/building/mcp-apps/
 *  design-guidelines#host-context-for-layout) without duplicating this shell.
 *  Header carries the VeloraMark next to the title — same size (20) and
 *  placement (flex items-center gap-2) as business-overview.tsx's inline
 *  header, the reference implementation. */
export function Card({ title, style, children }: { title: string; style?: React.CSSProperties; children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink" style={style}>
      <div className="flex items-center gap-2">
        <VeloraMark size={20} />
        <h1 className="text-xl font-semibold leading-snug">{title}</h1>
      </div>
      {children}
    </main>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 text-sm text-ink-soft">{label}</div>
      {children}
    </div>
  );
}

// Shared focus ring + motion so every interactive control in every widget
// behaves the same way — a keyboard user tabbing through Velora widgets in
// Claude/ChatGPT sees one consistent, deliberate focus style, not whatever
// the host's default outline happens to be.
const INTERACTIVE = "transition-[background-color,border-color,opacity,transform] duration-[var(--widget-duration)] ease-[var(--widget-ease)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.98]";

// Brand navy instead of the generic chameleon --color-accent (host invert
// token, black-in-light/white-in-dark) — this is the ONE primary/confirm CTA
// per widget, including the ones that fire real mutations (register_sale,
// create_tracked_payment_link, caja_ciclo_caja...). Matches the "accent and
// identity" carve-out business-overview.tsx already uses for its hero border
// and tab bar (--color-brand, widget.css) — same allowed exception, not a new
// token. Never chameleon here on purpose: this is the one button that should
// read as "Velora", not as whatever host is rendering it.
export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`mt-1 w-full rounded-control bg-brand px-4 py-3 text-base font-semibold text-on-brand disabled:opacity-60 disabled:active:scale-100 ${INTERACTIVE}`}
    />
  );
}

export function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`w-full rounded-control border border-line bg-surface px-4 py-2 text-base text-ink hover:bg-surface-2 disabled:opacity-60 disabled:active:scale-100 ${INTERACTIVE}`}
    />
  );
}

export function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto max-w-md p-8 text-center text-base text-ink-soft">{children}</div>;
}

// ── Return hint ──────────────────────────────────────────────────────────────
// Discoverability nudge for widgets reached by jumping from another widget
// (pending-orders → cobro-status → delivery-receipt, business-overview → caja-status).
// There is NO in-widget "back" primitive in the MCP Apps SDK: the App surface
// exposes only requestDisplayMode (inline/fullscreen/pip), requestTeardown,
// callServerTool and sendMessage — no history/stack/goBack. Official guidance
// treats the conversation itself as the navigation surface: "Deep navigation
// (no drill-ins, breadcrumbs, or multiple views)" is a listed pattern to AVOID,
// and "Fullscreen close returns to the conversation at the same scroll position"
// (claude.com/docs/connectors/building/mcp-apps/design-guidelines). A prior
// tool-result widget is not destroyed when a newer one renders — that is exactly
// why the BroadcastChannel supersede pattern can still reach it — so the way back
// is to scroll the chat up. This line just makes that discoverable; it is not a
// custom router. Placed at the TOP because the host clips inline content past its
// height (a bottom footer could fall below the clip line and never be seen).
export function ReturnHint(): React.JSX.Element {
  return (
    <p className="text-center text-xs text-ink-soft" role="note">
      Para volver a la vista anterior, scrolleá el chat hacia arriba.
    </p>
  );
}

/** Shown on an older widget copy once a newer instance of the same widget has
 *  rendered in the conversation (instance-supersession,
 *  claude.com/docs/connectors/building/mcp-apps/instance-supersession). Same copy
 *  and styling in every widget that participates, instead of re-inlining the
 *  banner per file — consolidated for the same reason StatusChip/StatusBanner were. */
export function SupersededNotice(): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-control bg-surface-2 p-3 text-sm text-ink-soft" role="status">
      <span>Esta vista quedó vieja — hay una más nueva en este chat.</span>
    </div>
  );
}

// ── Status chip / banner ─────────────────────────────────────────────────────
// Consolidates the ad-hoc `style={{ color: "light-dark(...)" }}` chips that
// used to be hand-rolled per widget (caja-status, cobro-status, sale-confirm,
// delivery-receipt) into one component backed by widget.css's theme tokens
// (--color-success-surface/-ink, --color-danger-surface/-ink). Same visual
// language everywhere a widget needs to say "this is the good/bad/waiting
// state" — that repetition read as scaffolding, not as a designed system.

export type StatusTone = "success" | "pending" | "danger" | "neutral";

/** Exported so widgets that need a custom banner shape (e.g. a bigger text
 * size than StatusBanner's default) can still resolve the same tone colors
 * instead of re-inventing a light-dark() inline style. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-surface text-success-ink",
  pending: "bg-surface-2 text-ink-soft",
  danger: "bg-danger-surface text-danger-ink",
  neutral: "border border-line bg-surface text-ink-soft",
};

/** Small inline pill — e.g. next to a customer name or list row. */
export function StatusChip({ tone, children }: { tone: StatusTone; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

/** Full-width banner — the loud "this just happened" state (paid, delivered, opened). */
export function StatusBanner({
  tone,
  children,
  ...rest
}: { tone: StatusTone; children: React.ReactNode } & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      {...rest}
      className={`flex items-center justify-center rounded-control px-4 py-3 text-base font-semibold ${TONE_CLASSES[tone]}`}
    >
      {children}
    </div>
  );
}
