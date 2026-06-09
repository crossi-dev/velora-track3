"use client";

import Image from "next/image";

/**
 * The hero visual — a TIGHT, focused snippet of a real Velora conversation
 * ("tenés fernet?" → honest "no figura, ¿querés cargarlo?" + action chips),
 * framed as a clean floating chat card (not a phone — the crop is a snippet,
 * so a device bezel would read as a broken short phone). Senior-grade depth:
 * concentric radius, a hairline border, layered ambient + contact shadows, and
 * a soft brand-navy glow grounding it. The source JPG is pre-cropped (OS chrome
 * removed) so the card shows only the conversation.
 */
export default function HeroVisual({ alt }: { alt: string }) {
  return (
    <div className="relative mx-auto w-full max-w-[440px] md:mx-0">
      {/* Ambient brand glow — depth behind the card, not decoration */}
      <div
        aria-hidden
        className="absolute -inset-8 -z-20 rounded-[44px] blur-3xl"
        style={{
          background:
            "radial-gradient(55% 55% at 50% 40%, rgba(27,58,107,.16) 0%, rgba(27,58,107,0) 70%)",
        }}
      />
      {/* Soft contact shadow grounding the card */}
      <div
        aria-hidden
        className="absolute inset-x-10 -bottom-3 -z-10 h-9 rounded-[50%] blur-2xl"
        style={{ background: "rgba(27,58,107,.20)" }}
      />

      {/* The floating conversation card */}
      <div
        className="overflow-hidden rounded-[26px] border border-[color:var(--color-line)] bg-[color:var(--color-bg)]"
        style={{
          boxShadow:
            "0 1px 0 rgba(255,255,255,.7) inset, 0 32px 64px -28px rgba(27,58,107,.5), 0 12px 28px -16px rgba(27,58,107,.3)",
        }}
      >
        <Image
          src="/hero-velora-app.jpg"
          alt={alt}
          width={1080}
          height={1000}
          priority
          sizes="(max-width: 768px) 440px, 460px"
          className="block h-auto w-full"
        />
      </div>
    </div>
  );
}
