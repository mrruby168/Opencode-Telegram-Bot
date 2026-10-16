import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logDir, maskSecrets } from './common.js';
import { sessionStatus } from './opencode-exec.js';

export const HEALTH_TIMEOUT_MS = 3000;
const POLL_MS = 1000;
const POLL_MAX = 30;

export function serveLogFile(dir) {
  return path.join(dir || logDir(), 'opencode-serve.log');
}

// Phân loại: OK / UNAUTHORIZED (401/403) / DOWN (từ chối kết nối, timeout, fetch failed).
export async function healthCheck({ statusFn, timeoutMs = HEALTH_TIMEOUT_MS }) {
  try {
    await statusFn(timeoutMs);
    return 'OK';
  } catch (e) {
    const s = `${e?.message ?? e} ${JSON.stringify(e?.sdkError ?? '')}`;
    if (/\b401\b|Unauthorized|unauthorized|\b403\b|Forbidden|forbidden/.test(s)) return 'UNAUTHORIZED';
    return 'DOWN';
  }
}

function manualHint(port) {
  return `Bật tay: mở terminal, cd tới thư mục project, chạy "opencode serve --port ${port} --hostname 127.0.0.1" rồi gõ /opencode lại.`;
}

// deps inject để test: { spawnFn, healthFn, sleepFn, openLogFD, closeFD, logFile, readLogTail }
export function createServerManager({ config, client, deps = {} }) {
  const spawnFn = deps.spawnFn || spawn;
  const sleepFn = deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const openLogFD = deps.openLogFD || ((file) => fs.openSync(file, 'a'));
  const closeFD = deps.closeFD || ((fd) => {
    try {
      fs.closeSync(fd);
    } catch { /* bỏ qua */ }
  });
  const logFile = deps.logFile || (() => serveLogFile());
  const readLogTail =
    deps.readLogTail ||
    ((file, maxLines = 10) => {
      try {
        const text = maskSecrets(fs.readFileSync(file, 'utf8'));
        return text.split('\n').slice(-maxLines).join('\n').trim();
      } catch {
        return '';
      }
    });
  const healthFn =
    deps.healthFn ||
    ((timeoutMs) => sessionStatus(client, { directory: config.opencodeProjectDir }, timeoutMs));
  let spawning = null;

  async function pollUntilUp(server) {
    for (let i = 0; i < POLL_MAX; i++) {
      await sleepFn(POLL_MS);
      if (server.exited !== null) {
        throw new Error(
          `opencode thoát sớm (mã ${server.exited}). Log cuối:\n${readLogTail(server.log)}`
        );
      }
      if ((await healthCheck({ statusFn: healthFn })) === 'OK') return true;
    }
    return false;
  }

  function portBusyHint(port, tail) {
    if (/EADDRINUSE|address already in use|already in use|EACCES/i.test(tail || '')) {
      return (
        `cổng ${port} đang bị chiếm; nếu đó là opencode đang chạy thì kiểm tra ` +
        `OPENCODE_SERVER_PASSWORD, nếu không thì đổi OPENCODE_SERVER_URL sang cổng khác.`
      );
    }
    return manualHint(port);
  }

  function doSpawn() {
    return (async () => {
      const port = config.opencodeServerPort;
      const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
      const log = logFile();
      let logFd = null;
      try {
        logFd = openLogFD(log);
      } catch { /* không log được vẫn chạy tiếp */ }
      let child;
      try {
        child = spawnFn(config.opencodeBin, args, {
          cwd: config.opencodeProjectDir,
          detached: true,
          env: process.env,
          shell: process.platform === 'win32',
          stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
          windowsHide: true
        });
      } catch (e) {
        if (logFd !== null) closeFD(logFd);
        throw new Error(`Không spawn được opencode (${String(e?.message ?? e)}). ${manualHint(port)}`);
      }
      if (logFd !== null) closeFD(logFd);
      if (child && typeof child.unref === 'function') child.unref();
      // Tránh crash khi tiến trình con lỗi bất đồng bộ; poll health sẽ quyết định.
      if (child && typeof child.once === 'function') child.once('error', () => {});
      const server = { exited: null, log };
      if (child && typeof child.once === 'function') {
        child.once('exit', (code) => {
          server.exited = code ?? 1;
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!(await pollUntilUp(server))) {
        const tail = readLogTail(log);
        throw new Error(`opencode chưa sẵn sàng sau 30s. ${portBusyHint(port, tail)}${tail ? `\nLog cuối:\n${tail}` : ''}`);
      }
      return 'OK';
    })().finally(() => {
      spawning = null;
    });
  }

  // Đã OK/UNAUTHORIZED thì không spawn. Lock chống bấm Có 2 lần.
  async function ensureServer() {
    const h = await healthCheck({ statusFn: healthFn });
    if (h === 'OK' || h === 'UNAUTHORIZED') return h;
    if (spawning) return spawning;
    spawning = doSpawn();
    return spawning;
  }

  return { ensureServer, health: () => healthCheck({ statusFn: healthFn }) };
}
