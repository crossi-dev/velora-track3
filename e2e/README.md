# Velora — E2E Tests (Puppeteer + Jest)

Smoke + protocol tests contra el deploy live en Cloud Run.

## Run

```bash
# Default: targets Cloud Run prod
npm run test:e2e

# Custom URL (local dev, staging)
BASE_URL=http://localhost:3000 npm run test:e2e
```

## Scope (qué cubrimos)

✅ **Páginas públicas** — landing, employee-login, /api/health, /api/public/vapid-key
✅ **Protocolo A2A** — agent card declara skills + contracts + event types correctos
❌ **Flujos autenticados** — NO se cubren. Google OAuth detecta automation y bloquea (ver TODO abajo)

## TODO post-demo: Auth state reuse

Para tests de flujos autenticados (owner crea empleado, sube Excel, etc.):

1. Login manual una vez via Chrome con `npx playwright codegen` o navegador real.
2. Guardar storage state (cookies + localStorage) en `e2e/.auth/owner.json` (gitignored).
3. En tests: `await page.setCookie(...stateData.cookies)` + `await page.evaluate(state => localStorage.setItem(...))`.
4. Targets el deployed URL con sesión válida → Velora cree que es el owner.

Limitación: la sesión NextAuth tiene TTL (~30 días). Hay que rotar el state JSON cuando expira.

## Diseño

- **Stack:** Puppeteer 24 + Jest 30 + jest-puppeteer 11. Puppeteer es Chrome-only (mantenido por Google) — narrativa coherente con Track 3.
- **Fixtures:** ninguna; cada test arranca con browser fresh via jest-puppeteer.
- **Headless:** `headless: "new"` (modo headless moderno de Chromium).
- **No mocks:** target el deployed URL real, no localhost. Asegura que lo que el jurado ve es lo que tests verifican.

## Cuándo correr

- Localmente antes de cada deploy: `npm run test:e2e`
- En CI (Cloud Build): TODO — agregarlo a `cloudbuild.yaml` post-demo.
- Pre-pitch: correr y guardar screenshot del output para mostrar al jurado.
