# Velora Demo Video Automation

## Overview

Automated pipeline to generate the Google AI Agents Challenge 2026 demo video.
Produces a ~2:03 MP4 at 1920x1080 H.264/AAC with Spanish voiceover.

## Quick regeneration (v3.3)

```bash
# Full pipeline (seed + record + voiceover + compose)
node scripts/_seed-demo-owner.mjs --wipe
node scripts/_generate-voiceover.mjs
node scripts/_record-demo-video.mjs --skip-seed
node scripts/_compose-demo-video.mjs
```

Output: `C:\Users\Latitude\Desktop\demo-velora-v3.3.mp4`
Build artifacts: `C:\Users\Latitude\AppData\Local\Temp\demo-velora-build\`

## v3.3 Storyboard

| Segment | Time | Duration | Content | Voiceover file |
|---------|------|----------|---------|---------------|
| Login | 0:00 | 3s | Signin → cookie inject → dashboard | `00-login.mp3` |
| Onboarding | 0:03 | 30s | "Maxi Kiosco", 8 turns, 35ms/char, 1.5s inter-turn | `01-onboarding.mp3` |
| Venta + QR + Comprobante | 0:33 | 40s | Sale (3 cajas × 1600 = 4800), QR, PDF preview + zoompan | `02-venta.mp3` |
| MercadoLibre | 1:13 | 20s | Black placeholder — Carlos records Monday with ML sandbox | `03-mercadolibre.mp3` |
| Andreani | 1:33 | 25s | Context + quote (3 cotizaciones) + Domicilio order | `04-andreani.mp3` |
| Closing | 1:58 | 5s | Logo + "Tu gerente AI" + somosvelora.com | `05-cierre.mp3` |

**Total: 2:03**

## Prerequisites before recording

1. Cloud Build must be SUCCESS and the latest Cloud Run revision active:
   ```bash
   gcloud builds list --limit=3 --project=my-gcp-project
   gcloud run services describe velora --region=southamerica-east1 --project=my-gcp-project --format="value(status.latestReadyRevisionName)"
   ```

2. Cloud Run env vars required:
   - `ML_MOCK_MODE=true`
   - `ANDREANI_MOCK_MODE=true`
   - `MP_REAL_QR_ENABLED=true` (already set)

3. Smoke check:
   ```bash
   curl -s https://somosvelora.com/api/health | python -m json.tool
   ```

## Scripts

### `scripts/_seed-demo-owner.mjs`

Creates a blank demo account in the production DB (disposable pre-demo per project policy):

- Creates `User` with email `demo-video@velora.test`
- Creates `Business` in blank onboarding state
- Seeds `MpConnection` placeholder (QR gate passes)
- Seeds `TrustedPeerAgent` for Distribuidora Mendoza
- Mints owner session cookie → `scripts/.demo-cookie.txt`

```bash
node scripts/_seed-demo-owner.mjs --wipe
```

### `scripts/_generate-voiceover.mjs`

Calls Google Cloud Text-to-Speech API (Studio-B) to generate 6 MP3 segments.

| File | Text | Rate |
|------|------|------|
| `00-login.mp3` | "Carlos. Primera vez en Velora." | 0.95 |
| `01-onboarding.mp3` | "Negocio armado. Por chat. En 30 segundos." | 0.95 |
| `02-venta.mp3` | "Una venta. Velora cobra. Comprobante por WhatsApp. Factura en ARCA." | 0.95 |
| `03-mercadolibre.mp3` | "Su catálogo del local. También en MercadoLibre." | 0.95 |
| `04-andreani.mp3` | "Juan vive lejos. Velora cotiza. Cinco agentes. Mercado Pago. ARCA. MercadoLibre. Andreani. WhatsApp. Solos." | 0.95 |
| `05-cierre.mp3` | "Velora. Tu gerente AI. Hecho en Argentina." | 0.95 |

Voice: `es-US-Studio-B` (Studio tier male, chosen by Carlos v3.3).
Pause strategy: dots and punctuation — no SSML (Studio-B handles naturally).
Fallback if Studio quota exhausted: `--voice es-US-Neural2-B`

### `scripts/_record-demo-video.mjs`

Playwright Chromium headless at 1280x960. v3.3 flow:

1. Seeds demo account (or skips with `--skip-seed`)
2. Navigates to `/api/auth/signin` — 3s hold (was 8s)
3. Injects cookie → dashboard
4. **Onboarding** (8 turns, business "Maxi Kiosco"):
   - charDelay: 35ms/char (was 30ms)
   - interTurnPause: 1500ms after each Velora reply
   - NO jumpcuts — real typing speed
5. **Venta**: "vendí 3 cajas de alfajor a Juan" → bubbles (A2A: Vertex Search + Fiscal + ML stock)
6. **Cobro QR**: "cobro QR 4800" (3×1600) → QR renders → 5s hold
7. **Comprobante**: "mandale el comprobante" → WhatsApp bubble + PDF preview → 1.8s hold
8. **ML section**: NO commands recorded — 5s pause only (compositor inserts black slot)
9. **Andreani context**: "Juan vive en Godoy Cruz CP 1043"
10. **Andreani quote**: "cuánto sale enviar 3 cajas a CP 1043" → 3 cotizaciones visible
11. **Andreani order**: "Domicilio" → order created → bubble Andreani Agent

Key details:
- `charDelay: 35ms` — natural typing speed
- `interTurnPause: 1500ms` — breath between turns
- `bubblePause: 2500ms` on critical commands

### `scripts/_compose-demo-video.mjs`

ffmpeg compositor (v3.3):

1. Cuts `demo-raw.webm` into 4 segments (login, onboarding, venta, andreani) using storyboard timestamps
2. Applies **PDF zoompan** to venta segment: `z='if(lte(zoom,1.0),0.9+0.1*(on/6),1.0+0.0006*on)'` — pop-in 0.9→1.0 in 6 frames (~200ms @ 30fps), then continuous drift 1.0→1.03
3. Generates **20s ML placeholder** (black + white text "ML real — grabado el lunes")
4. Generates **5s closing slide** (terracota Velora logo + tagline + somosvelora.com)
5. Prepares audio: pads/trims each voiceover to segment duration
6. Muxes video + audio per segment
7. Concatenates 6 segments
8. Adds **section captions** (TOP screen, terracota `#B85C3E`, Inter Bold 32px, semi-transparent bg, 1.2s flash at each section boundary)
9. Adds **0.5s fade in/out** (no long fades — cut style)
10. Outputs `demo-velora-v3.3.mp4` → Desktop

## Known issues and gaps for v3.4

### ML section is a placeholder

The real ML recording goes here. Carlos records Monday with ML sandbox enabled.
To insert: replace `segments/ml-placeholder.mp4` with the real ML recording and re-run composer with `--skip-record`.

### zoompan timing is estimated

The PDF comprobante pop-in zoompan is applied to the entire venta segment. The 0.9→1.0 pop-in
runs over the first 6 frames of the segment, not specifically when the PDF appears.
For v3.4: use `-ss` to seek to the exact frame where the PDF renders and apply zoompan
only to that sub-clip, then concatenate with the rest of the venta segment.

### Storyboard timestamps (update after first run)

After recording, check `dbg-*.png` screenshots and update the `segs` object in
`_compose-demo-video.mjs` with actual timestamps from the raw webm.

| Segment | Expected start (s) | Expected end (s) |
|---------|-------------------|-----------------|
| login | 0 | 5 |
| onboarding | 5 | 55 |
| venta_qr | 55 | 120 |
| andreani | 125 | 165 |

## v3 → v3.3 changelog

| Feature | v3 | v3.3 |
|---------|----|------|
| Voice | Chirp3-HD-Alnilam | Studio-B |
| Speaking rate | varies 0.95–1.05 | 0.95 uniform |
| Business name | "Pipo gomeria" | "Maxi Kiosco" |
| Venta command | "vendí 2 alfajor a Juan" | "vendí 3 cajas de alfajor a Juan" |
| QR amount | 1600 | 4800 (3×1600) |
| Comprobante | "mandale el comprobante a Juan" | "mandale el comprobante" |
| charDelay | 30ms | 35ms |
| Inter-turn pause | none | 1.5s |
| Login hold | 4s + 4s | 3s |
| ML section | Recorded commands | 20s black placeholder |
| Andreani context turn | none | "Juan vive en Godoy Cruz CP 1043" |
| Andreani quote | "cuánto sale enviar a Godoy Cruz CP 1043" | "cuánto sale enviar 3 cajas a CP 1043" |
| PDF zoompan | none | 0.9→1.0 pop + 1.0→1.03 drift |
| Closing slide | 15s | 5s |
| Caption style | bottom, white | TOP, terracota #B85C3E, semi-transparent bg |
| Total duration | ~2:55 | ~2:03 |
| Output filename | `demo-velora-v3.mp4` | `demo-velora-v3.3.mp4` |

## Environment requirements

- `gcloud` CLI authenticated (`gcloud auth login`)
- Project: `my-gcp-project`
- Secrets in Secret Manager: `AUTH_SECRET`, `DATABASE_URL`
- Node.js 22+
- Playwright installed in project (`node_modules/playwright`)
- ffmpeg-static at `C:\...\Temp\demo-velora-build\node_modules\ffmpeg-static\ffmpeg.exe`
  (install once: `cd C:\...\Temp\demo-velora-build && npm install ffmpeg-static`)
- `ML_MOCK_MODE=true` and `ANDREANI_MOCK_MODE=true` in Cloud Run
- `MP_REAL_QR_ENABLED=true` in Cloud Run
