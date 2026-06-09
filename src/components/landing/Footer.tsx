export type FooterCopy = {
  copyright: string;
  links: { label: string; href: string }[];
  contactEmail: string;
};

export default function Footer({ copy }: { copy: FooterCopy }) {
  return (
    <footer
      data-screen-label="Footer"
      className="border-t border-[color:var(--color-line)] pt-9 pb-12"
    >
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-1.5 px-[clamp(20px,4vw,56px)] text-sm text-[color:var(--color-ink-60)]">
        <span>{copy.copyright}</span>
        {copy.links.map((l) => (
          <span key={l.href} className="flex items-center gap-x-6">
            <span aria-hidden className="text-[color:var(--color-ink-40)]">·</span>
            <a
              href={l.href}
              className="transition-colors duration-200 hover:text-[color:var(--color-ink)]"
            >
              {l.label}
            </a>
          </span>
        ))}
        <a
          href={`mailto:${copy.contactEmail}`}
          className="ml-auto basis-full transition-colors duration-200 hover:text-[color:var(--color-ink)] sm:basis-auto"
        >
          {copy.contactEmail}
        </a>
      </div>
    </footer>
  );
}
