# Quanta AI — Инструкция по интеграции песочницы кода

## Файловая структура

```
your-repo/
├── index.html               ← ваш файл quanta.html (переименуйте)
└── sandbox/
    ├── serviceworker.js         ← обязательно в корне сайта!
    ├── constants.js
    ├── webcontainerService.js
    ├── processManager.js
    └── sandbox-ui.js
```

> ВАЖНО: `serviceworker.js` должен лежать в корне сайта (scope = `./`).  
> Если GitHub Pages развёрнут через `/repo/`, положите `serviceworker.js` там же, где лежит `index.html`,  
> а `SERVICE_WORKER_SCOPE` в `constants.js` измените на `'/repo/'`.

---

## ШАГ 1: Вставьте тег `<script>` в `</body>` quanta.html

Найдите закрывающий `</body>` и вставьте строго перед ним:

```html
<!-- ↓↓↓ QUANTA SANDBOX — вставьте перед </body> ↓↓↓ -->
<script type="module" src="./sandbox/sandbox-ui.js"></script>
<!-- ↑↑↑ QUANTA SANDBOX END ↑↑↑ -->
</body>
```

Больше ничего делать не нужно — модуль загрузит и инициализирует всё автоматически.

---

## ШАГ 2: Где появится кнопка в сайдбаре

Модуль автоматически ищет блок «Быстрые сценарии» в DOM и вставляет кнопку сразу после него.

Если авто-инжекция не сработала, вставьте вручную:

```html
<!-- Внутри .sidebar-menu (блок «Быстрые сценарии»), после последней кнопки .sidebar-menu-btn -->
<button id="sandbox-sidebar-btn" class="sidebar-menu-btn"
  onclick="window.QuantaSandbox && (window.QuantaSandbox.open(), window.QuantaSandbox.run())"
  title="Открыть песочницу кода (WebContainer)">
  <span class="sb-icon">⚡</span>
  <span>Песочница кода</span>
  <span style="margin-left:auto;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;background:#7c3aed;color:#fff;">BETA</span>
</button>
```

> Конкретное место в quanta.html: найдите блок
> ```html
> Быстрые сценарии
> ```  
> Ищите закрывающий `</div>` блока `.sidebar-menu` — вставьте кнопку прямо туда.

---

## ШАГ 3: Проверка работы

1. Откройте DevTools → Console
2. Найдите `[Sandbox] Initialized` — значит, модуль загрузился
3. Нажмите кнопку «⚡ Песочница кода» в сайдбаре
4. Панель откроется. Нажмите «▶️ Запустить»

При первом запуске страница перезагрузится (регистрация SW) — это нормально.

---

## Интеграция с Quanta AI: автозапуск после генерации

Если хотите, чтобы песочница автозапускалась после каждого ответа с кодом, добавьте в функцию displayMessage / appendMessage Quanta:

```js
// в конце displayMessage() или после рендера markdown
const hasCode = /```[\s\S]+?```/.test(assistantMessage);
if (hasCode && window.QuantaSandbox) {
  // Показываем кнопку под сообщением
  const runBtn = document.createElement('button');
  runBtn.className = 'pill-btn';
  runBtn.textContent = '⚡ Запустить в песочнице';
  runBtn.onclick = () => { window.QuantaSandbox.open(); window.QuantaSandbox.run(); };
  messageElement.appendChild(runBtn);
}
```

---

## Технические нюансы

### GitHub Pages subdirectory
Если ваш сайт на `https://user.github.io/myrepo/`, в `constants.js`:
```js
export const SERVICE_WORKER_SCOPE = '/myrepo/';
```

### Офлайн-режим
@webcontainer/api требует интернет для npm install.  
Для офлайна используйте только Node.js-скрипты без зависимостей.

### Браузерная поддержка
| Браузер | Поддержка | Примечание |
|---|---|---|
| Chrome 91+ | ✅ Полная | COEP credentialless |
| Firefox 90+ | ✅ Полная | COEP credentialless |
| Safari 15.2+ | ⚠️ Частичная | Нет COEP credentialless |
| Edge 91+ | ✅ Полная | Как Chromium |

### Безопасность iframe
`sandbox` атрибут в iframe ограничивает код песочницы.  
Добавлено `allow-same-origin` для корректной работы WebContainer.
