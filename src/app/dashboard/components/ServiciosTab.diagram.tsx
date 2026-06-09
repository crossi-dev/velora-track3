"use client";

import { useRef, useLayoutEffect, useState, useCallback } from "react";
import type { ProviderStatus } from "./ServiciosTab.cards";
import {
  AgentNode,
  ServiceNode,
  ConnectorSVG,
  DIAGRAM_MOBILE_CSS,
  type ConnectorPath,
} from "./ServiciosTab.diagram.nodes";

// ─── Path computation helper ──────────────────────────────────────────────────

function buildPath(
  containerRect: DOMRect,
  fromEl: HTMLElement,
  toEl: HTMLElement,
  key: string,
  connected: boolean,
  dashed: boolean,
): ConnectorPath {
  const aRect = fromEl.getBoundingClientRect();
  const sRect = toEl.getBoundingClientRect();

  const ax = aRect.right - containerRect.left;
  const ay = aRect.top + aRect.height / 2 - containerRect.top;
  const sx = sRect.left - containerRect.left;
  const sy = sRect.top + sRect.height / 2 - containerRect.top;
  const dx = (sx - ax) * 0.45;

  return {
    key,
    d: `M ${ax} ${ay} C ${ax + dx} ${ay}, ${sx - dx} ${sy}, ${sx} ${sy}`,
    connected,
    dashed,
  };
}

// ─── ServiceDiagram ───────────────────────────────────────────────────────────

export interface ServiceDiagramProps {
  agentLabel: string;
  providers: ProviderStatus[];
  dashedLines?: boolean;
  /** Called when the user clicks a service node. Parent opens the connect modal. */
  onProviderClick?: (provider: ProviderStatus) => void;
}

export function ServiceDiagram({
  agentLabel,
  providers,
  dashedLines = false,
  onProviderClick,
}: ServiceDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const serviceEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paths, setPaths] = useState<ConnectorPath[]>([]);

  const computePaths = useCallback(() => {
    const container = containerRef.current;
    const agentEl = agentRef.current;
    if (!container || !agentEl) return;
    const cRect = container.getBoundingClientRect();
    if (cRect.width < 480) { setPaths([]); return; }

    const next: ConnectorPath[] = [];
    for (const p of providers) {
      const el = serviceEls.current.get(p.id);
      if (!el) continue;
      next.push(buildPath(cRect, agentEl, el, p.id, p.connected, dashedLines));
    }
    setPaths(next);
  }, [providers, dashedLines]);

  useLayoutEffect(() => {
    computePaths();
    const obs = new ResizeObserver(computePaths);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [computePaths]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div
        className="service-diagram-layout"
        style={{ display: "flex", alignItems: "center", gap: "32px", flexWrap: "wrap" }}
      >
        <div ref={agentRef} style={{ flexShrink: 0 }}>
          <AgentNode label={agentLabel} primary />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
          {providers.map((p) => (
            <div
              key={p.id}
              ref={(el) => {
                if (el) serviceEls.current.set(p.id, el);
                else serviceEls.current.delete(p.id);
              }}
              style={{ display: "inline-block" }}
            >
              <ServiceNode provider={p} onClick={onProviderClick} />
            </div>
          ))}
        </div>
      </div>

      {paths.length > 0 && <ConnectorSVG paths={paths} />}
      <style>{DIAGRAM_MOBILE_CSS}</style>
    </div>
  );
}

// ─── SupervisorDiagram ────────────────────────────────────────────────────────

const SUB_AGENTS = [
  { id: "companion", label: "Companion" },
  { id: "fiscal", label: "Fiscal" },
  { id: "ventas", label: "Ventas" },
  { id: "logistica", label: "Logística" },
];

export function SupervisorDiagram() {
  const containerRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const subEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paths, setPaths] = useState<ConnectorPath[]>([]);

  const computePaths = useCallback(() => {
    const container = containerRef.current;
    const agentEl = agentRef.current;
    if (!container || !agentEl) return;
    const cRect = container.getBoundingClientRect();
    if (cRect.width < 480) { setPaths([]); return; }

    const next: ConnectorPath[] = [];
    for (const sub of SUB_AGENTS) {
      const el = subEls.current.get(sub.id);
      if (!el) continue;
      next.push(buildPath(cRect, agentEl, el, sub.id, true, true));
    }
    setPaths(next);
  }, []);

  useLayoutEffect(() => {
    computePaths();
    const obs = new ResizeObserver(computePaths);
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [computePaths]);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <div
        className="service-diagram-layout"
        style={{ display: "flex", alignItems: "center", gap: "32px", flexWrap: "wrap" }}
      >
        <div ref={agentRef} style={{ flexShrink: 0 }}>
          <AgentNode label="Supervisor" primary />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {SUB_AGENTS.map((sub) => (
            <div
              key={sub.id}
              ref={(el) => {
                if (el) subEls.current.set(sub.id, el);
                else subEls.current.delete(sub.id);
              }}
              style={{ display: "inline-block" }}
            >
              <AgentNode label={sub.label} />
            </div>
          ))}
        </div>
      </div>

      {paths.length > 0 && <ConnectorSVG paths={paths} />}
      <style>{DIAGRAM_MOBILE_CSS}</style>
    </div>
  );
}
