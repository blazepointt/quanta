/**
 * sandbox-ui.js — Quanta AI Code Sandbox
 * Полный UI песочницы: кнопка, панель, терминал, iframe, обработка ошибок.
 *
 * Подключает всё при
 *   <script type="module" src="./sandbox/sandbox-ui.js"></script>
 * Не импортируйте ничего вручную; всё происходит автоматически при лоаде модуля.
 */

import { ensureIsolation, WebContainerService, WebContainerError, parseFilesFromMarkdown, detectProjectType } from './webcontainerService.js';
import { ProcessManager } from './processManager.js';
import { TERMINAL_MAX_LINES, TERMINAL_COLORS, UI_MESSAGES, PROJECT_TYPES } from './constants.js';

/* ============================================================
   ГЛОБАЛЬНЫЙ СОСТОЯНИЕ ПЕСОЧНИЦЫ
   ============================================================ */

/** @type {'idle' | 'booting' | 'installing' | 'running' | 'error' | 'stopped'} */
let sandboxState = 'idle';

/** @type {ProcessManager | null} */
let processManager = null;

/** Текущее содержимое терминала (строки) @type {string[]} */
let terminalLines = [];

/** Референции DOM-элементов */
let $panel = null;
let $terminalOutput = null;
let $iframe = null;
let $statusBar = null;
let $runBtn = null;
let $stopBtn = null;
let $clearBtn = null;
let $errorOverlay = null;

/* ============================================================
   ANSI -> HTML (кастомный терминал)
   ============================================================ */

/**
 * Очень лёгкий ANSI → HTML конвертер.
 * Поддерживает основные цветовые коды (30-37, 90-97) и bold/dim.
 *
 * @param {string} text
 * @returns {string} HTML
 */
function ansiToHtml(text) {
  // Сначала экранируем HTML-спецсимволы
  let safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const colorMap = {
    '30': TERMINAL_COLORS.black,
    '31': TERMINAL_COLORS.red,
    '32': TERMINAL_COLORS.green,
    '33': TERMINAL_COLORS.yellow,
    '34': TERMINAL_COLORS.blue,
    '35': TERMINAL_COLORS.magenta,
    '36': TERMINAL_COLORS.cyan,
    '37': TERMINAL_COLORS.white,
    '90': TERMINAL_COLORS.gray,
    '91': TERMINAL_COLORS.brightRed,
    '92': TERMINAL_COLORS.brightGreen,
    '93': TERMINAL_COLORS.brightYellow,
    '94': TERMINAL_COLORS.brightBlue,
    '0':  null,
    '1':  null, // bold — стильное оформление через CSS
    '2':  null, // dim
  };

  let result = '';
  let openSpan = false;
  let remaining = safe;

  // ANSI escape секвенции: \x1b[...m
  const ansiRegex = /\x1b\[([\d;]*)m/g;
  let lastIndex = 0;
  let match;

  while ((match = ansiRegex.exec(safe)) !== null) {
    // Текст до escape-последовательности
    result += safe.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;

    const codes = match[1].split(';');
    for (const code of codes) {
      if (code === '0' || code === '') {
        // Сброс цвета
        if (openSpan) {
          result += '</span>';
          openSpan = false;
        }
      } else if (colorMap[code] !== undefined) {
        if (openSpan) result += '</span>';
        if (colorMap[code]) {
          result += `<span style="color:${colorMap[code]};">`;
          openSpan = true;
        }
      }
    }
  }

  // Остаток
  result += safe.slice(lastIndex);
  if (openSpan) result += '</span>';

  // Обрабатываем \r\n и \r без перевода строки (overwrite-строки npm)
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return result;
}

/* ============================================================
   ТЕРМИНАЛ: запись вывода
   ============================================================ */

/**
 * Добавляет текст в терминал.
 * @param {string} text - Сырой текст (может содержать ANSI-последовательности и \n)
 * @param {'stdout' | 'stderr' | 'system'} [stream]
 */
function terminalWrite(text, stream = 'stdout') {
  if (!$terminalOutput) return;

  const html = ansiToHtml(text);
  const lines = html.split('\n');

  // Аддим новые строки с цветом потока
  for (const line of lines) {
    if (!line && lines.indexOf(line) === lines.length - 1) continue; // trailing newline

    let colorStyle = '';
    if (stream === 'stderr') colorStyle = `color: ${TERMINAL_COLORS.stderr};`;
    else if (stream === 'system') colorStyle = `color: ${TERMINAL_COLORS.info}; font-style: italic;`;

    terminalLines.push(`<div class="t-line" style="${colorStyle}">${line}</div>`);
  }

  // Ограничение числа строк
  if (terminalLines.length > TERMINAL_MAX_LINES) {
    terminalLines = terminalLines.slice(-TERMINAL_MAX_LINES);
  }

  $terminalOutput.innerHTML = terminalLines.join('');
  // Scroll to bottom
  $terminalOutput.scrollTop = $terminalOutput.scrollHeight;
}

/**
 * Очищает терминал.
 */
function terminalClear() {
  terminalLines = [];
  if ($terminalOutput) $terminalOutput.innerHTML = '';
}

/* ============================================================
   STATUS BAR
   ============================================================ */

/**
 * @param {string} text
 * @param {'idle'|'running'|'error'|'success'} [type]
 */
function setStatus(text, type = 'idle') {
  if (!$statusBar) return;
  const colors = {
    idle:    TERMINAL_COLORS.muted,
    running: TERMINAL_COLORS.info,
    error:   TERMINAL_COLORS.error,
    success: TERMINAL_COLORS.success,
  };
  $statusBar.textContent = text;
  $statusBar.style.color = colors[type] || colors.idle;
}

/* ============================================================
   СТЕЙТЫ ОШИБОК
   ============================================================ */

/**
 * Показывает блок ошибки поверх iframe и терминала.
 * @param {string} title
 * @param {string} detail
 * @param {string} [icon]
 */
function showError(title, detail, icon = '⚠️') {
  if (!$errorOverlay) return;
  const $icon = $errorOverlay.querySelector('.sandbox-err-icon');
  const $title = $errorOverlay.querySelector('.sandbox-err-title');
  const $detail = $errorOverlay.querySelector('.sandbox-err-detail');
  if ($icon) $icon.textContent = icon;
  if ($title) $title.textContent = title;
  if ($detail) $detail.textContent = detail;
  $errorOverlay.style.display = 'flex';

  sandboxState = 'error';
  updateButtonStates();
  setStatus(title, 'error');
}

/**
 * Скрывает блок ошибки.
 */
function hideError() {
  if ($errorOverlay) $errorOverlay.style.display = 'none';
}

/* ============================================================
   КНОПКИ И СОСТОЯНИЕ
   ============================================================ */

function updateButtonStates() {
  if (!$runBtn || !$stopBtn) return;

  const isIdle    = sandboxState === 'idle' || sandboxState === 'error' || sandboxState === 'stopped';
  const isRunning = sandboxState === 'running';
  const isBooting = sandboxState === 'booting' || sandboxState === 'installing';

  $runBtn.disabled  = isRunning || isBooting;
  $stopBtn.disabled = isIdle;

  if (isBooting) {
    $runBtn.innerHTML = '<span class="sb-spin"></span> Загрузка...';
  } else if (isRunning) {
    $runBtn.innerHTML = '▶️ Запущено';
  } else {
    $runBtn.innerHTML = '▶️ Запустить';
  }
}

/* ============================================================
   Извлечение кода из последнего ответа ИИ Quanta
   ============================================================ */

/**
 * Получает последний Markdown-ответ из интерфейса Quanta AI.
 * Ищет .message-text.assistant:last-of-type — последний ответ ассистента.
 *
 * @returns {string | null}
 */
function getLastAIResponse() {
  // Подбираемся под структуру Quanta AI чата
  const selectors = [
    '.message-content.assistant:last-of-type .message-text',
    '.assistant-message:last-of-type .message-body',
    '.message.assistant:last-of-type',
    '[data-role="assistant"]:last-of-type',
  ];

  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el.innerText || el.textContent || null;
  }

  // Fallback: ищем все блоки кода на странице
  const codeBlocks = document.querySelectorAll('pre code, .code-block pre');
  if (codeBlocks.length > 0) {
    const lastCode = codeBlocks[codeBlocks.length - 1];
    return lastCode.textContent;
  }

  return null;
}

/* ============================================================
   ГЛАВНАЯ ЛОГИКА ЗАПУСКА ПЕСОЧНИЦЫ
   ============================================================ */

/**
 * Основной flow: изоляция → запуск → монтирование → install → dev-server.
 */
async function runSandbox() {
  if (sandboxState === 'booting' || sandboxState === 'installing') return;

  hideError();
  terminalClear();
  sandboxState = 'booting';
  updateButtonStates();
  setStatus(UI_MESSAGES.CHECKING_ISOLATION, 'running');

  // Изоляция: если SW нужно зарегистрировать — страница перезагрузится автоматически
  try {
    const isolated = await ensureIsolation((status) => {
      terminalWrite(status + '\n', 'system');
      setStatus(status, 'running');
    });
    if (!isolated) return; // была перезагрузка — выполнение остановлено
  } catch (err) {
    _handleError(err);
    return;
  }

  // --- ПАРСИНГ КОДА ИЗ ПОСЛЕДНЕГО ОТВЕТА ---
  const lastResponse = getLastAIResponse();
  let files = [];

  if (lastResponse) {
    files = parseFilesFromMarkdown(lastResponse);
  }

  if (files.length === 0) {
    showError(
      'Код не найден',
      UI_MESSAGES.NO_CODE_FOUND,
      '💭'
    );
    return;
  }

  terminalWrite(`\x1b[35m[QUANTA] Найдено ${files.length} файл(а/ов).\x1b[0m\n`, 'system');
  files.forEach(f => terminalWrite(`  \x1b[90m+ ${f.path}\x1b[0m\n`, 'system'));

  // Определяем тип проекта
  const projectTypeName = detectProjectType(files);
  const projectTypeInfo = PROJECT_TYPES[projectTypeName];
  terminalWrite(`\x1b[35m[QUANTA] Тип проекта: ${projectTypeInfo.icon} ${projectTypeInfo.label}\x1b[0m\n`, 'system');

  // --- ЗАПУСК WebContainer ---
  try {
    await WebContainerService.boot((status) => {
      terminalWrite(status + '\n', 'system');
      setStatus(status, 'running');
    });
  } catch (err) {
    _handleError(err);
    return;
  }

  // --- МОНТИРОВАНИЕ ---
  let mountResult;
  try {
    mountResult = await WebContainerService.mountFiles(files, (status) => {
      terminalWrite(status + '\n', 'system');
      setStatus(status, 'running');
    });
  } catch (err) {
    _handleError(err);
    return;
  }

  const { hasDependencies } = mountResult;

  // --- СОЗДАЁМ ProcessManager ---
  if (processManager) {
    await processManager.stopAll();
  }

  processManager = new ProcessManager({
    onOutput: (text, stream) => {
      terminalWrite(text, stream);
    },
    onServerReady: (url, port) => {
      _handleServerReady(url, port);
    },
    onProcessExit: (code, cmd) => {
      if (code !== 0 && code !== null) {
        showError(
          UI_MESSAGES.SERVER_CRASH,
          `Процесс "${cmd}" вышел с кодом ${code}.`,
          '💥'
        );
      } else if (sandboxState === 'running') {
        sandboxState = 'stopped';
        updateButtonStates();
        setStatus('Процесс завершён.', 'idle');
      }
    },
  });

  // --- INSTALL ---
  if (hasDependencies && projectTypeInfo.installCmd) {
    sandboxState = 'installing';
    updateButtonStates();

    try {
      await processManager.runInstall((status) => {
        setStatus(status, 'running');
      });
    } catch (err) {
      _handleError(err);
      return;
    }
  }

  // --- DEV SERVER ---
  sandboxState = 'running';
  updateButtonStates();

  try {
    await processManager.runDevServer(projectTypeName, (status) => {
      setStatus(status, 'running');
    });
  } catch (err) {
    _handleError(err);
  }
}

/**
 * Остановка песочницы.
 */
async function stopSandbox() {
  if (processManager) {
    await processManager.stopAll();
  }
  if ($iframe) {
    $iframe.src = 'about:blank';
  }
  sandboxState = 'stopped';
  updateButtonStates();
  setStatus(UI_MESSAGES.DESTROYED, 'idle');
  terminalWrite('\n\x1b[90m[Песочница остановлена]\x1b[0m\n', 'system');
}

/**
 * Обработчик события server-ready.
 * @param {string} url
 * @param {number} port
 */
function _handleServerReady(url, port) {
  if (!$iframe) return;

  $iframe.src = url;
  sandboxState = 'running';
  updateButtonStates();
  setStatus(`${UI_MESSAGES.SERVER_RUNNING} ${url}`, 'success');
  terminalWrite(`\n\x1b[32m✔ Превью доступно: ${url}\x1b[0m\n`, 'system');
}

/**
 * Централизованный обработчик ошибок.
 * @param {unknown} err
 */
function _handleError(err) {
  sandboxState = 'error';
  updateButtonStates();

  let title = 'Ошибка песочницы';
  let detail = String(err?.message || err);
  let icon = '⚠️';

  if (err instanceof WebContainerError) {
    switch (err.code) {
      case 'NO_ISOLATION':
        title = 'Изоляция недоступна';
        icon = '🔒';
        break;
      case 'SW_NOT_SUPPORTED':
        title = 'Service Worker не поддерживается';
        icon = '🚧';
        break;
      case 'INSTALL_FAILED':
        title = 'npm install провалился';
        icon = '📦';
        break;
      case 'BOOT_FAILED':
        title = 'Контейнер не запустился';
        icon = '🔧';
        break;
      case 'TIMEOUT':
        title = 'Таймаут';
        icon = '⏱️';
        break;
      case 'START_FAILED':
        title = 'Сервер не запустился';
        icon = '💥';
        break;
      default:
        title = 'Ошибка';
    }
  }

  console.error('[Sandbox Error]', err);
  terminalWrite(`\n\x1b[31m[ERROR] ${title}: ${detail}\x1b[0m\n`, 'stderr');
  showError(title, detail, icon);
}

/* ============================================================
   СОЗДАНИЕ ДОМ-СТРУКТУРЫ
   ============================================================ */

/**
 * Создаёт все DOM-элементы песочницы и инжектирует их в document.body.
 */
function createSandboxDOM() {
  // ---  CSS  ---
  const style = document.createElement('style');
  style.id = 'quanta-sandbox-styles';
  style.textContent = `
    /* =============================================
       QUANTA SANDBOX — SIDEBAR BUTTON
       ============================================= */
    #sandbox-sidebar-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 14px;
      margin: 4px 0;
      background: transparent;
      border: none;
      border-radius: 8px;
      color: var(--text-main, #f3f4f6);
      font-size: 13.5px;
      font-family: Inter, sans-serif;
      font-weight: 500;
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
      letter-spacing: 0.01em;
    }
    #sandbox-sidebar-btn:hover {
      background: var(--bg-surface-hover, #2e2e2e);
    }
    #sandbox-sidebar-btn:active {
      background: var(--border-subtle, #2f2f2f);
    }
    #sandbox-sidebar-btn .sb-icon {
      font-size: 16px;
      flex-shrink: 0;
    }
    #sandbox-sidebar-btn .sb-badge {
      margin-left: auto;
      font-size: 10px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--accent-purple, #7c3aed);
      color: #fff;
      letter-spacing: 0.04em;
    }

    /* =============================================
       PANEL OVERLAY
       ============================================= */
    #sandbox-panel {
      position: fixed;
      inset: 0;
      z-index: 9000;
      display: none;
      flex-direction: column;
      background: var(--bg-canvas, #1e1e1e);
      font-family: Inter, sans-serif;
      animation: sandbox-fadein 0.18s ease;
    }
    #sandbox-panel.open {
      display: flex;
    }
    @keyframes sandbox-fadein {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* =============================================
       TOPBAR
       ============================================= */
    #sandbox-topbar {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 52px;
      padding: 0 18px;
      background: var(--bg-sidebar, #171717);
      border-bottom: 1px solid var(--border-subtle, #2f2f2f);
      flex-shrink: 0;
    }
    #sandbox-topbar .sb-logo {
      font-size: 20px;
      margin-right: 2px;
    }
    #sandbox-topbar .sb-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-main, #f3f4f6);
    }
    #sandbox-topbar .sb-spacer {
      flex: 1;
    }
    #sandbox-topbar .sb-status {
      font-size: 12px;
      color: var(--text-muted, #9ca3af);
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* =============================================
       TOOLBAR (BUTTONS)
       ============================================= */
    #sandbox-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 18px;
      background: var(--bg-sidebar, #171717);
      border-bottom: 1px solid var(--border-subtle, #2f2f2f);
      flex-shrink: 0;
    }
    .sb-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 6px;
      border: 1px solid var(--border-medium, #3a3a3a);
      background: var(--bg-surface, #242424);
      color: var(--text-main, #f3f4f6);
      font-size: 13px;
      font-family: Inter, sans-serif;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .sb-btn:hover:not(:disabled) {
      background: var(--bg-surface-hover, #2e2e2e);
      border-color: var(--border-medium, #3a3a3a);
    }
    .sb-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .sb-btn-primary {
      background: var(--accent-purple, #7c3aed);
      border-color: var(--accent-purple, #7c3aed);
      color: #fff;
    }
    .sb-btn-primary:hover:not(:disabled) {
      background: var(--accent-purple-hover, #6d28d9);
      border-color: var(--accent-purple-hover, #6d28d9);
    }
    .sb-btn-danger {
      border-color: #ef4444;
      color: #ef4444;
    }
    .sb-btn-danger:hover:not(:disabled) {
      background: rgba(239,68,68,0.08);
    }
    .sb-btn-ghost {
      border-color: transparent;
      background: transparent;
      color: var(--text-muted, #9ca3af);
    }
    .sb-btn-ghost:hover:not(:disabled) {
      background: var(--bg-surface, #242424);
      color: var(--text-main, #f3f4f6);
    }
    .sb-btn-close {
      margin-left: auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .sb-spin {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    /* =============================================
       SPLIT CONTENT AREA
       ============================================= */
    #sandbox-content {
      display: flex;
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    /* =============================================
       TERMINAL PANE
       ============================================= */
    #sandbox-terminal-pane {
      display: flex;
      flex-direction: column;
      width: 45%;
      min-width: 260px;
      border-right: 1px solid var(--border-subtle, #2f2f2f);
      background: #0d0d0d;
      flex-shrink: 0;
    }
    #sandbox-terminal-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--bg-sidebar, #171717);
      border-bottom: 1px solid var(--border-subtle, #2f2f2f);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted, #9ca3af);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      user-select: none;
      flex-shrink: 0;
    }
    #sandbox-terminal-header .term-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
    }
    #sandbox-terminal-output {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.6;
      color: var(--text-main, #f3f4f6);
      word-break: break-all;
      scroll-behavior: smooth;
    }
    #sandbox-terminal-output .t-line {
      white-space: pre-wrap;
    }
    #sandbox-terminal-output::-webkit-scrollbar {
      width: 6px;
    }
    #sandbox-terminal-output::-webkit-scrollbar-track {
      background: transparent;
    }
    #sandbox-terminal-output::-webkit-scrollbar-thumb {
      background: #333;
      border-radius: 3px;
    }

    /* =============================================
       PREVIEW PANE
       ============================================= */
    #sandbox-preview-pane {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
      position: relative;
    }
    #sandbox-preview-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--bg-sidebar, #171717);
      border-bottom: 1px solid var(--border-subtle, #2f2f2f);
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted, #9ca3af);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      user-select: none;
      flex-shrink: 0;
    }
    #sandbox-preview-header .sb-url-bar {
      flex: 1;
      padding: 4px 10px;
      background: var(--bg-input, #212121);
      border: 1px solid var(--border-subtle, #2f2f2f);
      border-radius: 6px;
      color: var(--text-muted, #9ca3af);
      font-size: 11.5px;
      font-family: 'JetBrains Mono', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      outline: none;
      cursor: default;
    }
    #sandbox-iframe {
      flex: 1;
      width: 100%;
      border: none;
      background: #fff;
    }

    /* =============================================
       IDLE / LOADING PLACEHOLDER
       ============================================= */
    #sandbox-preview-placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: var(--bg-canvas, #1e1e1e);
      color: var(--text-muted, #9ca3af);
      pointer-events: none;
      z-index: 10;
      transition: opacity 0.25s;
    }
    #sandbox-preview-placeholder.hidden {
      opacity: 0;
    }
    #sandbox-preview-placeholder .ph-icon {
      font-size: 40px;
      opacity: 0.5;
    }
    #sandbox-preview-placeholder .ph-text {
      font-size: 14px;
      text-align: center;
      max-width: 220px;
      line-height: 1.5;
    }

    /* Спиннер загрузки */
    #sandbox-preview-placeholder .ph-spinner {
      width: 28px;
      height: 28px;
      border: 3px solid rgba(124, 58, 237, 0.2);
      border-top-color: var(--accent-purple, #7c3aed);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    /* =============================================
       ERROR OVERLAY
       ============================================= */
    #sandbox-error-overlay {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: var(--bg-canvas, #1e1e1e);
      z-index: 20;
      padding: 32px;
      text-align: center;
    }
    .sandbox-err-icon {
      font-size: 44px;
    }
    .sandbox-err-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text-main, #f3f4f6);
    }
    .sandbox-err-detail {
      font-size: 13px;
      color: var(--text-muted, #9ca3af);
      max-width: 420px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .sandbox-err-retry {
      margin-top: 8px;
    }
  `;
  document.head.appendChild(style);

  // --- SIDEBAR BUTTON ---
  const sidebarBtn = document.createElement('button');
  sidebarBtn.id = 'sandbox-sidebar-btn';
  sidebarBtn.className = 'sidebar-menu-btn'; // мимикрируем класс Quanta AI
  sidebarBtn.innerHTML = `
    <span class="sb-icon">⚡</span>
    <span>Песочница кода</span>
    <span class="sb-badge">BETA</span>
  `;
  sidebarBtn.title = 'Открыть песочницу кода (WebContainer)';
  sidebarBtn.addEventListener('click', openPanel);

  // Инжекция кнопки в сайдбар — сразу после блока «Быстрые сценарии»
  _injectSidebarButton(sidebarBtn);

  // --- PANEL ---
  const panel = document.createElement('div');
  panel.id = 'sandbox-panel';
  panel.innerHTML = `
    <div id="sandbox-topbar">
      <span class="sb-logo">⚡</span>
      <span class="sb-title">Quanta — Песочница кода</span>
      <span class="sb-spacer"></span>
      <span id="sandbox-status-bar" class="sb-status">Готова к запуску</span>
    </div>

    <div id="sandbox-toolbar">
      <button id="sb-run-btn" class="sb-btn sb-btn-primary">▶️ Запустить</button>
      <button id="sb-stop-btn" class="sb-btn sb-btn-danger" disabled>⏹ Остановить</button>
      <button id="sb-clear-btn" class="sb-btn sb-btn-ghost">🗑 Очистить</button>
      <button id="sb-close-btn" class="sb-btn sb-btn-ghost sb-btn-close">✕ Закрыть</button>
    </div>

    <div id="sandbox-content">
      <!-- Терминал — левая часть -->
      <div id="sandbox-terminal-pane">
        <div id="sandbox-terminal-header">
          <span class="term-dot"></span>
          Терминал
        </div>
        <div id="sandbox-terminal-output"></div>
      </div>

      <!-- Превью — правая часть -->
      <div id="sandbox-preview-pane">
        <div id="sandbox-preview-header">
          ПРЕВЬЮ
          <div id="sb-url-bar" class="sb-url-bar">&mdash;</div>
          <button id="sb-refresh-btn" class="sb-btn sb-btn-ghost" title="Перезагрузить превью">🔄</button>
        </div>

        <!-- Плейсхолдер (idle / loading) -->
        <div id="sandbox-preview-placeholder">
          <div class="ph-icon">⚡</div>
          <div class="ph-text">Нажмите «Запустить», чтобы запустить песочницу с кодом из последнего ответа ИИ</div>
        </div>

        <!-- Оверлей ошибки -->
        <div id="sandbox-error-overlay">
          <div class="sandbox-err-icon">⚠️</div>
          <div class="sandbox-err-title">Ошибка</div>
          <div class="sandbox-err-detail"></div>
          <button class="sb-btn sb-btn-primary sandbox-err-retry">🔄 Повторить</button>
        </div>

        <iframe id="sandbox-iframe" src="about:blank" allow="cross-origin-isolated" sandbox="allow-scripts allow-same-origin allow-forms allow-modals"></iframe>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  // --- ПОЛУЧАЕМ РЕФЕРЕНЦИИ ---
  $panel           = panel;
  $terminalOutput  = panel.querySelector('#sandbox-terminal-output');
  $iframe          = panel.querySelector('#sandbox-iframe');
  $statusBar       = panel.querySelector('#sandbox-status-bar');
  $runBtn          = panel.querySelector('#sb-run-btn');
  $stopBtn         = panel.querySelector('#sb-stop-btn');
  $clearBtn        = panel.querySelector('#sb-clear-btn');
  $errorOverlay    = panel.querySelector('#sandbox-error-overlay');

  const $placeholder   = panel.querySelector('#sandbox-preview-placeholder');
  const $urlBar        = panel.querySelector('#sb-url-bar');
  const $refreshBtn    = panel.querySelector('#sb-refresh-btn');
  const $closeBtn      = panel.querySelector('#sb-close-btn');
  const $retryBtn      = panel.querySelector('.sandbox-err-retry');

  // --- СОБЫТИЯ ---

  $runBtn.addEventListener('click', () => runSandbox());

  $stopBtn.addEventListener('click', () => stopSandbox());

  $clearBtn.addEventListener('click', () => terminalClear());

  $closeBtn.addEventListener('click', () => closePanel());

  $refreshBtn.addEventListener('click', () => {
    if ($iframe && $iframe.src !== 'about:blank') {
      $iframe.src = $iframe.src;
    }
  });

  $retryBtn.addEventListener('click', () => {
    hideError();
    runSandbox();
  });

  // Отслеживаем загрузку iframe
  $iframe.addEventListener('load', () => {
    const src = $iframe.src;
    if (src && src !== 'about:blank') {
      $urlBar.textContent = src;
      if ($placeholder) {
        $placeholder.classList.add('hidden');
        setTimeout(() => { $placeholder.style.display = 'none'; }, 250);
      }
    }
  });

  // Закрытие по Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $panel.classList.contains('open')) {
      closePanel();
    }
  });

  // Спайнер плейсхолдера: показывается при booting/installing
  function updatePlaceholder() {
    if (!$placeholder) return;
    if (sandboxState === 'booting' || sandboxState === 'installing') {
      $placeholder.style.display = 'flex';
      $placeholder.classList.remove('hidden');
      $placeholder.innerHTML = `
        <div class="ph-spinner"></div>
        <div class="ph-text">${sandboxState === 'installing' ? 'Устанавливаю зависимости...' : 'Запуск контейнера...'}</div>
      `;
    } else if (sandboxState === 'idle' || sandboxState === 'stopped') {
      $placeholder.style.display = 'flex';
      $placeholder.classList.remove('hidden');
      $placeholder.innerHTML = `
        <div class="ph-icon">⚡</div>
        <div class="ph-text">Нажмите «Запустить», чтобы запустить песочницу с кодом из последнего ответа ИИ</div>
      `;
    }
  }

  // Патчим updateButtonStates, чтобы обновлялся и плейсхолдер
  const _origUpdateBtn = updateButtonStates;
  // Monkey-patch (overwrite global for this closure)
  window.__sandboxUpdateButtonStates = () => {
    _origUpdateBtn();
    updatePlaceholder();
  };
}

/* ============================================================
   ИНЖЕКЦИЯ КНОПКИ В САЙДБАР
   ============================================================ */

/**
 * Вставляет кнопку "sandbox-sidebar-btn" в сайдбар Quanta AI
 * строго после блока «Быстрые сценарии».
 *
 * Логика поиска контайнера:
 * 1. Ищем элемент с текстом "Быстрые сценарии" (заголовок секции)
 * 2. Уходим на несколько уровней вверх до родительского контейнера (.sidebar-menu)
 * 3. Вставляем кнопку после этого контейнера
 *
 * @param {HTMLElement} btn
 */
function _injectSidebarButton(btn) {
  // Попытка 1: ищем по тексту
  const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
    const text = el.textContent?.trim() || '';
    return (
      (text.includes('Быстрые сценарии') || text.includes('Быстрые') || text.includes('Сценарии')) &&
      el.children.length < 5 &&
      el.tagName !== 'SCRIPT' &&
      el.tagName !== 'STYLE'
    );
  });

  let insertAfter = null;

  // Находим наиболее подходящий контейнер (.sidebar-menu)
  for (const el of candidates) {
    const sidebarMenu = el.closest('.sidebar-menu') || el.closest('[class*="sidebar"]') || el.parentElement;
    if (sidebarMenu) {
      insertAfter = sidebarMenu;
      break;
    }
  }

  if (insertAfter && insertAfter.parentElement) {
    insertAfter.parentElement.insertBefore(btn, insertAfter.nextSibling);
    console.log('[Sandbox] Button injected after sidebar-menu.');
    return;
  }

  // Попытка 2: ищем по классу
  const sidebarMenu = document.querySelector('.sidebar-menu, [class*="quick-scenario"], [class*="quick-pill"]');
  if (sidebarMenu && sidebarMenu.parentElement) {
    sidebarMenu.parentElement.insertBefore(btn, sidebarMenu.nextSibling);
    console.log('[Sandbox] Button injected (class fallback).');
    return;
  }

  // Попытка 3: подвешиваем в любой сайдбар
  const sidebar = document.querySelector('#sidebar, .sidebar, [class*="sidebar"]');
  if (sidebar) {
    sidebar.appendChild(btn);
    console.log('[Sandbox] Button appended to sidebar (last resort).');
    return;
  }

  // Попытка 4: document.body
  document.body.prepend(btn);
  console.warn('[Sandbox] Button prepended to body. Adjust manually.');
}

/* ============================================================
   ОТКРЫТИЕ / ЗАКРЫТИЕ ПАНЕЛИ
   ============================================================ */

function openPanel() {
  if (!$panel) return;
  $panel.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closePanel() {
  if (!$panel) return;
  $panel.classList.remove('open');
  document.body.style.overflow = '';
}

/* ============================================================
   ИНИЦИАЛИЗАЦИЯ
   ============================================================ */

/**
 * Инициализирует модуль: создаёт DOM, пробует статус SW.
 */
function initSandbox() {
  createSandboxDOM();

  // Краткое диагностическое сообщение
  if (window.crossOriginIsolated) {
    console.log('[Sandbox] ✔ crossOriginIsolated: true. WebContainer ready to boot on demand.');
  } else {
    console.warn('[Sandbox] crossOriginIsolated: false. Service Worker will activate on first run.');
  }

  // Прослушиваем глобальные события для интеграции с Quanta AI
  // Если Quanta файрит quantaSandboxRun, запускаем сандбоксу автоматически
  window.addEventListener('quantaSandboxRun', async (e) => {
    openPanel();
    await runSandbox();
  });

  // Публичный API для интеграции с основным приложением
  window.QuantaSandbox = {
    open: openPanel,
    close: closePanel,
    run: runSandbox,
    stop: stopSandbox,
    parseFiles: parseFilesFromMarkdown,
  };

  console.log('[Sandbox] Initialized. Use window.QuantaSandbox to control programmatically.');
}

// Автозапуск при загрузке модуля
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSandbox);
} else {
  initSandbox();
}
