/**
 * constants.js — Quanta AI Code Sandbox
 * Глобальные конфигурации и дефолтные структуры виртуальной ФС WebContainer.
 */

/* ============================================================
   НАСТРОЙКИ СЕРВИС-ВОРКЕРА
   ============================================================ */

/**
 * Путь к файлу сервис-воркера относительно корня сайта.
 * Должен лежать в корне (/) для правильного scope.
 * Например, если ваш GitHub Pages: https://user.github.io/repo/
 * То scope должен быть '/repo/'.
 */
export const SERVICE_WORKER_URL = '/quanta/serviceworker.js';
export const SERVICE_WORKER_SCOPE = '/quanta/';
export const SW_RELOAD_FLAG = 'coi-sw';

/**
 * Параметр URL, по которому понимаем, что воркер уже активен.
 * Соответствует RELOAD_FLAG в serviceworker.js.
 */
export const SW_RELOAD_FLAG = 'coi-sw';

/* ============================================================
   НАСТРОЙКИ WEBCONTAINER
   ============================================================ */

/**
 * Таймаут запуска WebContainer в миллисекундах.
 * Аналогично о
 * процессу npm install при большом количестве зависимостей.
 */
export const WEBCONTAINER_BOOT_TIMEOUT_MS = 30_000;

/**
 * Таймаут выполнения npm install.
 */
export const NPM_INSTALL_TIMEOUT_MS = 120_000; // 2 минуты — может быть медленный NPM

/**
 * Таймаут запуска dev-сервера и появления server-ready.
 */
export const SERVER_READY_TIMEOUT_MS = 60_000;

/**
 * Максимальное количество строк в виртуальном терминале.
 * По достижении лимита старые строки удаляются с начала.
 */
export const TERMINAL_MAX_LINES = 500;

/* ============================================================
   ШАБЛОНЫ ФАЙЛОВОЙ СИСТЕМЫ
   ============================================================ */

/**
 * Базовый package.json для простого Node.js-скрипта.
 * Используется при запуске одинарного JS без фреймворка.
 */
export const DEFAULT_PACKAGE_JSON_NODE = {
  name: 'quanta-sandbox',
  version: '1.0.0',
  description: 'Quanta AI Code Sandbox',
  main: 'index.js',
  scripts: {
    start: 'node index.js',
    dev: 'node index.js',
  },
  dependencies: {},
};

/**
 * Базовый package.json для Express-приложения.
 */
export const DEFAULT_PACKAGE_JSON_EXPRESS = {
  name: 'quanta-sandbox-express',
  version: '1.0.0',
  description: 'Quanta AI Express Sandbox',
  main: 'index.js',
  scripts: {
    start: 'node index.js',
    dev: 'node index.js',
  },
  dependencies: {
    express: '^4.18.2',
  },
};

/**
 * Базовый package.json для Vite + React-приложения.
 */
export const DEFAULT_PACKAGE_JSON_VITE_REACT = {
  name: 'quanta-sandbox-react',
  version: '1.0.0',
  description: 'Quanta AI Vite React Sandbox',
  main: 'index.js',
  scripts: {
    dev: 'vite --host',
    build: 'vite build',
    preview: 'vite preview --host',
  },
  dependencies: {
    react: '^18.2.0',
    'react-dom': '^18.2.0',
  },
  devDependencies: {
    '@vitejs/plugin-react': '^4.0.0',
    vite: '^4.4.0',
  },
};

/**
 * Базовый package.json для Vite (ванильный JS).
 */
export const DEFAULT_PACKAGE_JSON_VITE = {
  name: 'quanta-sandbox-vite',
  version: '1.0.0',
  description: 'Quanta AI Vite Sandbox',
  scripts: {
    dev: 'vite --host',
    build: 'vite build',
    preview: 'vite preview --host',
  },
  dependencies: {},
  devDependencies: {
    vite: '^4.4.0',
  },
};

/**
 * Стартовый index.js для Node.js скрипта (простой HTTP-сервер).
 * Используется как фоллбэк, если ИИ не сгенерировал свой index.js.
 */
export const DEFAULT_INDEX_JS = `const http = require('http');

const PORT = 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(\`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <title>Quanta Sandbox</title>
      <style>
        body { 
          margin: 0; 
          display: flex; 
          align-items: center; 
          justify-content: center; 
          min-height: 100vh; 
          background: #1e1e1e; 
          color: #f3f4f6; 
          font-family: Inter, sans-serif;
        }
        .box { text-align: center; padding: 2rem; }
        h1 { font-size: 2rem; margin-bottom: 0.5rem; }
        p { color: #9ca3af; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>\u26a1 Quanta Sandbox</h1>
        <p>Сервер запущен на порту \${PORT}</p>
        <p style="margin-top:1rem; font-size: 0.85rem; color: #6b7280;">Напишите свой код, чтобы увидеть результат.</p>
      </div>
    </body>
    </html>
  \`);
});

server.listen(PORT, () => {
  console.log(\`Server running at http://localhost:\${PORT}\`);
});
`;

/**
 * Стартовый index.html для Vite-проектов.
 */
export const DEFAULT_VITE_INDEX_HTML = `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Quanta Sandbox</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`;

/**
 * Стартовый main.js для ванильного Vite.
 */
export const DEFAULT_VITE_MAIN_JS = `import './style.css';

document.querySelector('#app').innerHTML = \`
  <div style="text-align:center; padding: 4rem; font-family: Inter, sans-serif;">
    <h1 style="font-size: 2rem; color: #7c3aed;">\u26a1 Quanta Sandbox</h1>
    <p style="color: #6b7280; margin-top: 0.5rem;">\u0420едактируйте main.js, чтобы начать.</p>
  </div>
\`;
`;

/**
 * Стартовый style.css для ванильного Vite.
 */
export const DEFAULT_VITE_STYLE_CSS = `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:#1e1e1e;color:#f3f4f6;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;}
#app{display:flex;align-items:center;justify-content:center;min-height:100vh;}
`;

/**
 * Стартовый vite.config.js.
 */
export const DEFAULT_VITE_CONFIG = `import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
  },
});
`;

/**
 * Стартовый vite.config.js для React.
 */
export const DEFAULT_VITE_REACT_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
});
`;

/* ============================================================
   ТИПЫ ПРОЕКТОВ (АВТООПРЕДЕЛЕНИЕ)
   ============================================================ */

/**
 * Ключевые фразы для автоопределения типа проекта по коду.
 * Используется в parseFilesFromMarkdown для выбора правильного сценария.
 */
export const PROJECT_TYPE_SIGNATURES = {
  VITE_REACT: [
    '@vitejs/plugin-react',
    'import React',
    "from 'react'",
    'ReactDOM.createRoot',
    'vite.config',
    '.jsx',
    '.tsx',
  ],
  VITE: [
    'vite',
    'defineConfig',
    'import.meta',
    'index.html',
    'main.js',
  ],
  EXPRESS: [
    "require('express')",
    "from 'express'",
    'app.listen',
    'app.get',
    'app.post',
    'express()',
  ],
  NODE: [
    'http.createServer',
    'require(',
    'module.exports',
    'process.argv',
    'fs.readFile',
    'path.join',
  ],
};

/**
 * Типы проектов с привязанными командами.
 */
export const PROJECT_TYPES = {
  VITE_REACT: {
    label: 'Vite + React',
    icon: '\u269B\uFE0F',
    installCmd: ['npm', ['install']],
    devCmd: ['npm', ['run', 'dev']],
    serverReadyPattern: /Local:\s+https?:\/\//i,
  },
  VITE: {
    label: 'Vite',
    icon: '\u26A1',
    installCmd: ['npm', ['install']],
    devCmd: ['npm', ['run', 'dev']],
    serverReadyPattern: /Local:\s+https?:\/\//i,
  },
  EXPRESS: {
    label: 'Express',
    icon: '\uD83D\uDFE2',
    installCmd: ['npm', ['install']],
    devCmd: ['node', ['index.js']],
    serverReadyPattern: /listening|running at|started on/i,
  },
  NODE: {
    label: 'Node.js',
    icon: '\uD83D\uDFE1',
    installCmd: null, // не нужно install
    devCmd: ['node', ['index.js']],
    serverReadyPattern: /listening|running at|started on|Server/i,
  },
};

/* ============================================================
   НАСТРОЙКИ UI ПЕСОЧНИЦЫ
   ============================================================ */

/**
 * Цветовая схема терминала (ANSI-палитра для DOM-компонента).
 */
export const TERMINAL_COLORS = {
  // Базовые ANSI-цвета
  black:       '#1e1e1e',
  red:         '#f44747',
  green:       '#4ec9b0',   // green-ish (teal), хорошо читается
  yellow:      '#dcdcaa',
  blue:        '#569cd6',
  magenta:     '#c678dd',
  cyan:        '#56b6c2',
  white:       '#d4d4d4',
  gray:        '#6b7280',
  brightRed:   '#f44747',
  brightGreen: '#89d185',
  brightYellow:'#ffff00',
  brightBlue:  '#4fc1ff',
  // Специальные
  error:       '#ef4444',
  success:     '#10b981',
  warning:     '#f59e0b',
  muted:       '#6b7280',
  prompt:      '#7c3aed',
  stdout:      '#f3f4f6',
  stderr:      '#f87171',
  info:        '#60a5fa',
};

/**
 * Сообщения UI для разных состояний.
 */
export const UI_MESSAGES = {
  CHECKING_ISOLATION: 'Проверяем среду выполнения...',
  REGISTERING_SW:     'Регистрируем Service Worker...',
  SW_REGISTERED:      'Сервис-воркер зарегистрирован. Перезагрузка для активации...',
  BOOTING_CONTAINER:  'Запуск виртуального контейнера...',
  CONTAINER_READY:    'Контейнер готов. Монтируем файлы...',
  MOUNTING_FILES:     'Монтируем файлы в виртуальную ФС...',
  FILES_MOUNTED:      'Файлы успешно смонтированы.',
  INSTALLING_DEPS:    'Устанавливаем зависимости...',
  DEPS_INSTALLED:     'Зависимости установлены.',
  STARTING_SERVER:    'Запускаем сервер...',
  SERVER_RUNNING:     'Сервер запущен!',
  NO_ISOLATION:       'WebContainer требует режим crossOriginIsolated. Сервис-воркер не активен.',
  SW_NOT_SUPPORTED:   'Этот браузер не поддерживает Service Worker. Используйте Chrome/Edge/Firefox.',
  INSTALL_FAILED:     'Ошибка npm install. Проверьте package.json и соединение.',
  SERVER_CRASH:       'Процесс завершился с ошибкой.',
  TIMEOUT:            'Превышен временной лимит. Попробуйте снова.',
  DESTROYED:          'Песочница остановлена.',
  NO_CODE_FOUND:      'Код не найден в ответе модели. Попросите сгенерировать код.',
};

/* ============================================================
   ПАРСЕР MARKDOWN — ИЗВЛЕЧЕНИЕ ФАЙЛОВ ИЗ ОТВЕТА ИИ
   ============================================================ */

/**
 * Регулярное выражение для парсинга Markdown блоков кода с именами файлов.
 *
 * Поддерживаемые форматы:
 * \```js // filename: index.js
 * \```javascript index.js
 * \```js index.js
 * \```typescript // src/App.tsx
 * \```json package.json
 *
 * Примечание: имена файлов часто следуют за лангуажем, иногда с комментарием // filename:
 */
export const MARKDOWN_CODE_BLOCK_REGEX =
  /```(?:[a-zA-Z0-9+\-.]*)?(?:[\t ]+(?:\/\/ filename:|filename:|file:)?[\t ]*([^\n]+))?\n([\s\S]*?)```/g;

/**
 * Регулярное выражение для проверки, является ли строка валидным именем файла.
 */
export const VALID_FILENAME_REGEX = /^[\w\-./]+\.[a-zA-Z0-9]+$/;

/**
 * Расширения файлов, которые мы монтируем в виртуальную ФС.
 * Файлы с другими расширениями будут игнорироваться.
 */
export const ALLOWED_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'json', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'md', 'txt', 'env', 'gitignore',
  'svg', 'xml',
  'yaml', 'yml',
  'toml', 'ini',
  'sh', 'bash',
]);
