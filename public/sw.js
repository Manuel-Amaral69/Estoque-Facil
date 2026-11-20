const CACHE_NAME = "estoque-facil-v1";
const APP_SHELL = [
  "/Login/login.html",
  "/Login/login.css",
  "/Login/login.js",
  "/Estoque/estoque.html",
  "/Estoque/estoque.css",
  "/Estoque/estoque.js",
  "/Estoque/historico.html",
  "/Estoque/historico.css",
  "/Estoque/historico.js",
  "/vendor/html5-qrcode/html5-qrcode.min.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/pwa.js"
];

// Prepara os arquivos da interface para que as telas abram sem rede.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// Usa cache para arquivos locais e a rede como primeira opção para navegações.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      }).catch(async () => (await caches.match(request)) || caches.match("/Login/login.html"))
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});

// Exibe os alertas enviados pelo servidor mesmo com o app fechado.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() || "Verifique o estoque." };
  }

  event.waitUntil(self.registration.showNotification(data.title || "Estoque Fácil", {
    body: data.body || "Há uma atualização no seu estoque.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: data.tag || "estoque-alerta",
    renotify: false,
    data: { url: data.url || "/Estoque/estoque.html" }
  }));
});

// Abre ou foca a tela de estoque ao tocar em uma notificação.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/Estoque/estoque.html", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      existing.navigate(target);
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});