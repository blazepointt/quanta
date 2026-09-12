/**
 * webcontainerService.js — Quanta AI Code Sandbox
 * Класс-синглтон для управления инстансом WebContainer.
 *
 * ИМПОРТ ИЗ ESM:
 * import { WebContainerService } from './webcontainerService.js';
 *
 * ВАЖНО: Перед boot() необходимо зарегистрировать Service Worker
 * через isolationManager.ensureIsolation().
 */

import {
  WEBCONTAINER_BOOT_TIMEOUT_MS,
  DEFAULT_PACKAGE_JSON_NODE,
  DEFAULT_INDEX_JS,
  MARKDOWN_CODE_BLOCK_REGEX,
  VALID_FILENAME_REGEX,
  ALLOWED_EXTENSIONS,
  PROJECT_TYPE_SIGNATURES,
  PROJECT_TYPES,
  UI_MESSAGES,
} from './constants.js';

/* ============================================================
   парсер Markdown — ИЗВЛеченИе ФАЙЛОВ ИЗ ОТВеТа ИИ
   ============================================================ */

/**
 * Извлекает файлы из markdown-ответа модели.
 *
 * Поддерживаемые форматы блоков:
 *   ```js index.js
 *   ```javascript // filename: index.js
 *   ```js // file: src/App.jsx
 *
 * @param {string} markdownText - Текст ответа модели
 * @returns {{ path: string, content: string }[]} Массив файлов
 */
export function parseFilesFromMarkdown(markdownText) {
  const files = [];
  const regex = new RegExp(MARKDOWN_CODE_BLOCK_REGEX.source, 'g');
  let match;
  let fileIndex = 0;

  while ((match = regex.exec(markdownText)) !== null) {
    const rawFilename = (match[1] || '').trim();
    const code = (match[2] || '').trim();

    if (!code) continue;

    let path = rawFilename;

    // Убираем префиксы вида "// filename:" или "// file:"
    path = path.replace(/^\/\/\s*(?:filename:|file:)?\s*/i, '').trim();
    // Убираем кавычки, если есть
    path = path.replace(/^['"`]|['"`]$/g, '').trim();
    // Нормализуем сепараторы (windows -> unix)
    path = path.replace(/\\/g, '/');
    // Убираем ведущий слэш, если есть
    path = path.replace(/^\/+/, '');

    // Если имя файла не выглядит как валидное, генерируем автоматически
    if (!path || !VALID_FILENAME_REGEX.test(path)) {
      path = _guessFilename(code, fileIndex);
    }

    // Проверяем разрешённое расширение
    const ext = path.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;

    files.push({ path, content: code });
    fileIndex++;
  }

  return files;
}

/**
 * Угадывает имя файла по содержимому (приватная хелпер-функция).
 * @param {string} code
 * @param {number} index
 * @returns {string}
 */
function _guessFilename(code, index) {
  if (/<!DOCTYPE html>/i.test(code) || /<html/i.test(code)) return 'index.html';
  if (code.includes('"name"') && code.includes('"version"') && code.includes('"scripts"')) return 'package.json';
  if (code.includes('defineConfig') && code.includes('vite')) return 'vite.config.js';
  if (code.includes('express()')) return index === 0 ? 'index.js' : `server${index}.js`;
  if (code.includes('createServer') || code.includes('require(')) return index === 0 ? 'index.js' : `script${index}.js`;
  if (code.includes('import ') && (code.includes('from \'react\'') || code.includes('from "react"'))) {
    return index === 0 ? 'App.jsx' : `Component${index}.jsx`;
  }
  if (code.includes('{') && !code.includes(';') && code.includes(':')) return `config${index}.json`;
  if (code.includes('body') && code.includes('{') && code.includes('}')) return `style${index}.css`;
  return index === 0 ? 'index.js' : `file${index}.js`;
}

/**
 * Определяет тип проекта по содержимому файлов.
 * @param {{ path: string, content: string }[]} files
 * @returns {'VITE_REACT' | 'VITE' | 'EXPRESS' | 'NODE'}
 */
export function detectProjectType(files) {
  const allContent = files.map(f => f.path + '\n' + f.content).join('\n');

  for (const [type, signatures] of Object.entries(PROJECT_TYPE_SIGNATURES)) {
    if (signatures.some(sig => allContent.includes(sig))) {
      return type;
    }
  }

  return 'NODE';
}

/* ============================================================
   преоБРАЗОванИе ПЛОСКОЙ СТРУКТУРЫ В ДРЕВОВИДНУЮ (WebContainer FS)
   ============================================================ */

/**
 * Преобразует плоский массив файлов [{ path, content }]
 * в древовидный объект вида:
 * {
 *   'src': { directory: {
 *     'App.jsx': { file: { contents: '...' } }
 *   }},
 *   'index.js': { file: { contents: '...' } }
 * }
 *
 * Это формат, который принимает webcontainer.mount().
 *
 * @param {{ path: string, content: string }[]} flatFiles
 * @returns {Record<string, any>} WebContainer FileSystemTree
 */
export function buildFileSystemTree(flatFiles) {
  const tree = {};

  for (const { path, content } of flatFiles) {
    const parts = path.split('/').filter(Boolean);
    let current = tree;

    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      if (!current[dirName]) {
        current[dirName] = { directory: {} };
      }
      // Если вдруг по этому пути уже есть файл, а не директория
      if (!current[dirName].directory) {
        current[dirName] = { directory: {} };
      }
      current = current[dirName].directory;
    }

    const fileName = parts[parts.length - 1];
    current[fileName] = {
      file: {
        contents: content,
      },
    };
  }

  return tree;
}

/* ============================================================
   WebContainerError — пОняТНЫЕ БИЗНЕС-ИскЛЮЧеНИЯ
   ============================================================ */

export class WebContainerError extends Error {
  /**
   * @param {'NO_ISOLATION' | 'SW_NOT_SUPPORTED' | 'BOOT_FAILED' | 'MOUNT_FAILED' | 'INSTALL_FAILED' | 'START_FAILED' | 'TIMEOUT' | 'DESTROYED'} code
   * @param {string} message
   * @param {Error | null} [cause]
   */
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'WebContainerError';
    this.code = code;
    this.cause = cause;
  }
}

/* ============================================================
   WebContainerService — СИНГЛТОН
   ============================================================ */

class WebContainerServiceImpl {
  constructor() {
    /** @type {import('@webcontainer/api').WebContainer | null} */
    this._instance = null;

    /** @type {boolean} */
    this._booted = false;

    /** @type {boolean} */
    this._booting = false;

    /** @type {Promise<void> | null} */
    this._bootPromise = null;

    /** @type {boolean} */
    this._destroyed = false;

    // Процессы, которые нужно уничтожить при destroy()
    /** @type {Set<import('@webcontainer/api').WebContainerProcess>} */
    this._runningProcesses = new Set();

    // Отправляем события через callback-систему
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /* --------------------------------------------------
     ПУБЛИЧНЫЙ API
     -------------------------------------------------- */

  /**
   * Запускает WebContainer с проверкой изоляции.
   * Идемпотентен: несколько параллельных вызовов boot() вывернут один инстанс.
   *
   * @param {(status: string) => void} [onStatus] Коллбэк статуса для UI
   * @returns {Promise<import('@webcontainer/api').WebContainer>}
   * @throws {WebContainerError}
   */
  async boot(onStatus = () => {}) {
    if (this._destroyed) {
      throw new WebContainerError('DESTROYED', UI_MESSAGES.DESTROYED);
    }

    // Если уже загрузился, возвращаем существующий инстанс
    if (this._booted && this._instance) {
      return this._instance;
    }

    // Если загрузка уже идёт, ждём еёзавершения
    if (this._booting && this._bootPromise) {
      await this._bootPromise;
      return this._instance;
    }

    this._booting = true;

    this._bootPromise = (async () => {
      // --- 1. ПРОВЕРКА ИЗОЛЯЦИИ ---
      onStatus(UI_MESSAGES.CHECKING_ISOLATION);

      if (!window.crossOriginIsolated) {
        throw new WebContainerError(
          'NO_ISOLATION',
          UI_MESSAGES.NO_ISOLATION
        );
      }

      if (!('SharedArrayBuffer' in window)) {
        throw new WebContainerError(
          'NO_ISOLATION',
          'Отсутствует SharedArrayBuffer. Требуется crossOriginIsolated.'
        );
      }

      // --- 2. ДИНАМИЧЕСКИЙ ИМПОРТ @webcontainer/api ---
      // Импортируем динамически, чтобы не ломать tree-shaking.
      // В реальном проекте замените на топ-левельный import:
      // import { WebContainer } from '@webcontainer/api';
      let WebContainer;
      try {
        const mod = await import('https://unpkg.com/@webcontainer/api@1/dist/index.js');
        WebContainer = mod.WebContainer;
      } catch (importError) {
        throw new WebContainerError(
          'BOOT_FAILED',
          'Не удалось загрузить @webcontainer/api. Проверьте интернет-соединение.',
          importError
        );
      }

      // --- 3. ЗАПУСК WEBCONTAINER ---
      onStatus(UI_MESSAGES.BOOTING_CONTAINER);

      // Таймаут запуска
      const bootTimeout = new Promise((_, reject) =>
        setTimeout(() =>
          reject(new WebContainerError('TIMEOUT', `Запуск превысил таймаут ${WEBCONTAINER_BOOT_TIMEOUT_MS / 1000}с`)),
          WEBCONTAINER_BOOT_TIMEOUT_MS
        )
      );

      try {
        this._instance = await Promise.race([
          WebContainer.boot(),
          bootTimeout,
        ]);
      } catch (err) {
        if (err instanceof WebContainerError) throw err;
        throw new WebContainerError('BOOT_FAILED', `Ошибка запуска: ${err.message}`, err);
      }

      this._booted = true;
      this._booting = false;
      onStatus(UI_MESSAGES.CONTAINER_READY);
    })();

    await this._bootPromise;
    return this._instance;
  }

  /**
   * Монтирует файлы в виртуальную ФС.
   *
   * Принимает два формата входных данных:
   * 1. Плоский массив: [{ path, content }] — преобразуется автоматически
   * 2. Древовидный объект WebContainer FileSystemTree — передаётся напрямую
   *
   * Автоматически добавляет package.json, если его нет в файлах.
   *
   * @param {{ path: string, content: string }[] | Record<string, any>} filesInput
   * @param {(status: string) => void} [onStatus]
   * @returns {Promise<{ projectType: string, hasDependencies: boolean }>}
   * @throws {WebContainerError}
   */
  async mountFiles(filesInput, onStatus = () => {}) {
    if (!this._instance) {
      throw new WebContainerError('MOUNT_FAILED', 'Контейнер не запущен. Сначала вызовите boot().');
    }

    onStatus(UI_MESSAGES.MOUNTING_FILES);

    let flatFiles;
    let fileSystemTree;

    // --- ОПРЕДЕЛЕНИЕ ФОРМАТА ИНПУТА ---
    if (Array.isArray(filesInput)) {
      // Формат 1: плоский массив
      flatFiles = filesInput;
    } else if (typeof filesInput === 'object' && filesInput !== null) {
      // Формат 2: готовое дерево — передаём напрямую
      fileSystemTree = filesInput;
      flatFiles = _flattenTree(filesInput);
    } else {
      throw new WebContainerError('MOUNT_FAILED', 'Неверный формат файлов.');
    }

    // --- ОПРЕДЕЛЕНИЕ ТИПА ПРОЕКТА ---
    const projectTypeName = detectProjectType(flatFiles);
    const projectType = PROJECT_TYPES[projectTypeName];

    // --- ПРОВЕРКА НАЛИЧИЯ package.json ---
    const hasPackageJson = flatFiles.some(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
    const hasIndexJs = flatFiles.some(f => f.path === 'index.js' || f.path === 'src/index.js');

    // Добавляем дефолтные файлы, если они отсутствуют
    if (!hasPackageJson) {
      const defaultPkg = _getDefaultPackageJson(projectTypeName);
      flatFiles.push({
        path: 'package.json',
        content: JSON.stringify(defaultPkg, null, 2),
      });
    }

    if (!hasIndexJs && projectTypeName === 'NODE') {
      flatFiles.push({ path: 'index.js', content: DEFAULT_INDEX_JS });
    }

    // --- СТРОИМ ДЕРЕВО ФС ---
    if (!fileSystemTree) {
      fileSystemTree = buildFileSystemTree(flatFiles);
    }

    // --- МОНТИРУЕМ ---
    try {
      await this._instance.mount(fileSystemTree);
    } catch (err) {
      throw new WebContainerError('MOUNT_FAILED', `Ошибка монтирования: ${err.message}`, err);
    }

    onStatus(UI_MESSAGES.FILES_MOUNTED);

    // Проверяем, есть ли зависимости для npm install
    let hasDependencies = false;
    try {
      const pkgFile = flatFiles.find(f => f.path === 'package.json' || f.path.endsWith('/package.json'));
      if (pkgFile) {
        const pkg = JSON.parse(pkgFile.content);
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        hasDependencies = Object.keys(deps).length > 0;
      }
    } catch (_) { /* невалидный JSON */ }

    return { projectType: projectTypeName, hasDependencies };
  }

  /**
   * Возвращает активный инстанс WebContainer.
   * @returns {import('@webcontainer/api').WebContainer | null}
   */
  getInstance() {
    return this._instance;
  }

  /**
   * Регистрирует процесс для очистки при destroy().
   * @param {import('@webcontainer/api').WebContainerProcess} process
   */
  registerProcess(process) {
    this._runningProcesses.add(process);
  }

  /**
   * Удаляет процесс из списка (после завершения).
   * @param {import('@webcontainer/api').WebContainerProcess} process
   */
  unregisterProcess(process) {
    this._runningProcesses.delete(process);
  }

  /**
   * Останавливает все запущенные процессы и очищает все ресурсы.
   * Вызывайте при закрытии панели песочницы.
   */
  async destroy() {
    if (this._destroyed) return;

    this._destroyed = true;

    // Останавливаем все зарегистрированные процессы
    const killPromises = [];
    for (const proc of this._runningProcesses) {
      try {
        killPromises.push(
          Promise.resolve(proc.kill?.()).catch(() => {})
        );
      } catch (_) {}
    }

    await Promise.allSettled(killPromises);
    this._runningProcesses.clear();

    // Уничтожаем инстанс WebContainer
    if (this._instance) {
      try {
        this._instance.teardown?.();
      } catch (_) {}
      this._instance = null;
    }

    this._booted = false;
    this._booting = false;
    this._bootPromise = null;
    this._listeners.clear();

    console.log('[WebContainerService] Destroyed.');
  }

  /**
   * Сбрасывает состояние, позволяя перезапустить сандбоксу.
   * Не уничтожает сам инстанс — только останавливает процессы.
   */
  async reset() {
    const killPromises = [];
    for (const proc of this._runningProcesses) {
      try {
        killPromises.push(
          Promise.resolve(proc.kill?.()).catch(() => {})
        );
      } catch (_) {}
    }
    await Promise.allSettled(killPromises);
    this._runningProcesses.clear();
    this._destroyed = false;
  }

  /**
   * @returns {boolean}
   */
  get isBooted() {
    return this._booted && !!this._instance;
  }

  /**
   * @returns {boolean}
   */
  get isDestroyed() {
    return this._destroyed;
  }
}

/**
 * Разворачивает дерево в плоский массив [{path, content}] для анализа типа.
 * @param {Record<string, any>} tree
 * @param {string} [prefix]
 * @returns {{ path: string, content: string }[]}
 */
function _flattenTree(tree, prefix = '') {
  const files = [];
  for (const [name, node] of Object.entries(tree)) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (node.file) {
      files.push({ path: fullPath, content: node.file.contents || '' });
    } else if (node.directory) {
      files.push(..._flattenTree(node.directory, fullPath));
    }
  }
  return files;
}

/**
 * Возвращает дефолтный package.json для типа проекта.
 * @param {string} projectType
 * @returns {Object}
 */
function _getDefaultPackageJson(projectType) {
  switch (projectType) {
    case 'VITE_REACT':
      return DEFAULT_PACKAGE_JSON_VITE_REACT;
    case 'VITE':
      return DEFAULT_PACKAGE_JSON_VITE;
    case 'EXPRESS':
      return DEFAULT_PACKAGE_JSON_EXPRESS;
    default:
      return DEFAULT_PACKAGE_JSON_NODE;
  }
}

// Синглтон — единственный экземпляр на всё приложение.
export const WebContainerService = new WebContainerServiceImpl();

/* ============================================================
   МЕНЕДЖЕР ИЗОЛЯЦИИ (Service Worker Registration)
   ============================================================ */

import { SERVICE_WORKER_URL, SERVICE_WORKER_SCOPE, SW_RELOAD_FLAG } from './constants.js';

/**
 * Гарантирует наличие crossOriginIsolated, регистрируя Service Worker
 * и перезагружая страницу при необходимости.
 *
 * ЛОГИКА:
 * 1. Если crossOriginIsolated уже true — всё хорошо, ничего не делаем.
 * 2. Если URL уже содержит флаг coi-sw — воркер уже зарегистрирован и
 *    страница загружена без изоляции (браузер не поддерживает).
 * 3. Иначе — регистрируем воркер и перезагружаем с флагом.
 *
 * @param {(status: string) => void} [onStatus]
 * @returns {Promise<boolean>} true — если изоляция активна
 * @throws {WebContainerError}
 */
export async function ensureIsolation(onStatus = () => {}) {
  // Браузер не поддерживает SW
  if (!('serviceWorker' in navigator)) {
    throw new WebContainerError('SW_NOT_SUPPORTED', UI_MESSAGES.SW_NOT_SUPPORTED);
  }

  // Изоляция уже активна — отлично!
  if (window.crossOriginIsolated) {
    console.log('[COI] crossOriginIsolated = true. WebContainer ready.');
    return true;
  }

  // URL уже содержит флаг — значит, воркер зарегистрирован, но crossOriginIsolated = false.
  // Браузер не поддерживает (например, Safari < 15.2 без credentialless).
  const currentUrl = new URL(window.location.href);
  if (currentUrl.searchParams.has(SW_RELOAD_FLAG)) {
    throw new WebContainerError(
      'NO_ISOLATION',
      'Браузер не поддерживает COEP credentialless. Попробуйте Chrome или Firefox.'
    );
  }

  // Регистрируем сервис-воркер
  onStatus(UI_MESSAGES.REGISTERING_SW);
  console.log('[COI] Registering service worker...');

  try {
    const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
      scope: SERVICE_WORKER_SCOPE,
    });

    // Ждём, пока воркер активируется
    await _waitForServiceWorker(registration);

    onStatus(UI_MESSAGES.SW_REGISTERED);
    console.log('[COI] Service Worker registered. Reloading with isolation flag...');

    // Перезагружаем с флагом, чтобы воркер перехватил запрос и добавил заголовки
    currentUrl.searchParams.set(SW_RELOAD_FLAG, '1');
    window.location.replace(currentUrl.toString());

    // Этот код никогда не выполнится — перезагрузка прерывает JavaScript
    return false;

  } catch (err) {
    if (err instanceof WebContainerError) throw err;
    throw new WebContainerError(
      'SW_NOT_SUPPORTED',
      `Не удалось зарегистрировать Service Worker: ${err.message}`,
      err
    );
  }
}

/**
 * Ждёт, пока воркер станет активным (activated).
 * @param {ServiceWorkerRegistration} registration
 * @returns {Promise<void>}
 */
function _waitForServiceWorker(registration) {
  if (registration.active) return Promise.resolve();

  return new Promise((resolve) => {
    const sw = registration.installing || registration.waiting;
    if (!sw) {
      resolve();
      return;
    }

    sw.addEventListener('statechange', function handler(event) {
      if (event.target.state === 'activated') {
        sw.removeEventListener('statechange', handler);
        resolve();
      }
    });
  });
}

/**
 * Обрабатывает postMessage от сервис-воркера (например, для cleanup URL).
 */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const { data } = event;
    if (!data) return;

    // Воркер активирован — убираем флаг из URL без reload
    if (data.type === 'COI_SW_ACTIVATED' && data.cleanUrl) {
      const url = new URL(window.location.href);
      if (url.searchParams.has(SW_RELOAD_FLAG)) {
        url.searchParams.delete(SW_RELOAD_FLAG);
        window.history.replaceState({}, '', url.toString());
      }
    }

    // Воркер требует перезагрузки
    if (data.type === 'COI_SW_NEEDS_RELOAD') {
      const url = new URL(window.location.href);
      if (!url.searchParams.has(SW_RELOAD_FLAG)) {
        url.searchParams.set(SW_RELOAD_FLAG, '1');
        window.location.replace(url.toString());
      }
    }
  });
}
