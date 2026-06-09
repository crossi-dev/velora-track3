import { NextResponse } from "next/server";

// A2A agent directory — lists all Velora agents and their .well-known AgentCard URLs.
//
// Discoverable at /.well-known/agents.json (rewritten from next.config.ts).
// Follows a v1.0 directory envelope; not part of the A2A v0.3.0 spec itself
// but aligns with emerging multi-agent discovery conventions.
//
// No auth required — public metadata only. Cached 5 minutes at CDN/proxy layer.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const base = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const agents = [
    {
      id: "velora-supervisor",
      name: "Velora Supervisor",
      agentCard: `${base}/.well-known/agent-card.json`,
    },
    {
      id: "velora-payments",
      name: "Velora Payments Agent",
      agentCard: `${base}/.well-known/payments-agent-card.json`,
    },
    {
      id: "velora-fiscal",
      name: "Velora Fiscal Agent",
      agentCard: `${base}/.well-known/fiscal-agent-card.json`,
    },
    {
      id: "velora-onboarding",
      name: "Velora Onboarding Agent",
      agentCard: `${base}/.well-known/onboarding-agent-card.json`,
    },
    // Operational / inter-company interop agents — added 2026-06-04 so the public
    // directory reflects the real callable surface (was advertising 4 of the live agents).
    // Cards served directly from the per-agent endpoints (no .well-known rewrite needed).
    {
      id: "velora-ventas",
      name: "Velora Ventas Agent",
      agentCard: `${base}/api/agents/ventas/agent-card`,
    },
    {
      id: "velora-inventario",
      name: "Velora Inventario Agent",
      agentCard: `${base}/api/agents/inventario/agent-card`,
    },
    {
      id: "velora-caja",
      name: "Velora Caja Agent",
      agentCard: `${base}/api/agents/caja/agent-card`,
    },
    {
      id: "velora-logistica",
      name: "Velora Logística Agent",
      agentCard: `${base}/api/agents/logistica/agent-card`,
    },
  ];

  const directory = {
    version: "1.0",
    agents,
  };

  return NextResponse.json(directory, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
