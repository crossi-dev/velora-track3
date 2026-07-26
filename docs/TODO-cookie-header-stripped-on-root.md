# Cookie header is stripped on real browser requests to "/" — root cause not found

Confirmed live (2026-07-26) via a temporary server-side diagnostic log in
`src/app/(landing)/page.tsx` (added, tested, removed same day — see commit
`043d9f1`): a real browser's top-level navigation to `https://somosvelora.com/`
arrives at the Next.js origin with **no Cookie header at all**
(`rawCookiePresent: false`), even though `document.cookie` on the client
correctly shows the cookie set. A `curl -H "Cookie: ..."` request to the same
URL appeared to work, but that was a false positive — curl sends no
`Accept-Language` header, so `pickLocale()` was hitting its `es-AR` default,
not actually receiving the forwarded cookie either.

## Impact

The landing page's `NEXT_LOCALE` cookie mechanism was fixed around this
(locale is now client-side React state instead of depending on the cookie
reaching the server — see `LanguageSwitcher.tsx`). But **this is a general
finding, not locale-specific**: any other logic that expects to read a cookie
on a fresh request to `/` would hit the same wall. Worth checking:

- Does the owner's NextAuth session cookie survive a real navigation to `/`
  (not `/dashboard`, which wasn't tested in this investigation)? If not,
  first-visit-after-login behavior on the root route could be affected.
- Any other cookie-gated logic added to `(landing)/page.tsx` or similar
  root-level routes in the future should NOT assume the cookie reliably
  arrives — verify live before shipping, given this precedent.

## Likely cause, not confirmed

Firebase Hosting's CDN (Fastly-based — `X-Served-By: cache-eze2230075-EZE`
seen in response headers) sits in front of Cloud Run. No `firebase.json` is
committed to this repo (hosting config was applied from elsewhere), so the
exact rewrite/header config isn't inspectable here. Matches the same class of
bug documented previously for `tools.somosvelora.com` (Firebase Hosting
stripped the `Host` header on that rewrite; middleware needed
`X-Forwarded-Host` to compensate) — plausible this is the same layer
mishandling `Cookie` for some request shapes.

## Not investigated further here

Fixing the actual CDN/hosting-layer behavior needs either access to the
Firebase Hosting config (wherever it's actually managed) or a committed
`firebase.json` with explicit header-passthrough rules — out of scope for an
autonomous session without that access. The client-state workaround in
`LanguageSwitcher.tsx` sidesteps the symptom for locale switching; it does
not fix the underlying stripping behavior.
