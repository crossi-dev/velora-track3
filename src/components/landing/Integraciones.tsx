import Image from "next/image";

export type IntegrationCard = {
  /** Display name, e.g. "Claude" */
  name: string;
  /** Alt text for the screenshot image */
  imageAlt: string;
  /** Caption rendered below the image area */
  caption: string;
  /** Path under public/ — owner must drop the real PNG here (see code comment) */
  imageSrc: string;
  /**
   * Set to true once the real screenshot PNG exists at public/integraciones/<name>.png.
   * When false the card renders a clean styled placeholder instead of a broken-image icon.
   *
   * OWNER: when you drop the PNG, flip this flag to true in LandingPage.tsx → defaultCopy.integraciones.cards.
   */
  hasScreenshot: boolean;
};

export type IntegracionesCopy = {
  /** Section title, e.g. "Integraciones" */
  title: string;
  /** Short headline above the cards */
  headline: string;
  /** Subcopy paragraph */
  sub: string;
  /** MCP endpoint line */
  endpoint: string;
  /** Integration cards — one per supported AI agent */
  cards: IntegrationCard[];
};

/**
 * "Integraciones" section — Velora lives inside any AI agent (Claude, ChatGPT,
 * Gemini) via the open MCP standard.  The 3 cards show a concrete Claude flow as
 * proof: connect & discover → load stock by chat → sell & charge.
 *
 * IMAGES:
 *   Real screenshots live under public/integraciones/ (claude-1-conectar.jpg,
 *   claude-2-stock.jpg, claude-3-vender.jpg) and are wired with hasScreenshot: true
 *   on each card in landing-copy.ts → integraciones.cards.
 *   When a card has hasScreenshot: false it renders a clean styled placeholder
 *   (no broken-image icon) instead.
 */
export default function Integraciones({ copy }: { copy: IntegracionesCopy }) {
  return (
    <section
      id="integraciones"
      data-screen-label="Integraciones"
      className="py-[clamp(64px,9vw,96px)] border-t border-[color:var(--color-line)]"
    >
      <div className="mx-auto max-w-[1240px] px-[clamp(20px,4vw,56px)]">

        {/* Section label */}
        <p
          className="m-0 mb-5 text-sm font-medium uppercase tracking-[0.12em] text-[color:var(--color-ink-60)]"
          style={{ fontSize: "0.875rem" }}
        >
          {copy.title}
        </p>

        {/* Headline + sub */}
        <div className="mb-[clamp(48px,8vw,80px)] grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <h2
            className="m-0 text-balance font-[family-name:var(--font-serif)] font-semibold leading-[1.1] tracking-[-0.02em] text-[color:var(--color-ink)]"
            style={{ fontSize: "clamp(2rem, 4.5vw, 3.25rem)" }}
          >
            {copy.headline}
          </h2>
          <p
            className="m-0 self-end text-pretty leading-[1.55] text-[color:var(--color-ink-80)]"
            style={{ fontSize: "clamp(1rem, 1.4vw, 1.125rem)" }}
          >
            {copy.sub}
          </p>
        </div>

        {/* Integration cards */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {copy.cards.map((card, i) => (
            <IntegrationTile key={card.imageSrc} card={card} priority={i === 0} />
          ))}
        </div>

        {/* MCP endpoint */}
        <p
          className="mt-10 text-center text-[color:var(--color-ink-60)]"
          style={{ fontSize: "clamp(0.875rem, 1.2vw, 1rem)" }}
        >
          {copy.endpoint.split("tools.somosvelora.com/api/mcp").length > 1 ? (
            <>
              {copy.endpoint.split("tools.somosvelora.com/api/mcp")[0]}
              <code
                className="rounded bg-[color:var(--color-tint)] px-2 py-0.5 font-mono text-[color:var(--color-ink)] border border-[color:var(--color-line)]"
                style={{ fontSize: "0.875rem" }}
              >
                tools.somosvelora.com/api/mcp
              </code>
              {copy.endpoint.split("tools.somosvelora.com/api/mcp")[1]}
            </>
          ) : (
            copy.endpoint
          )}
        </p>
      </div>
    </section>
  );
}

function IntegrationTile({ card, priority = false }: { card: IntegrationCard; priority?: boolean }) {
  return (
    <article className="group overflow-hidden rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-tint)] transition-shadow duration-300 hover:shadow-[0_8px_32px_-8px_rgba(27,58,107,.18)]">
      {/* Screenshot area — matches the source JPG ratio (1080x2098) so the WHOLE
          phone screenshot shows with no crop (object-cover fills edge-to-edge when
          the box ratio equals the image ratio). OS chrome already cropped out. */}
      <div
        className="relative w-full overflow-hidden"
        style={{ aspectRatio: "1080 / 2098" }}
      >
        {card.hasScreenshot ? (
          /* Real screenshot — only rendered once the PNG exists at card.imageSrc.
             OWNER: drop the PNG at public/integraciones/<name>.png and set hasScreenshot: true. */
          <Image
            src={card.imageSrc}
            alt={card.imageAlt}
            fill
            sizes="(max-width: 768px) 100vw, 33vw"
            // priority on the first card: above-the-fold on mobile, prevents white-box flash.
            priority={priority}
            // object-top: anchor the (tall portrait) screenshot to its TOP so the
            // start of the chat is visible, not a center crop that cuts the top off.
            className="object-cover object-top"
          />
        ) : (
          /* Clean placeholder rendered when screenshot is not yet available.
             Looks intentional to investors — no broken-image icon.
             OWNER: once the real PNG is in place, flip hasScreenshot: true on this card
             in LandingPage.tsx to show the image instead. */
          <div
            className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[color:var(--color-bg)] border-b border-dashed border-[color:var(--color-line)]"
            aria-label={card.imageAlt}
          >
            <span
              className="font-[family-name:var(--font-serif)] font-semibold text-[color:var(--color-ink-40)]"
              style={{ fontSize: "clamp(1.125rem, 1.6vw, 1.25rem)" }}
            >
              {card.name}
            </span>
            <span
              className="text-center leading-[1.4] px-6 text-[color:var(--color-ink-40)]"
              style={{ fontSize: "0.875rem" }}
            >
              Captura próximamente / Screenshot coming soon
            </span>
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="px-6 py-5">
        {/* h3 gives the article an accessible name (section already has an h2). */}
        <h3
          className="m-0 mb-1 font-[family-name:var(--font-serif)] font-semibold tracking-[-0.01em] text-[color:var(--color-ink)]"
          style={{ fontSize: "clamp(1.125rem, 1.6vw, 1.25rem)" }}
        >
          {card.name}
        </h3>
        <p
          className="m-0 text-[color:var(--color-ink-60)] leading-[1.5]"
          style={{ fontSize: "0.9375rem" }}
        >
          {card.caption}
        </p>
      </div>
    </article>
  );
}
