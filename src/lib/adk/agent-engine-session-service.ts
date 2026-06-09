import "server-only";
// Vertex AI Agent Engine Session Service for Velora ADK agents.
//
// Implements BaseSessionService by proxying all session operations to the
// Agent Engine Sessions REST API. Transport layer lives in agent-engine-rest.ts.
//
// Feature flag: USE_AGENT_ENGINE_SESSIONS=true enables this service.
// When disabled (default), or when Agent Engine returns 5xx, callers fall
// back to ChatMessageSessionService backed by Postgres.
//
// Auth: GoogleAuth with cloud-platform scope — same as agent-engine-client.ts.
// The Cloud Run service account needs roles/aiplatform.user.

import {
  BaseSessionService,
  createEvent,
  type CreateSessionRequest,
  type GetSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type DeleteSessionRequest,
  type AppendEventRequest,
} from "@google/adk";
import type { Session, Event } from "@google/adk";
import { aeApiFetch, sessionsBase, type AeSession, type AeListSessionsResponse } from "./agent-engine-rest";

// ── Feature flag ──────────────────────────────────────────────────────────────

export function isAgentEngineSessionsEnabled(): boolean {
  return (
    process.env.USE_AGENT_ENGINE_SESSIONS === "true"
    && Boolean(process.env.AGENT_ENGINE_RESOURCE_NAME)
  );
}

// ── Conversion helpers ────────────────────────────────────────────────────────

function sessionIdFromName(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  return name.split("/").pop() ?? fallback;
}

function aeSessionToAdkSession(
  ae: AeSession,
  appName: string,
  userId: string,
  sessionId: string,
): Session {
  const events: Event[] = (ae.events ?? []).map((e) =>
    createEvent({
      id: e.id ?? crypto.randomUUID(),
      invocationId: e.id ?? crypto.randomUUID(),
      author: (e.author === "user" ? "user" : "model") as "user" | "model",
      content: {
        role: (e.content?.role === "user" ? "user" : "model") as "user" | "model",
        parts: (e.content?.parts ?? []).filter(
          (p): p is { text: string } => typeof p.text === "string",
        ),
      },
      timestamp: e.timestamp ? new Date(e.timestamp).getTime() / 1000 : Date.now() / 1000,
    }),
  );

  return {
    id: sessionId,
    appName,
    userId,
    state: (ae.sessionState as Record<string, unknown>) ?? {},
    events,
    lastUpdateTime: ae.updateTime
      ? new Date(ae.updateTime).getTime() / 1000
      : Date.now() / 1000,
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * ADK BaseSessionService backed by Vertex AI Agent Engine Sessions REST API.
 *
 * All methods fail gracefully (undefined / empty list / no-op) so the caller
 * can fall back to Postgres when Agent Engine is unavailable.
 */
export class VertexAgentEngineSessionService extends BaseSessionService {
  private readonly resourceName: string;

  constructor(resourceName: string) {
    super();
    this.resourceName = resourceName;
  }

  async createSession(request: CreateSessionRequest): Promise<Session> {
    const base = sessionsBase(this.resourceName);
    const body = {
      userId: request.userId,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.state ? { sessionState: request.state } : {}),
    };

    const ae = await aeApiFetch<AeSession>({ method: "POST", path: base, body });
    const sid = ae
      ? sessionIdFromName(ae.name, request.sessionId ?? `ae-${Date.now()}`)
      : (request.sessionId ?? `ae-${Date.now()}`);

    return {
      id: sid,
      appName: request.appName,
      userId: request.userId,
      state: request.state ?? {},
      events: [],
      lastUpdateTime: Date.now() / 1000,
    };
  }

  async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    const base = sessionsBase(this.resourceName);
    const ae = await aeApiFetch<AeSession>({
      method: "GET",
      path: `${base}/${encodeURIComponent(request.sessionId)}`,
    });
    if (!ae) return undefined;
    return aeSessionToAdkSession(ae, request.appName, request.userId, request.sessionId);
  }

  async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    const base = sessionsBase(this.resourceName);
    const resp = await aeApiFetch<AeListSessionsResponse>({
      method: "GET",
      path: `${base}?filter=userId=${encodeURIComponent(request.userId)}`,
    });

    const sessions = (resp?.sessions ?? []).map((ae) => {
      const sid = sessionIdFromName(ae.name, "unknown");
      return aeSessionToAdkSession(ae, request.appName, request.userId, sid);
    });

    return { sessions };
  }

  async deleteSession(request: DeleteSessionRequest): Promise<void> {
    const base = sessionsBase(this.resourceName);
    await aeApiFetch<null>({
      method: "DELETE",
      path: `${base}/${encodeURIComponent(request.sessionId)}`,
    });
  }

  override async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    const textPart = event.content?.parts?.find(
      (p): p is { text: string } => "text" in p && typeof (p as { text?: unknown }).text === "string",
    );
    const role = event.content?.role ?? event.author;
    const isTextEvent = (role === "user" || role === "model") && textPart;

    if (isTextEvent) {
      const base = sessionsBase(this.resourceName);
      const body = {
        id: event.id,
        author: role,
        content: { role, parts: [{ text: textPart.text }] },
        timestamp: new Date().toISOString(),
      };
      // Fire-and-forget — appendEvent must return quickly so ADK pipeline isn't stalled.
      // Path uses the custom-method syntax `:appendEvent` required by the REST spec:
      // POST /v1beta1/{session_name}:appendEvent
      // (NOT /sessions/{id}/events — that sub-resource path is wrong and returns 404)
      aeApiFetch<unknown>({
        method: "POST",
        path: `${base}/${encodeURIComponent(session.id)}:appendEvent`,
        body,
      }).catch(() => { /* logged inside aeApiFetch */ });
    }

    return event;
  }
}
