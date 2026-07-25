// _widget-primitives.tsx — NOT a widget entry point.
// Shared presentational primitives bundled into the MCP widgets that import this
// file. Kept separate so the two checkout widgets (payment-link-wizard, catalog-selector)
// don't duplicate the same definitions. esbuild (scripts/build-widget.mjs) resolves
// relative imports and inlines this into each widget bundle independently — no shared
// runtime, no module federation needed.

import React from "react";

/** style is optional so widgets can add hostContext.safeAreaInsets padding on
 *  top of the base p-5 (claude.com/docs/connectors/building/mcp-apps/
 *  design-guidelines#host-context-for-layout) without duplicating this shell. */
export function Card({ title, style, children }: { title: string; style?: React.CSSProperties; children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink" style={style}>
      <h1 className="text-xl font-semibold leading-snug">{title}</h1>
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

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`mt-1 w-full rounded-control bg-accent px-4 py-3 text-base font-semibold text-on-accent disabled:opacity-60 disabled:active:scale-100 ${INTERACTIVE}`}
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
