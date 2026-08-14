/* Service worker de l'Agenda Anime.
 *
 * Role volontairement limite : rendre la coque de l'app disponible hors ligne.
 * Les donnees (planning, fiches) sont deja mises en cache dans IndexedDB par
 * l'application elle-meme, avec des TTL et un repli sur version perimee — le SW
 * n'a donc pas a s'en meler, et on evite le piege classique du planning servi
 * indefiniment depuis un cache HTTP.
 */

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const IMAGE_CACHE = `images-${VERSION}`;

/** Pages a precharger : les trois onglets doivent s'ouvrir hors ligne. */
const SHELL_ROUTES = ['/', '/bibliotheque/', '/import/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll echoue en bloc si une seule requete echoue : on tolere les trous.
      await Promise.all(
        SHELL_ROUTES.map((route) =>
          cache.add(new Request(route, { cache: 'reload' })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE, IMAGE_CACHE]);
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

/** Limite la taille d'un cache en supprimant les entrees les plus anciennes. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // --- Navigation : reseau d'abord, coque en cache si hors ligne ---
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          const cached = await caches.match(request, { ignoreSearch: true });
          if (cached) return cached;
          // Repli sur la racine : mieux vaut l'agenda qu'une page d'erreur.
          const root = await caches.match('/');
          if (root) return root;
          return new Response('Hors ligne', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // --- Bundles Next : immuables, cache d'abord ---
  if (url.origin === self.location.origin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        const cache = await caches.open(ASSET_CACHE);
        cache.put(request, fresh.clone()).catch(() => {});
        return fresh;
      })()
    );
    return;
  }

  // --- Jaquettes distantes : cache d'abord, plafonne ---
  if (request.destination === 'image' && url.origin !== self.location.origin) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          if (fresh.ok || fresh.type === 'opaque') {
            const cache = await caches.open(IMAGE_CACHE);
            await cache.put(request, fresh.clone()).catch(() => {});
            void trimCache(IMAGE_CACHE, 300);
          }
          return fresh;
        } catch {
          // Pas de jaquette hors ligne : l'UI a un placeholder.
          return new Response('', { status: 504 });
        }
      })()
    );
    return;
  }

  // --- Icones et autres fichiers statiques du site ---
  if (url.origin === self.location.origin && /\.(png|svg|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(ASSET_CACHE);
          cache.put(request, fresh.clone()).catch(() => {});
          return fresh;
        } catch {
          return new Response('', { status: 504 });
        }
      })()
    );
    return;
  }

  // Tout le reste (AniList, ADN, TMDB) passe directement au reseau :
  // le cache de donnees est gere en IndexedDB cote application.
});
