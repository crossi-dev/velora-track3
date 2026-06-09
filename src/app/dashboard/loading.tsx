// Route-level loading UI shown by Next.js App Router while the dashboard server
// component suspends (auth() resolution + initial render) — before the client
// shell hydrates and its own DashboardLoadingState takes over. Replaces a blank
// frame with a lightweight skeleton during that brief server window.
// Server component (no hooks): dependency-free inline styles using the app's
// design tokens so it matches the shell without pulling client bundles in.
// Source: https://nextjs.org/docs/app/api-reference/file-conventions/loading

const shimmer: React.CSSProperties = {
  borderRadius: "var(--radius-md, 0.5rem)",
  background: "var(--surface-subtle, #f1f1f1)",
};

function Bar({ w, h = 14 }: { w: string; h?: number }) {
  return <div style={{ ...shimmer, width: w, height: h }} aria-hidden />;
}

export default function DashboardLoading() {
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1.5rem 1rem", maxWidth: 640, margin: "0 auto" }}
      role="status"
      aria-label="Cargando panel"
    >
      <Bar w="40%" h={22} />
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.5rem" }}>
        <Bar w="100%" h={56} />
        <Bar w="92%" h={56} />
        <Bar w="78%" h={56} />
      </div>
    </div>
  );
}
