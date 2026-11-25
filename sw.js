/**
 * =============================================================================
 * 川畑水産 洋上PWA サービスワーカー (sw.js)
 * @version 2.1.0
 * @lastModified 2026-11-25 07:20:00 JST
 * @note 圏外対応・洋上キャッシュ戦略 (Network First with Cache Fallback for navigation, Stale-While-Revalidate for assets)
 * =============================================================================
 */

const CACHE_NAME = 'kawabata-boat-pwa-v2.1.0';
const PRECACHE_URLS = [
  './boat.html',
  './collect.html',
  './assets/common.js',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://static.line-scdn.net/liff/edge/2/sdk.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW] Precache partial error:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // POST や GAS API リクエストは SW キャッシュ対象外（LocalStorage等でオフラインキュー管理）
  if (request.method !== 'GET' || url.hostname.includes('script.google.com')) {
    return;
  }

  // HTML ドキュメントのリクエスト (Network First -> Cache Fallback)
  if (request.mode === 'navigate' || (request.headers.get('accept') && request.headers.get('accept').includes('text/html'))) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) return cachedResponse;
          // フォールバック
          if (url.pathname.includes('collect.html')) {
            return caches.match('./collect.html');
          }
          return caches.match('./boat.html');
        })
    );
    return;
  }

  // 静的アセット (Cache First / Stale-While-Revalidate)
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
