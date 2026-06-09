// _widget-primitives.tsx — NOT a widget entry point.
// Shared presentational primitives bundled into the MCP widgets that import this
// file. Kept separate so the two checkout widgets (payment-link-wizard, catalog-selector)
// don't duplicate the same definitions. esbuild (scripts/build-widget.mjs) resolves
// relative imports and inlines this into each widget bundle independently — no shared
// runtime, no module federation needed.

import React from "react";

export function Card({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5 text-ink">
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

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className="mt-1 w-full rounded-control bg-accent px-4 py-3 text-base font-semibold text-on-accent disabled:opacity-60"
    />
  );
}

export function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className="w-full rounded-control border border-line bg-surface px-4 py-2 text-base text-ink"
    />
  );
}

export function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mx-auto max-w-md p-8 text-center text-base text-ink-soft">{children}</div>;
}
