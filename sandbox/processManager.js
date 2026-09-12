/**
 * processManager.js — Quanta AI Code Sandbox
 * Управление процессами WebContainer: запуск, стриминг stdout/stderr, server-ready.
 */

import {
  NPM_INSTALL_TIMEOUT_MS,
  SERVER_READY_TIMEOUT_MS,
  PROJECT_TYPES,
  UI_MESSAGES,
} from './constants.js';
import { WebContainerService, WebContainerError } from './webcontainerService.js';

/* ============================================================
   ProcessManager
   ============================================================ */

export class ProcessManager {
  /**
   * @param {Object} opts
   * @param {(line: string, stream: 'stdout'|'stderr'|'system') => void} opts.onOutput
   *   Коллбэк вывода — каждая строка stdout/stderr передаётся сюда.
   * @param {(url: string, port: number) => void} opts.onServerReady
   *   Вызывается, когда виртуальный сервер поднялся.
   * @param {(exitCode: number, cmd: string) => void} [opts.onProcessExit]
   *   Вызывается, когда процесс завершается.
   */
  constructor({ onOutput, onServerReady, onProcessExit = () => {} }) {
    if (typeof onOutput !== 'function') throw new Error('ProcessManager: onOutput must be a function');
    if (typeof onServerReady !== 'function') throw new Error('ProcessManager: onServerReady must be a function');

    this._onOutput = onOutput;
    this._onServerReady = onServerReady;
    this._onProcessExit = onProcessExit;

    /** @type {import('@webcontainer/api').WebContainerProcess | null} */
    this._devProcess = null;

    /** @type {import('@webcontainer/api').WebContainerProcess | null} */
    this._installProcess = null;

    /** @type {boolean} */
    this._serverReadyFired = false;

    /** @type {string | null} */
    this._serverUrl = null;

    /** @type {AbortController | null} */
    this._serverReadyAbortController = null;
  }

  /* --------------------------------------------------
     ПУБЛИЧНЫЙ API
     -------------------------------------------------- */

  /**
   * Устанавливает зависимости через npm install.
   *
   * @param {(status: string) => void} [onStatus]
   * @returns {Promise<void>}
   * @throws {WebContainerError}
   */
  async runInstall(onStatus = () => {}) {
    const wc = WebContainerService.getInstance();
    if (!wc) throw new WebContainerError('BOOT_FAILED', 'Контейнер не запущен.');

    onStatus(UI_MESSAGES.INSTALLING_DEPS);
    this._onOutput('\r\n\x1b[36m$ npm install\x1b[0m\r\n', 'system');

    let installProcess;
    try {
      installProcess = await wc.spawn('npm', ['install']);
    } catch (err) {
      throw new WebContainerError('INSTALL_FAILED', `Не удалось запустить npm install: ${err.message}`, err);
    }

    this._installProcess = installProcess;
    WebContainerService.registerProcess(installProcess);

    // Стримим stdout / stderr
    this._pipeOutput(installProcess, 'npm install');

    // Таймаут
    const exitCode = await Promise.race([
      installProcess.exit,
      new Promise((_, reject) =>
        setTimeout(() =>
          reject(new WebContainerError('TIMEOUT', `npm install превысил таймаут ${NPM_INSTALL_TIMEOUT_MS / 1000}с`)),
          NPM_INSTALL_TIMEOUT_MS
        )
      ),
    ]);

    WebContainerService.unregisterProcess(installProcess);
    this._installProcess = null;

    if (exitCode !== 0) {
      this._onOutput(`\r\n\x1b[31m[ERROR] npm install завершился с кодом ${exitCode}\x1b[0m\r\n`, 'stderr');
      throw new WebContainerError(
        'INSTALL_FAILED',
        `${UI_MESSAGES.INSTALL_FAILED} (код выхода: ${exitCode})`
      );
    }

    this._onOutput('\r\n\x1b[32m✔ Зависимости установлены.\x1b[0m\r\n', 'system');
    onStatus(UI_MESSAGES.DEPS_INSTALLED);
  }

  /**
   * Запускает dev-сервер или одинарный скрипт и подписывается на server-ready.
   *
   * @param {string} projectTypeName - Ключ из PROJECT_TYPES ('VITE_REACT' | 'VITE' | 'EXPRESS' | 'NODE')
   * @param {(status: string) => void} [onStatus]
   * @returns {Promise<void>}
   * @throws {WebContainerError}
   */
  async runDevServer(projectTypeName, onStatus = () => {}) {
    const wc = WebContainerService.getInstance();
    if (!wc) throw new WebContainerError('BOOT_FAILED', 'Контейнер не запущен.');

    // Останавливаем предыдущий сервер если был
    await this.stopDevServer();

    const projectType = PROJECT_TYPES[projectTypeName] || PROJECT_TYPES.NODE;
    const [cmd, args] = projectType.devCmd;

    onStatus(UI_MESSAGES.STARTING_SERVER);
    this._onOutput(`\r\n\x1b[36m$ ${cmd} ${args.join(' ')}\x1b[0m\r\n`, 'system');

    let devProcess;
    try {
      devProcess = await wc.spawn(cmd, args);
    } catch (err) {
      throw new WebContainerError('START_FAILED', `Не удалось запустить сервер: ${err.message}`, err);
    }

    this._devProcess = devProcess;
    this._serverReadyFired = false;
    WebContainerService.registerProcess(devProcess);

    // Стримим вывод, одновременно ищем server-ready в выводе
    this._pipeOutputAndDetectServer(devProcess, projectType);

    // Обрабатываем выход процесса
    devProcess.exit.then((code) => {
      WebContainerService.unregisterProcess(devProcess);
      if (this._devProcess === devProcess) {
        this._devProcess = null;
      }
      if (code !== 0 && code !== null) {
        this._onOutput(
          `\r\n\x1b[31m[ERROR] Процесс завершился с кодом ${code}\x1b[0m\r\n`,
          'stderr'
        );
      }
      this._onProcessExit(code, `${cmd} ${args.join(' ')}`);
    }).catch(() => {});

    // Дополнительно подписываемся на server-ready от WebContainer
    this._listenServerReadyEvent(wc);
  }

  /**
   * Запускает произвольную команду в WebContainer.
   *
   * @param {string} cmd - Команда (npm, node, npx...)
   * @param {string[]} args - Аргументы
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<number>} exitCode
   * @throws {WebContainerError}
   */
  async runCommand(cmd, args, { timeoutMs = 60_000 } = {}) {
    const wc = WebContainerService.getInstance();
    if (!wc) throw new WebContainerError('BOOT_FAILED', 'Контейнер не запущен.');

    this._onOutput(`\r\n\x1b[36m$ ${cmd} ${args.join(' ')}\x1b[0m\r\n`, 'system');

    let proc;
    try {
      proc = await wc.spawn(cmd, args);
    } catch (err) {
      throw new WebContainerError('START_FAILED', `Не удалось запустить ${cmd}: ${err.message}`, err);
    }

    WebContainerService.registerProcess(proc);
    this._pipeOutput(proc, `${cmd} ${args.join(' ')}`);

    const exitCode = await Promise.race([
      proc.exit,
      new Promise((_, reject) =>
        setTimeout(() =>
          reject(new WebContainerError('TIMEOUT', `Команда "${cmd} ${args.join(' ')}" превысила таймаут ${timeoutMs / 1000}с`)),
          timeoutMs
        )
      ),
    ]);

    WebContainerService.unregisterProcess(proc);
    return exitCode;
  }

  /**
   * Останавливает dev-сервер.
   */
  async stopDevServer() {
    if (this._serverReadyAbortController) {
      this._serverReadyAbortController.abort();
      this._serverReadyAbortController = null;
    }

    if (this._devProcess) {
      try {
        await this._devProcess.kill?.();
      } catch (_) {}
      WebContainerService.unregisterProcess(this._devProcess);
      this._devProcess = null;
    }

    this._serverReadyFired = false;
    this._serverUrl = null;
  }

  /**
   * Останавливает всё: инсталл и dev-сервер.
   */
  async stopAll() {
    await this.stopDevServer();
    if (this._installProcess) {
      try {
        await this._installProcess.kill?.();
      } catch (_) {}
      WebContainerService.unregisterProcess(this._installProcess);
      this._installProcess = null;
    }
  }

  /**
   * @returns {string | null} URL сервера если запущен
   */
  get serverUrl() {
    return this._serverUrl;
  }

  /* --------------------------------------------------
     ПРИВАТНЫЕ МЕТОДы
     -------------------------------------------------- */

  /**
   * Простой пайп потоков: передаёт stdout/stderr в onOutput.
   * @param {import('@webcontainer/api').WebContainerProcess} proc
   * @param {string} label
   */
  _pipeOutput(proc, label) {
    // stdout
    if (proc.output) {
      const outputReader = proc.output.getReader();
      const readStdout = async () => {
        try {
          while (true) {
            const { done, value } = await outputReader.read();
            if (done) break;
            this._onOutput(value, 'stdout');
          }
        } catch (_) {
          // Поток закрыт
        }
      };
      readStdout();
    }
  }

  /**
   * Пайп потоков с одновременной детекцией server-ready в строках вывода.
   * Используется как резерв на случай, если WebContainer не файрит server-ready сам.
   *
   * @param {import('@webcontainer/api').WebContainerProcess} proc
   * @param {{ serverReadyPattern: RegExp, devCmd: [string, string[]] }} projectType
   */
  _pipeOutputAndDetectServer(proc, projectType) {
    if (!proc.output) return;

    const outputReader = proc.output.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const readLoop = async () => {
      try {
        while (true) {
          const { done, value } = await outputReader.read();
          if (done) break;

          // value может быть Uint8Array или string
          const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });

          this._onOutput(text, 'stdout');

          // Детекция server-ready в выводе (fallback-метод)
          if (!this._serverReadyFired && projectType.serverReadyPattern) {
            buffer += text;

            // Ищем URL в буфере
            const urlMatch = buffer.match(/https?:\/\/[^\s,"'`]+/i);
            if (urlMatch && projectType.serverReadyPattern.test(buffer)) {
              this._serverReadyFired = true;
              const detectedUrl = urlMatch[0].replace(/[\.,:;]+$/, ''); // trim trailing punctuation
              this._serverUrl = detectedUrl;
              this._onOutput(
                `\r\n\x1b[32m[SANDBOX] Server ready: ${detectedUrl}\x1b[0m\r\n`,
                'system'
              );
              this._onServerReady(detectedUrl, 0);
              buffer = ''; // очищаем, чтобы не накапливать память
            } else if (buffer.length > 4000) {
              // Ограничиваем размер буфера
              buffer = buffer.slice(-2000);
            }
          }
        }
      } catch (_) {
        // Поток закрыт — это нормально при kill()
      }
    };

    readLoop();
  }

  /**
   * Подписывается на событие server-ready от WebContainer API.
   * Это основной механизм; fallback — детекция URL в stdout выше.
   *
   * @param {import('@webcontainer/api').WebContainer} wc
   */
  _listenServerReadyEvent(wc) {
    if (typeof wc.on !== 'function') return;

    this._serverReadyAbortController = new AbortController();
    const signal = this._serverReadyAbortController.signal;

    // server-ready приходит (port, url)
    const serverReadyHandler = (port, url) => {
      if (signal.aborted) return;
      if (this._serverReadyFired) return;

      this._serverReadyFired = true;
      this._serverUrl = url;

      this._onOutput(
        `\r\n\x1b[32m[SANDBOX] ✔ Server ready on port ${port}: ${url}\x1b[0m\r\n`,
        'system'
      );
      this._onServerReady(url, port);
    };

    try {
      wc.on('server-ready', serverReadyHandler);
    } catch (_) {
      // Некоторые версии API не поддерживают on()
    }

    // Таймаут ожидания server-ready
    const readyTimeout = setTimeout(() => {
      if (!this._serverReadyFired && !signal.aborted) {
        this._onOutput(
          `\r\n\x1b[33m[WARN] server-ready не получен за ${SERVER_READY_TIMEOUT_MS / 1000}с. Сервер всё ещё запускается...\x1b[0m\r\n`,
          'system'
        );
      }
    }, SERVER_READY_TIMEOUT_MS);

    signal.addEventListener('abort', () => {
      clearTimeout(readyTimeout);
    }, { once: true });
  }
}
