# Velora MercadoLibre Agent

A2A v0.3.0 agent that bridges Velora (the offline platform) with the MercadoLibre marketplace.
The company operator runs their physical store through Velora and sells on ML — this agent keeps both in sync.

## Architecture

```
Velora Supervisor (A2A)
  └── MercadoLibre Agent
        ├── catalog.sync     → POST /items (create/update ML listings)
        ├── order.receive    → GET /orders/{id} → mapped to register_sale
        ├── stock.update     → PUT /items/{id} available_quantity
        └── pricing.sync     → PUT /items/{id} price

ML Webhooks ──► POST /api/agents/mercadolibre/webhook → order.receive
```

## Files

```
src/app/api/agents/mercadolibre/
  ├── agent-card/route.ts          GET  — A2A AgentCard (public)
  ├── jsonrpc/route.ts             POST — JSON-RPC 2.0 handler
  ├── jwks/route.ts                GET  — Ed25519 public key
  ├── webhook/route.ts             POST — ML order notifications
  ├── oauth/authorize/route.ts     GET  — start ML OAuth flow
  ├── oauth/callback/route.ts      GET  — exchange code, save MlCredential
  └── _lib/
      ├── handle-ml-rpc.ts         JSON-RPC dispatcher
      ├── ml-api-client.ts         ML REST wrapper (auth + 429 backoff)
      ├── ml-oauth.ts              OAuth token exchange + refresh
      ├── catalog-sync.ts          skill: catalog.sync
      ├── order-receive.ts         skill: order.receive
      ├── stock-update.ts          skill: stock.update
      ├── pricing-sync.ts          skill: pricing.sync
      └── ml-mock.ts               mock data for demo mode
```

## Skills

### `catalog.sync`
Pushes Velora products to MercadoLibre as active listings.

**Input** (JSON-RPC params):
```json
{
  "skill": "catalog.sync",
  "businessId": "cld_xxx",
  "productIds": ["prod-1", "prod-2"]  // optional — omit to sync all
}
```

**Output**: `{ synced, errors, results[] }` with per-product status.

**Notes**:
- Category is hardcoded to `MLA1055` (Otros) — update per business type post-demo.
- A product with price <= 0 is skipped.
- Requires `MlCredential` for the business.

### `order.receive`
Fetches an ML order and maps it to a Velora `register_sale` payload.

**Input**:
```json
{ "skill": "order.receive", "businessId": "cld_xxx", "mlOrderId": "2000003456789012" }
```

**Output**: `{ mlOrderId, status, salePayload }` — salePayload is ready to forward to the Supervisor.

### `stock.update`
Pushes a new stock quantity for a known ML listing.

**Input**:
```json
{ "skill": "stock.update", "businessId": "cld_xxx", "mlItemId": "MLA123456789", "newStock": 5, "productId": "prod-1" }
```

### `pricing.sync`
Propagates a price change from Velora to ML.

**Input**:
```json
{ "skill": "pricing.sync", "businessId": "cld_xxx", "mlItemId": "MLA123456789", "newPrice": 45000, "productId": "prod-1" }
```

## Mock Mode

Set `ML_MOCK_MODE=true` in Cloud Run to run the full demo flow without real ML credentials.

- `catalog.sync` → returns 5 synthetic products created/updated
- `order.receive` → returns a 2-item order from "Juan Pérez" ($20,500 ARS)
- `stock.update` / `pricing.sync` → return `status: "updated"`
- Webhook → logs mock order.receive, acks 200

Safe to enable for the Google AI Agents Challenge video demo.

## Discovery

AgentCard available at:
- `GET /api/agents/mercadolibre/agent-card`
- `GET /.well-known/mercadolibre-agent-card.json`
- Listed in `GET /.well-known/agents.json`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ML_CLIENT_ID` | Yes (real mode) | ML developer app client ID |
| `ML_CLIENT_SECRET` | Yes (real mode) | ML developer app client secret |
| `ML_WEBHOOK_SECRET` | Recommended | HMAC secret for webhook signature validation |
| `ML_MOCK_MODE` | Demo only | Set `true` to bypass real ML API |
| `AGENT_IDENTITY_KEY_MERCADOLIBRE` | Recommended | Ed25519 private key PEM for X-Agent-Assertion JWTs |

## Activation Steps (real ML account)

1. **Create ML developer app**: https://developers.mercadolibre.com.ar/
   - Set redirect URI: `https://somosvelora.com/api/agents/mercadolibre/oauth/callback`
   - Enable scopes: `read`, `write`, `offline_access`

2. **Upload secrets to GCP Secret Manager**:
   ```bash
   printf '%s' '<ML_CLIENT_ID>' | gcloud secrets create ML_CLIENT_ID --data-file=-
   printf '%s' '<ML_CLIENT_SECRET>' | gcloud secrets create ML_CLIENT_SECRET --data-file=-
   printf '%s' '<ML_WEBHOOK_SECRET>' | gcloud secrets create ML_WEBHOOK_SECRET --data-file=-
   ```

3. **Generate Ed25519 identity key**:
   ```bash
   node scripts/generate-agent-identity-keys.mjs
   # Copy the "mercadolibre" private key PEM and upload:
   printf '%s' '<PEM_BLOCK>' | gcloud secrets create AGENT_IDENTITY_KEY_MERCADOLIBRE --data-file=-
   ```

4. **Update Cloud Run**:
   ```bash
   gcloud run services update velora \
     --update-secrets ML_CLIENT_ID=ML_CLIENT_ID:latest \
     --update-secrets ML_CLIENT_SECRET=ML_CLIENT_SECRET:latest \
     --update-secrets ML_WEBHOOK_SECRET=ML_WEBHOOK_SECRET:latest \
     --update-secrets AGENT_IDENTITY_KEY_MERCADOLIBRE=AGENT_IDENTITY_KEY_MERCADOLIBRE:latest
   ```

5. **Run DB migration**:
   ```bash
   npx prisma migrate deploy
   ```
   (Applies `20260514120000_add_ml_credential` — creates `MlCredential` table.)

6. **Owner connects their ML account**: Navigate to `https://somosvelora.com/api/agents/mercadolibre/oauth/authorize` while logged in as owner. After granting access, credentials are stored in `MlCredential`.

7. **Configure ML webhook**: In the ML developer panel, set the notification URL to `https://somosvelora.com/api/agents/mercadolibre/webhook` for topic `orders`.

## A2A Call Example (via Supervisor)

```json
POST /api/agents/mercadolibre/jsonrpc
Headers:
  X-API-Key: <A2A_SECRET>
  X-Agent-Assertion: <JWT signed by supervisor>
  Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "skill": "catalog.sync",
    "businessId": "cld_xxx"
  }
}
```
