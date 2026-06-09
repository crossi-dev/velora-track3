export function GET() {
  const buildTime = process.env.BUILD_TIME ?? "v1";
  const cacheKey = `velora-${buildTime.replace(/\W/g, "")}`;

  const body = `const CACHE = ${JSON.stringify(cacheKey)};
const PRECACHE = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE.filter((url) => {
        try { new URL(url, self.location.origin); return true; } catch { return false; }
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => {
        // After claiming all clients, FORCE every controlled page to reload so
        // it picks up the new JS bundle under this SW's cache key. Previously
        // we only postMessage'd "SW_UPDATED" and relied on the client to listen
        // — but if the cached client bundle is so stale it lacks that listener,
        // the page never reloads and keeps running the old JS forever. Direct
        // client.navigate(client.url) does not require any client cooperation.
        return self.clients.matchAll({ type: "window" }).then((clients) => {
          return Promise.all(clients.map((client) => {
            if ("navigate" in client) {
              return client.navigate(client.url).catch(() => {});
            }
            client.postMessage({ type: "SW_UPDATED" });
            return undefined;
          }));
        });
      })
  );
});

self.addEventListener("push", (e) => {
  if (!e.data) return;
  let payload;
  try { payload = e.data.json(); } catch { return; }

  const title = payload.title || "Velora";
  const category = payload.notificationCategory || "default";
  const entityId = payload.entityId || "";

  // Namespaced tag so different notification types don't collapse each other.
  // daily_summary already carries YYYYMMDD as entityId from the backend so it
  // collapses per-day correctly without special casing here.
  const tag = entityId ? category + "-" + entityId : category;

  e.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-72.png",
      tag,
      renotify: true,
      data: { url: payload.url || "/dashboard" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  // Append openTab so DashboardPage selects the chat tab at mount — fixes
  // the cold-start race where SW postMessage arrives before the page mounts.
  const rawUrl = (e.notification.data && e.notification.data.url) || "/dashboard";
  const safeUrl = typeof rawUrl === "string" && rawUrl.startsWith("/") ? rawUrl : "/dashboard";
  const targetUrl = safeUrl.includes("?")
    ? safeUrl + "&openTab=main&from=push"
    : safeUrl + "?openTab=main&from=push";

  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: false })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url && "focus" in client) {
            // navigate() returns Promise<WindowClient | null>; focus the returned
            // client (not the stale pre-navigate reference) per MDN spec.
            return client.navigate(targetUrl).then((wc) => wc && wc.focus()).catch(() => {
              if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
            });
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
        return null;
      })
      .catch(() => {
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      })
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = e.request.url;
  if (!url.startsWith("http")) return;
  if (e.request.headers.get("Authorization")) return;

  const { pathname } = new URL(url);

  if (pathname.startsWith("/api/")) return;

  if (pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(
          "<!doctype html><html lang=\\"es-AR\\"><head><meta charset=\\"utf-8\\"><meta name=\\"viewport\\" content=\\"width=device-width,initial-scale=1,viewport-fit=cover\\"><title>Sin conexi\\u00f3n \\u2014 Velora</title><style>*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;background:#FAF6EE;color:#1B3A6B;font-family:system-ui,sans-serif}body{display:flex;align-items:center;justify-content:center;min-height:100dvh;padding:1.5rem;text-align:center}.card{max-width:22rem;width:100%}.logo{font-family:Georgia,Cambria,serif;font-size:2.25rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:1.5rem}.title{font-size:1.25rem;font-weight:600;margin-bottom:0.5rem}.sub{font-size:1rem;opacity:0.7;margin-bottom:2rem;line-height:1.5}button{background:#1B3A6B;color:#FAF6EE;border:none;border-radius:0.75rem;padding:0.75rem 2rem;font-size:1rem;font-weight:600;cursor:pointer;width:100%}button:active{opacity:0.85}</style></head><body><div class=\\"card\\"><p class=\\"logo\\">Velora</p><p class=\\"title\\">Sin conexi\\u00f3n</p><p class=\\"sub\\">Volvemos cuando tengas se\\u00f1al.</p><button onclick=\\"window.location.reload()\\">Reintentar</button></div></body></html>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
        )
      )
    );
    return;
  }

  const isStaticLike =
    pathname.match(/\\.(png|jpg|jpeg|svg|gif|webp|ico|woff2?|ttf|otf)$/) !== null;

  if (isStaticLike) {
    e.respondWith(
      caches.match(e.request).then((cached) => {
        if (cached) return cached;
        return fetch(e.request).then((res) => {
          if (res.ok && res.type !== "opaque") {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
  }
});
`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}
