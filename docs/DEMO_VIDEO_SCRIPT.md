# Velora — Demo Video Script
## Google AI Agents Challenge — Track 3

> NOTE — Draft storyboard kept for production history. The submitted video is v2 (≈2:56, English narration, Owner/Customer personas, 12-endpoint agent topology) — scene plan in `scripts/_contest-v2-plan.md`. Claims wording below is superseded by the final cut.

**Final duration**: ≈2:56 (176 seconds, contest limit 180s)
**Language**: English narration (contest requirement). Argentine Spanish visible in the UI is fine — judges see a real product.
**Format**: Screen recording with voice-over. No background music under narration.

---

## Intro hook (read before recording — use as opening title card or opening VO)

> "Every Argentine business runs on a web of incompatible systems — payments, tax authority, logistics, marketplace. Today, a human has to bridge every gap. Velora is the A2A interoperability layer that makes those bridges agent-to-agent, coordinated by a Supervisor running Gemini 2.5 Pro on Vertex AI."

---

## Shot list

| Timestamp | Visual (what's on screen) | Narration (spoken in English) |
|-----------|---------------------------|-------------------------------|
| **0:00–0:08** | Velora landing page at `somosvelora.com`. Then cut to a diagram slide: three icons — Distributor, Point-of-Sale, ARCA — connected by arrows labeled "A2A v0.3.0". | "Velora is an A2A interoperability layer. A distributor's Supervisor agent coordinates payments, fiscal invoicing, and logistics — all agent-to-agent, over an open protocol." |
| **0:08–0:18** | Architecture diagram (from `docs/ARCHITECTURE.md`). Highlight the two layers: Supervisor at top, the A2A specialist sub-agents (Payments, Fiscal, Logística, …) below, external systems at the bottom. Hold for ~5 seconds. | "The Supervisor — Gemini 2.5 Pro on Vertex AI — orchestrates A2A specialist sub-agents, each a standards-compliant wrapper for an external system." |
| **0:18–0:32** | Owner chat UI. Type: `"Send a payment link to Carla for 2 Alfajores Havanna"`. Show the Supervisor thinking indicator, then the response: a MercadoPago payment link card. Bottom-left callout: **"MercadoPago Sandbox"**. | "The owner types in plain language. The Supervisor delegates to the Payments Agent over a real A2A HTTP call — not an in-process mock. A MercadoPago payment link comes back in seconds." |
| **0:32–0:42** | Show Cloud Logging in a browser tab: one structured log entry — `ADK_A2A_PAYMENTS_CALL` with `method: payment.create_link`, `agentId: payments`, `durationMs: ~2300`. | "That delegation is a real signed JSON-RPC call. Here it is in Cloud Logging — authenticated with Ed25519 identity, logged with trace context." |
| **0:42–0:56** | Back to owner chat. Simulate payment confirmed (or show the auto-trigger message). The chat shows: "Invoice emitted — Factura B #0001-00000042". Bottom-left callout: **"ARCA Sandbox"**. Then cut to show WhatsApp receipt message arriving on screen. | "On payment confirmation, the Supervisor auto-invokes the Fiscal Agent. It calls Argentina's tax authority — ARCA — and emits the electronic invoice. A receipt goes to the customer on WhatsApp. Zero human steps." |
| **0:56–1:08** | Switch to a terminal or notebook. Run a natural-language query against the **Vertex Agent Engine** endpoint: `"Show me products for carrying things on your back"`. Show the response returning "Mochila Urban 25L" from the product catalog. Bottom-left callout: **"Vertex AI Search — semantic grounding"**. | "Here's the killer feature: the Vertex Agent Engine endpoint, running the same Gemini ADK runtime. Ask it in natural language — 'products for carrying things on your back' — and Vertex AI Search resolves 'Mochila' by meaning, not keyword. The agent calls Velora's MCP tool `query_catalog` directly." |
| **1:08–1:18** | Show the MCP server header comment in `src/lib/mcp/server.ts` (lines 1–6): **"14 tool packs, 51 tools"**. Then show a second terminal calling the MCP endpoint with `register_sale` — the sale registers and returns confirmation JSON. | "That MCP server — 51 tools across 14 packs — is shared. Any ADK agent, any engine, any model plugs into the same tools without rewriting them. Velora is engine-agnostic by design." |
| **1:18–1:28** | Show the agent-card endpoint in a browser: `GET /api/agents/payments/agent-card`. JSON response visible with `protocolVersion: "0.3.0"`, `skills`, `jwks_uri`. | "Every agent exposes a standard A2A card — discoverable by any A2A-compatible platform. An external distributor's agent can find and call Velora's Payments Agent with zero pre-registration." |
| **1:28–1:40** | Return to the architecture diagram. Animate or outline: Supervisor → A2A call → Payments → MercadoPago; Supervisor → A2A call → Fiscal → ARCA; Vertex Agent Engine → MCP → same 51 tools. Then cut to Velora logo on a clean background. | "One interoperability layer. Three A2A translator agents. Fifty-one MCP tools reused across every engine. Velora — built 100% on Google Cloud, ready for the Marketplace." |

**Total: ≈130 seconds.** Well within the 180-second contest limit.

---

## What Carlos needs to screen-record (in order)

1. **`somosvelora.com` landing** — 3 seconds, scrolled to the top.
2. **Architecture diagram slide** — a clean PNG or PDF of `docs/ARCHITECTURE.md`'s Mermaid diagram exported as an image. Hold for ~5 seconds. This is your only slide.
3. **Owner chat → payment link** — log in as owner, type the payment link request, show the MP card response. Have the sandbox product and customer pre-seeded.
4. **Cloud Logging tab** — open GCP Console → Logging → filter `jsonPayload.event="ADK_A2A_PAYMENTS_CALL"` and show one real entry. Blur or replace any real resource IDs with `[project-id]`.
5. **Invoice auto-trigger + WhatsApp receipt** — either simulate the MP webhook confirmation or show the chat auto-response. Show the "Factura emitida" message. Show the WhatsApp receipt screenshot (or the Meta Cloud API delivery log).
6. **Vertex Agent Engine semantic query** — open a terminal or Colab notebook, run the natural-language query against the Agent Engine endpoint, show the `query_catalog` MCP tool being called and returning "Mochila Urban 25L". This is the **killer shot** — give it 10–12 seconds.
7. **MCP server source header** — open `src/lib/mcp/server.ts` in VS Code, zoom in on lines 1–6 showing "14 tool packs, 51 tools". Then cut to a quick terminal showing `register_sale` returning success JSON.
8. **Agent card in browser** — navigate to `[your-domain]/api/agents/payments/agent-card`, show the JSON with `protocolVersion: "0.3.0"`. Blur any real IDs.
9. **Architecture diagram again + Velora logo** — close out with the same diagram and a clean logo frame.

---

## On-screen callout rules

Every sandbox or mock beat must have a text callout in the bottom-left corner (white label, dark background, 14px minimum):

- Beats 3 & 5: **"MercadoPago Sandbox — no real transactions"**
- Beat 5 (invoice): **"ARCA Sandbox — no real AFIP registration"**
- Beat 6 (semantic search): **"Vertex AI Search — USE_VERTEX_SEARCH flag enabled for this demo"**

---

## Editing notes

- Cut pauses ruthlessly. Every beat should start with action already in progress, not waiting for a page to load.
- English subtitles burned in or SRT — the judge audience is English-speaking; Spanish UI text does not need translation.
- The Cloud Logging beat (beat 4) is optional if it pushes you past 110 seconds — but it is the strongest technical-proof moment; keep it if at all possible.
- Do not show or imply live ARCA invoices (AFIP registration) — sandbox only.
- Do not show real Andreani tracking numbers — mock mode generates synthetic ones.
- Do not claim MercadoPago production payments — sandbox credentials only.
- No background music that competes with narration. Subtle ambient is fine under logo outro.

---

## What NOT to claim

- Do not state that Vertex AI Search is live in production (it is feature-flagged; enable it for the demo recording only).
- Do not show real resource IDs or project IDs — blur or replace with `[project-id]` in post.
- Do not claim WhatsApp Business API is the only path — the demo uses the Meta Cloud API path; the Twilio sandbox fallback exists but is not the demo path.
