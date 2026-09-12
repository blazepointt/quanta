/**
 * serviceworker.js — Quanta AI Code Sandbox
 * Service Worker for GitHub Pages COOP/COEP Header Injection.
 *
 * Стратегия: перехватываем все fetch-запросы из нашего origin'а
 * и принудительно добавляем заголовки Cross-Origin-Isolation.
 * Защита от бесконечного цикла: при первой активации добавляем
 * параметр ?coi-sw=1 в URL и проверяем его при install.
 */

/* ============================================================
   КОНСТАНТЫ И УТИЛИТЫ
   ============================================================ */

const SW_VERSION = '1.3.0';
const CACHE_NAME = `quanta-ai-v${SW_VERSION}`;

// Параметр, который мы добавляем к URL при первой перезагрузке.
// Его наличие означает: «воркер уже активен, не перезагружайся снова».
const RELOAD_FLAG = 'coi-sw';

// Заголовки, которые мы инжектируем в КАЖДЫЙ ответ нашего origin'а.
// 'credentialless' вместо 'require-corp' — более совместим с CDN-ресурсами
// (шрифты, иконки), т.к. не требует от них CORP-заголовков.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// Заголовки, которые нужны iframe'у превью WebContainer.
// Превью работает на другом origin'е (виртуальный порт WebContainer),
// поэтому iframe должен разрешать его загрузку.
const IFRAME_ALLOW_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * Проверяет, является ли запрос навигационным (top-level document).
 * Именно для таких запросов нужна защита от цикла.
 */
function isNavigationRequest(request) {
  return request.mode === 'navigate';
}

/**
 * Проверяет, что URL запроса принадлежит нашему origin'у.
 * Только к нашим ответам применяем заголовки изоляции.
 */
function isOurOrigin(url) {
  return url.startsWith(self.location.origin);
}

/**
 * Добавляет/заменяет заголовки в объекте Headers.
 * Возвращает новый объект Headers (иммутабельный подход).
 */
function mergeHeaders(existingHeaders, additionalHeaders) {
  const merged = new Headers(existingHeaders);
  for (const [key, value] of Object.entries(additionalHeaders)) {
    merged.set(key, value);
  }
  return merged;
}

/**
 * Клонирует Response с новыми заголовками.
 * Поскольку Response — иммутабельный, нам нужен полный клон.
 */
function createIsolatedResponse(response, extraHeaders) {
  const newHeaders = mergeHeaders(response.headers, extraHeaders);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/* ============================================================
   LIFECYCLE EVENTS
   ============================================================ */

/**
 * INSTALL — воркер установлен.
 * skipWaiting() позволяет новой версии воркера активироваться немедленно,
 * не дожидаясь закрытия всех вкладок.
 */
self.addEventListener('install', (event) => {
  console.log(`[COI-SW] Install: version ${SW_VERSION}`);
  // Немедленно становимся активным воркером
  event.waitUntil(self.skipWaiting());
});

/**
 * ACTIVATE — воркер стал активным контроллером.
 * Берём контроль над всеми клиентами (вкладками) немедленно.
 * Затем проверяем, нужна ли перезагрузка для применения изоляции.
 */
self.addEventListener('activate', (event) => {
  console.log(`[COI-SW] Activate: version ${SW_VERSION}`);

  event.waitUntil(
    (async () => {
      // Берём контроль над всеми открытыми клиентами без перезагрузки
      await self.clients.claim();

      // Получаем все управляемые клиенты (вкладки/окна)
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: false,
      });

      for (const client of clients) {
        const clientUrl = new URL(client.url);

        // ЗАЩИТА ОТ БЕСКОНЕЧНОГО ЦИКЛА:
        // Если в URL уже есть наш флаг — воркер уже работает,
        // перезагрузка произошла, флаг можно убрать из URL (cleanup).
        if (clientUrl.searchParams.has(RELOAD_FLAG)) {
          console.log(`[COI-SW] Flag found in URL, isolation active. Cleaning up URL.`);
          // Убираем флаг из адресной строки через postMessage клиенту
          client.postMessage({ type: 'COI_SW_ACTIVATED', cleanUrl: true });
          continue;
        }

        // Если флага нет — значит страница загружена без изоляции.
        // Перезагружаем страницу с флагом, чтобы воркер перехватил запрос
        // и добавил COOP/COEP заголовки при следующей загрузке документа.
        console.log(`[COI-SW] No isolation flag found. Triggering reload to activate headers.`);
        client.postMessage({ type: 'COI_SW_NEEDS_RELOAD' });
      }
    })()
  );
});

/* ============================================================
   FETCH INTERCEPTION — ЯДРО ВОРКЕРА
   ============================================================ */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // --- НАВИГАЦИОННЫЕ ЗАПРОСЫ (загрузка документа) ---
  // Это самый важный случай: браузер загружает HTML-страницу.
  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigationRequest(request, url));
    return;
  }

  // --- ПОДРЕСУРСЫ НАШЕГО ORIGIN'А ---
  // JS, CSS, изображения, шрифты с нашего же хоста
  if (isOurOrigin(request.url)) {
    event.respondWith(handleSameOriginRequest(request));
    return;
  }

  // --- ВСЁ ОСТАЛЬНОЕ (cross-origin ресурсы, CDN) ---
  // Для них тоже нужно добавить CORP-заголовок, чтобы браузер
  // в режиме crossOriginIsolated мог их загрузить.
  event.respondWith(handleCrossOriginRequest(request));
});

/**
 * Обрабатывает навигационный запрос (загрузка HTML-страницы).
 *
 * ЛОГИКА ЗАЩИТЫ ОТ ЦИКЛА:
 * 1. Выполняем сетевой запрос за актуальным HTML
 * 2. Если запрос уже содержит наш флаг — убираем его из URL (redirect)
 * 3. Добавляем COOP/COEP заголовки к ответу
 */
async function handleNavigationRequest(request, url) {
  try {
    // Флаг присутствует → воркер уже активен, убираем флаг из URL
    if (url.searchParams.has(RELOAD_FLAG)) {
      const cleanUrl = new URL(request.url);
      cleanUrl.searchParams.delete(RELOAD_FLAG);
      // Выполняем загрузку страницы без флага, но уже С заголовками изоляции
      const cleanRequest = new Request(cleanUrl.toString(), {
        method: request.method,
        headers: request.headers,
        mode: request.mode,
        credentials: request.credentials,
        redirect: request.redirect,
      });
      const response = await fetch(cleanRequest);
      return createIsolatedResponse(response, ISOLATION_HEADERS);
    }

    // Обычный навигационный запрос — загружаем и добавляем заголовки
    const response = await fetch(request);
    return createIsolatedResponse(response, ISOLATION_HEADERS);

  } catch (error) {
    console.error('[COI-SW] Navigation fetch failed:', error);
    // При сетевой ошибке возвращаем базовый офлайн-ответ
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Quanta AI — Офлайн</title></head>
       <body style="background:#1e1e1e;color:#f3f4f6;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
       <div style="text-align:center"><h2>Нет подключения к интернету</h2><p style="color:#9ca3af">Проверьте соединение и обновите страницу.</p></div>
       </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', ...ISOLATION_HEADERS } }
    );
  }
}

/**
 * Обрабатывает запросы к нашему собственному origin'у (JS, CSS, etc.).
 * Добавляем заголовки изоляции ко всем ответам.
 */
async function handleSameOriginRequest(request) {
  try {
    const response = await fetch(request);
    // Не добавляем заголовки к непрозрачным ответам (opaque responses)
    if (!response || response.type === 'opaque') return response;
    return createIsolatedResponse(response, ISOLATION_HEADERS);
  } catch (error) {
    console.warn('[COI-SW] Same-origin request failed:', request.url, error);
    return new Response('Not Found', { status: 404 });
  }
}

/**
 * Обрабатывает кросс-origin запросы (CDN, внешние API).
 * Добавляем CORP: cross-origin, чтобы ресурсы были доступны
 * в crossOriginIsolated окружении.
 */
async function handleCrossOriginRequest(request) {
  try {
    // Для cross-origin запросов используем mode: 'cors' или оригинальный mode
    const response = await fetch(request);

    // Opaque responses (no-cors) — не можем изменить заголовки
    if (!response || response.type === 'opaque') return response;

    // Только для cors-ответов добавляем CORP
    if (response.type === 'cors' || response.type === 'basic') {
      return createIsolatedResponse(response, {
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
    }

    return response;
  } catch (error) {
    // Для cross-origin запросов тихо пропускаем ошибки
    // (это могут быть blocked requests, preflight и т.д.)
    console.debug('[COI-SW] Cross-origin request failed (expected):', request.url);
    return fetch(request).catch(() => new Response('', { status: 0 }));
  }
}

/* ============================================================
   MESSAGE HANDLER — Общение с главной страницей
   ============================================================ */

self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data || typeof data !== 'object') return;

  switch (data.type) {
    // Клиент запрашивает информацию о состоянии воркера
    case 'GET_SW_STATUS': {
      event.source.postMessage({
        type: 'SW_STATUS',
        version: SW_VERSION,
        isActive: true,
        scope: self.registration.scope,
      });
      break;
    }

    // Принудительное обновление воркера (используется при деплое новой версии)
    case 'SKIP_WAITING': {
      self.skipWaiting();
      break;
    }

    default:
      break;
  }
});

console.log(`[COI-SW] Service Worker script parsed. Version: ${SW_VERSION}`);
