/* Quanta AI — service worker: установка как приложения и запуск без интернета.
   Свои файлы сайта: сначала сеть (всегда свежая версия), без сети или при очень медленной сети — копия из кэша.
   Библиотеки и шрифты с CDN: из кэша (у них в адресе версия, они не меняются).
   Запросы к ИИ, поиску, Firebase и картинкам не трогаем — они идут напрямую. */
const VERSION = '2.4';
const SHELL_CACHE = 'quanta-shell-' + VERSION;
const CDN_CACHE = 'quanta-cdn-v1';
const SHELL = [
    './',
    'styles.css?v=' + VERSION,
    'app.js?v=' + VERSION,
    'manifest.webmanifest',
    'assets/icon-192.png',
    'assets/icon-512.png',
    'assets/apple-touch-icon.png',
    'assets/favicon-48.png',
    'assets/logo-mark-1x.webp',
    'assets/logo-mark-2x.webp',
    'assets/logo-mark-3x.webp',
    'assets/logo-full-328.webp',
    'assets/logo-full-492.webp',
    'assets/logo-full-656.webp'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'unpkg.com'];
const CDN_CACHE_MAX = 60;

const OFFLINE_HTML = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Quanta AI — нет сети</title><style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;' +
    'background:#000;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px;box-sizing:border-box}' +
    'h1{font-size:1.25rem;margin:0 0 10px}p{color:#a1a1aa;margin:0 0 20px;line-height:1.5}button{font:inherit;padding:10px 20px;border-radius:10px;' +
    'border:0;background:#fff;color:#000;cursor:pointer}</style></head><body><div><h1>Нет подключения к интернету</h1>' +
    '<p>Quanta AI откроется, как только появится сеть.</p><button onclick="location.reload()">Обновить</button></div></body></html>';

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // По одному файлу: если что-то одно не скачалось, остальное всё равно сохранится
        await Promise.all(SHELL.map(async url => {
            try {
                const res = await fetch(new Request(url, { cache: 'reload' }));
                if (res.ok) await cache.put(url, await cleanResponse(res));
            } catch (_) {}
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('quanta-shell-') && k !== SHELL_CACHE).map(k => caches.delete(k)));
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable(); } catch (_) {}
        }
        await self.clients.claim();
    })());
});

// Ответ после переадресации нельзя отдавать на переход по странице — копируем без флага redirected
async function cleanResponse(res) {
    if (!res.redirected) return res;
    const body = await res.blob();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function trimCache(name, max) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

// Сначала сеть (всегда свежая версия сайта). Если сеть молчит дольше timeoutMs — отдаём копию из кэша,
// а свежий ответ всё равно сохраняем на следующий раз. Нет сети совсем — тоже копия из кэша.
async function networkFirst(event, cacheKey, timeoutMs) {
    const cache = await caches.open(SHELL_CACHE);
    const net = (async () => {
        const preload = event.preloadResponse ? await Promise.resolve(event.preloadResponse).catch(() => null) : null;
        const res = preload || await fetch(event.request);
        if (res && res.ok && res.type === 'basic') {
            const copy = await cleanResponse(res.clone());
            await cache.put(cacheKey, copy).catch(() => {});
        }
        return res;
    })();
    event.waitUntil(net.then(() => {}, () => {}));
    let timer = null;
    const slow = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); });
    try {
        const first = await Promise.race([net, slow]);
        if (first) return first;
        const hit = await cache.match(cacheKey);
        return hit || await net;
    } catch (err) {
        const hit = (await cache.match(cacheKey)) || (await cache.match(cacheKey, { ignoreSearch: true }));
        if (hit) return hit;
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// Главная страница приложения (с любыми параметрами: ?new=1, ?s=…) хранится в кэше под одним ключом './',
// остальные страницы сайта (privacy.html и т. п.) — под своим адресом
const SCOPE_PATH = new URL(self.registration.scope).pathname;
function isAppShellPath(pathname) {
    return pathname === SCOPE_PATH || pathname === SCOPE_PATH + 'index.html';
}

async function handleNavigation(event, url) {
    const key = isAppShellPath(url.pathname) ? './' : url.origin + url.pathname;
    try {
        return await networkFirst(event, key, 5000);
    } catch (err) {
        return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
}

function handleSameOrigin(event) {
    return networkFirst(event, event.request, 6000);
}

async function handleCdn(event) {
    const cache = await caches.open(CDN_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        event.waitUntil(cache.put(event.request, copy).then(() => trimCache(CDN_CACHE, CDN_CACHE_MAX)).catch(() => {}));
    }
    return res;
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    let url;
    try { url = new URL(req.url); } catch (_) { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

    if (url.origin === self.location.origin) {
        if (url.pathname.startsWith('/__/')) return;   // служебные адреса Firebase
        if (url.pathname.startsWith(SCOPE_PATH + 'downloads/')) {
            // Файл приложения (APK) качается напрямую, без копии в кэше
            if (event.preloadResponse) event.waitUntil(Promise.resolve(event.preloadResponse).catch(() => {}));
            return;
        }
        if (req.mode === 'navigate') {
            event.respondWith(handleNavigation(event, url));
            return;
        }
        event.respondWith(handleSameOrigin(event));
        return;
    }
    const isFirebaseSdk = url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
    if (isFirebaseSdk || CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(handleCdn(event));
    }
});
