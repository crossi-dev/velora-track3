import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Velora — Tu negocio, todo por voz";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%",
          background: "linear-gradient(135deg, #1B3A6B 0%, #0F2347 100%)",
          display: "flex", flexDirection: "column",
          alignItems: "flex-start", justifyContent: "center",
          padding: "80px 80px 64px",
          fontFamily: "Georgia, serif",
          position: "relative",
        }}
      >
        {/* Glow */}
        <div style={{ position: "absolute", top: -100, right: -100, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(74,127,191,0.3) 0%, transparent 70%)" }} />

        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 48 }}>
          <div style={{ width: 28, height: 28, borderRadius: "50%", background: "radial-gradient(circle at 30% 30%, #4A7FBF, #1B3A6B 70%)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.2)" }} />
          <span style={{ color: "rgba(255,255,255,0.9)", fontSize: 28, fontWeight: 500, letterSpacing: "-0.01em" }}>Velora</span>
        </div>

        {/* Headline */}
        <div style={{ display: "flex", flexDirection: "column", color: "#fff", fontSize: 76, fontWeight: 700, lineHeight: 1.02, maxWidth: 800, letterSpacing: "-0.025em", marginBottom: 28 }}>
          <span>Tu negocio,</span>
          <span>todo por voz.</span>
        </div>

        {/* Sub */}
        <div style={{ color: "rgba(255,255,255,0.68)", fontSize: 26, lineHeight: 1.4, maxWidth: 560 }}>
          Vendé, cargá stock y consultá la caja hablando. Gratis para pymes argentinas.
        </div>

        {/* Domain */}
        <div style={{ position: "absolute", bottom: 52, left: 80, color: "rgba(255,255,255,0.35)", fontSize: 18, letterSpacing: "0.02em" }}>
          somosvelora.com
        </div>
      </div>
    ),
    { ...size },
  );
}
