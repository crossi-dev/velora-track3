# Velora — Demo Video Script
## Google for Startups AI Agents Challenge — Track 3

**Target duration**: 90–120 seconds  
**Language**: Spanish Argentine narration with English subtitle notes  
**Format**: Screen recording (PWA on desktop + Android APK) with voice-over

---

## Before you record

- Log in as the owner via Google OAuth (`somosvelora.com`)
- Have one product in the catalog (e.g. "Alfajor Havanna") and one customer (e.g. "Carla López") pre-seeded
- MercadoPago sandbox credentials active (`MP_DIRECT_ACCESS_TOKEN` set)
- Fiscal agent: ARCA sandbox (no real invoice will be issued)
- Andreani: `ANDREANI_MOCK_MODE=true` — shipment responses are synthetic; state this on screen
- WhatsApp: Twilio sandbox — receipt will go to the registered sandbox number

---

## Beat-by-beat storyboard

### Beat 1 — Hook (0:00–0:12)

**Screen**: Chat UI, empty state with Velora's greeting  
**Narration (ES-AR)**:
> "Las empresas coordinan con docenas de sistemas. Pagos, impuestos, logística, marketplace — cada uno habla un idioma distinto. Velora es el traductor."

**Subtitle note**: "Companies coordinate with dozens of systems. Payments, tax, logistics, marketplace — each speaks a different language. Velora is the translator."

**What to show**: Velora's landing screen + the agent-card endpoint in a browser tab (`/api/agents/payments/agent-card`) to establish that the agents are real, discoverable endpoints.

---

### Beat 2 — Employee records a sale (0:12–0:30)

**Screen**: Switch to employee PIN login → chat  
**Narration (ES-AR)**:
> "El empleado opera desde el chat, sin apps extra. Registra una venta en lenguaje natural."

**Subtitle note**: "The employee runs daily ops from the chat — no extra apps. Records a sale in natural language."

**Action**: Employee types: `"Vendé 2 alfajores Havanna a Carla"`

**What to show**:
- The chat responds in <200 ms (Deterministic Fast Path — no LLM call)
- Response includes a confirmation card with product, quantity, customer, and total
- Employee taps "Confirmar"
- Sale is registered; inventory decrements

**Honest framing**: Fast Path hit — this path uses regex + catalog lookup, no LLM. Callout on screen: "Fast Path — <200 ms, no LLM".

---

### Beat 3 — Owner asks for QR payment (0:30–0:55)

**Screen**: Switch to owner chat (Gemini 2.5 Pro / Supervisor)  
**Narration (ES-AR)**:
> "El dueño quiere cobrar esa venta con QR de Mercado Pago. El Supervisor delega al agente de Ventas."

**Subtitle note**: "The owner wants to charge via MercadoPago QR. The Supervisor delegates to the Ventas agent."

**Action**: Owner types: `"Cobrá la venta de Carla con QR"`

**What to show** (in sequence):
1. Chat shows a brief "thinking" indicator (Gemini 2.5 Pro processing)
2. Supervisor invokes `call_ventas_agent` → real HTTP A2A JSON-RPC call to `/api/agents/payments/jsonrpc`
3. Payments agent calls MercadoPago sandbox → returns QR code
4. QR card appears in the chat (rendered inline)
5. Cloud Logging callout: `ADK_A2A_VENTAS_CALL` log entry visible (optional, if screen space allows)

**Honest framing**: MercadoPago sandbox — no real money moves. Callout: "MercadoPago Sandbox".

---

### Beat 4 — Fiscal agent: invoice on confirmation (0:55–1:10)

**Screen**: Same owner chat, continuing the flow  
**Narration (ES-AR)**:
> "Una vez confirmado el pago, el Supervisor delega al agente Contador, que emite el comprobante fiscal contra ARCA."

**Subtitle note**: "Once the payment is confirmed, the Supervisor delegates to the Contador agent, which emits the fiscal invoice against ARCA."

**What to show**:
- MercadoPago webhook arrives (simulated in sandbox) → payment confirmed
- Supervisor auto-invokes `call_contador_agent` → A2A call to `/api/agents/fiscal/jsonrpc`
- Chat shows: "Comprobante emitido — Factura #0001-00000042"
- WhatsApp receipt sent to customer (Twilio sandbox)

**Honest framing**: ARCA sandbox — no real invoice registered with AFIP. Callout: "ARCA Sandbox — no real invoice".

---

### Beat 5 — Architecture reveal (1:10–1:25)

**Screen**: Split or overlay — ASCII architecture diagram from `docs/ARCHITECTURE.md`  
**Narration (ES-AR)**:
> "Todo eso son agentes hablando entre sí sobre A2A v0.3.0: identidad criptográfica Ed25519, JSON-RPC firmado, descubrimiento estándar. Cada agente traduce un sistema externo al mismo protocolo."

**Subtitle note**: "All of that is agents talking to each other over A2A v0.3.0: Ed25519 cryptographic identity, signed JSON-RPC, standard discovery. Each agent translates an external system into the same protocol."

**What to show**: Highlight the two-layer topology:
- Role-agent FunctionTools inside the Supervisor (call_contador / call_ventas / call_logistica / call_marketplace)
- The four translator agents (Payments, Fiscal, MercadoLibre, Andreani) as A2A v0.3.0 endpoints
- A live curl to `GET /api/agents/payments/agent-card` returning the agent card JSON

---

### Beat 6 — Logistics agent (mock mode) (1:25–1:40) *(include if under 120 s)*

**Screen**: Owner chat  
**Narration (ES-AR)**:
> "El agente de Logística, con Andreani, cotiza y crea envíos desde el mismo chat. Hoy corre en modo mock — la integración real sólo necesita las credenciales del cliente."

**Subtitle note**: "The Logistics agent, with Andreani, quotes and creates shipments from the same chat. Today it runs in mock mode — the real integration only needs per-client credentials."

**Action**: Owner types: `"Cotizá envío de la venta de Carla a CP 1425"`

**What to show**:
- Supervisor invokes `call_logistica_agent` → A2A call to `/api/agents/andreani/jsonrpc`
- Three shipment options returned (sucursal / domicilio / express) with ARS prices and estimated days
- Callout on screen: "ANDREANI_MOCK_MODE=true — Andreani sandbox"

---

### Beat 7 — Close (1:40–1:55) *(or earlier if skipping Beat 6)*

**Screen**: Back to empty owner chat, Velora logo  
**Narration (ES-AR)**:
> "Una empresa, cuatro agentes especializados, el mismo chat. Velora — la capa de interoperabilidad A2A para LATAM."

**Subtitle note**: "One company, four specialist agents, one chat. Velora — the A2A interoperability layer for LATAM."

**What to show**: Velora chat UI, calm. Optionally show the Android APK on a physical device running the same flow.

---

## Editing notes

- Keep each beat tight — cut pauses ruthlessly to stay under 120 s.
- Show the `ADK_A2A_*` Cloud Log entry at least once to demonstrate the real HTTP A2A delegation (not an in-process mock call).
- Every sandbox / mock beat must have an on-screen text callout (white label, bottom-left). No implicit claims of live production connections.
- Subtitles: English, burned-in or SRT — judge audience is English-speaking.
- No background music that conflicts with narration.

---

## What NOT to claim

- Do not show or imply live ARCA invoices (AFIP registration) — sandbox only.
- Do not show real Andreani tracking numbers — mock mode generates synthetic ones.
- Do not claim MercadoPago production payments during judging — sandbox credentials only.
- Do not claim WhatsApp Business Cloud API — Twilio sandbox is what ships today.
