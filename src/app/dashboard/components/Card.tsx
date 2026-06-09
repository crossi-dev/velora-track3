"use client";

export function Card({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="surface-card p-5 md:p-6"
      style={{ backgroundColor: "var(--surface)" }}
    >
      <div>
      {(title || description) && (
        <div className="mb-4">
          {title && <h2 className="text-heading" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-strong)" }}>{title}</h2>}
          {description && (
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", marginTop: "0.25rem" }}>
              {description}
            </p>
          )}
        </div>
      )}
      {children}
      </div>
    </section>
  );
}
