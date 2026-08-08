"use client";

import Image from "next/image";

const DEFAULT_PLACEHOLDER_CAPTION =
  'Captura real del widget “veamos mi negocio” — próximamente';

/**
 * The hero visual — a laptop showing a browser tab open on claude.ai, with
 * Velora's "veamos mi negocio" widget (open_business_overview) rendered inside.
 * This is the actual MCP App widget running inside Claude, not a mockup of a
 * generic app — the whole pitch is "your business tools live inside the AI
 * you already use."
 *
 * screenshotSrc is intentionally optional: per this codebase's own rule (see
 * Widgets.tsx), we do not fabricate a screenshot. Until a real capture of the
 * live widget exists at the given path, a clearly-marked placeholder renders
 * instead — swap in the real image and this component needs no other change.
 */
export default function HeroVisual({
  alt,
  screenshotSrc,
  placeholderCaption,
}: {
  alt: string;
  screenshotSrc?: string;
  placeholderCaption?: string;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[560px] md:mx-0">
      {/* Ambient brand glow — depth behind the laptop, not decoration */}
      <div
        aria-hidden
        className="absolute -inset-8 -z-20 rounded-[44px] blur-3xl"
        style={{
          background:
            "radial-gradient(55% 55% at 50% 40%, rgba(27,58,107,.16) 0%, rgba(27,58,107,0) 70%)",
        }}
      />
      {/* Soft contact shadow grounding the laptop */}
      <div
        aria-hidden
        className="absolute inset-x-12 -bottom-2 -z-10 h-9 rounded-[50%] blur-2xl"
        style={{ background: "rgba(27,58,107,.20)" }}
      />

      {/* Laptop screen */}
      <div
        className="overflow-hidden rounded-t-[20px] border border-[color:var(--color-line)] bg-[color:var(--color-bg)]"
        style={{
          boxShadow:
            "0 1px 0 rgba(255,255,255,.7) inset, 0 32px 64px -28px rgba(27,58,107,.5), 0 12px 28px -16px rgba(27,58,107,.3)",
        }}
      >
        {/* Browser chrome */}
        <div className="flex items-center gap-2 border-b border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} aria-hidden />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} aria-hidden />
          <div
            className="ml-3 flex-1 truncate rounded-full bg-[color:var(--color-bg)] px-3 py-1 text-[color:var(--color-ink-60)]"
            style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
          >
            claude.ai
          </div>
        </div>

        {/* Widget viewport */}
        <div className="relative aspect-[5/4] w-full bg-[color:var(--color-surface)]">
          {screenshotSrc ? (
            <Image
              src={screenshotSrc}
              alt={alt}
              fill
              sizes="(max-width: 768px) 560px, 580px"
              className="object-cover object-top"
              priority
            />
          ) : (
            <div className="m-4 flex h-[calc(100%-2rem)] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[color:var(--color-line)] px-6 text-center">
              <p className="m-0 text-[color:var(--color-ink-60)]" style={{ fontSize: "0.875rem" }}>
                {placeholderCaption ?? DEFAULT_PLACEHOLDER_CAPTION}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Laptop base (deck + hinge) */}
      <div
        aria-hidden
        className="mx-auto h-3 w-[94%] rounded-b-[10px] border-x border-b border-[color:var(--color-line)] bg-[color:var(--color-surface)]"
      />
      <div
        aria-hidden
        className="mx-auto h-1.5 w-[36%] rounded-b-[6px]"
        style={{ background: "var(--color-line)" }}
      />
    </div>
  );
}
