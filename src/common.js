import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TELEGRAM_LIMIT = 4000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_TASKS = 5000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..');

export function projectRoot() {
  return PROJECT_ROOT;
}

export function logDir() {
  return process.env.TELE_LOG_DIR || path.join(PROJECT_ROOT, 'logs');
}

export function logFile() {
  return path.join(logDir(), 'bot.log');
}

export function tasksFile() {
  return path.join(logDir(), 'tasks.json');
}

export function stateFile() {
  return path.join(logDir(), 'state.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---- Whitelist (message + callback_query) ----
export function senderId(ctx) {
  return ctx?.from?.id ?? ctx?.callbackQuery?.from?.id ?? ctx?.message?.from?.id;
}

export function isAllowed(ctx, allowedUsers) {
  const id = senderId(ctx);
  return Number.isInteger(id) && allowedUsers.has(id);
}

// ---- Che secret trước khi log/gửi ----
const SECRET_PATTERNS = [
  [/\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g, '[TOKEN ẨN]'],
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [ẨN]'],
  [/\bsk-[A-Za-z0-9]{10,}\b/g, '[KEY ẨN]'],
  [/\bghp_[A-Za-z0-9]{10,}\b/g, '[KEY ẨN]'],
  [/((?:password|passwd|pwd|token|secret|api[_-]?key))\s*([:=])\s*([^\s&;,'"]+)/gi, '$1$2[ẨN]']
];

export function maskSecrets(text) {
  let s = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

// ---- Cắt tin nhắn (không đoạn rỗng, cắt cả dòng đơn quá dài) ----
export function chunkText(text, limit = TELEGRAM_LIMIT) {
  const s = String(text ?? '');
  if (s.length === 0) return [];
  const out = [];
  for (const line of s.split('\n')) {
    if (line.length === 0) continue;
    for (let i = 0; i < line.length; i += limit) {
      const piece = line.slice(i, i + limit);
      if (piece.length > 0) out.push(piece);
    }
  }
  if (out.length === 0) return [];
  // Gom các đoạn ngắn liên tiếp cho đỡ vụn, không vượt limit
  const merged = [];
  let cur = '';
  for (const piece of out) {
    if (cur.length === 0) {
      cur = piece;
    } else if (cur.length + 1 + piece.length <= limit) {
      cur += '\n' + piece;
    } else {
      merged.push(cur);
      cur = piece;
    }
  }
  if (cur.length > 0) merged.push(cur);
  return merged;
}

export async function replyChunked(ctx, text) {
  const parts = chunkText(maskSecrets(text));
  if (parts.length === 0) return;
  for (const part of parts) await ctx.reply(part);
}

// Gọi Telegram có retry 1 lần khi gặp 429 retry_after (P2).
export async function telegramRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const m = /retry after (\d+)/i.exec(String(e?.message ?? e));
    if (m && /\b429\b|too many requests/i.test(String(e?.message ?? e))) {
      const waitMs = Number(m[1]) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      return await fn();
    }
    throw e;
  }
}

// ---- Log (che secret, xoay vòng > 1MB) ----
function rotateLogIfNeeded() {
  try {
    const dir = logDir();
    ensureDir(dir);
    const file = logFile();
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, file + '.1');
    }
  } catch { /* không chặn bot vì log */ }
}

export function logLine(level, msg) {
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(logFile(), `${new Date().toISOString()} [${level}] ${maskSecrets(msg)}\n`);
  } catch { /* bỏ qua */ }
}

// ---- Kho task (atomic, file hỏng đổi tên, tối đa 5000) ----
export function loadTasks() {
  try {
    ensureDir(logDir());
    const file = tasksFile();
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    try {
      const file = tasksFile();
      if (fs.existsSync(file)) {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      }
    } catch { /* bỏ qua */ }
    return [];
  }
}

export function saveTasksAtomic(tasks) {
  ensureDir(logDir());
  const file = tasksFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  fs.renameSync(tmp, file);
}

export function recordTask(entry) {
  let tasks = loadTasks();
  if (!Array.isArray(tasks)) tasks = [];
  tasks.push({ ts: new Date().toISOString(), ...entry });
  if (tasks.length > MAX_TASKS) tasks = tasks.slice(-MAX_TASKS);
  saveTasksAtomic(tasks);
}

export function countTasks(tasks, sinceTs = 0) {
  const rows = (Array.isArray(tasks) ? tasks : []).filter((t) => Date.parse(t.ts) >= sinceTs);
  // Đếm theo kind động: giữ các key cũ để tương thích, kind mới tự thêm.
  const by = { CODE: 0, MMO: 0, AIRDROP: 0, POWER: 0, REPORT: 0, OTHER: 0 };
  let done = 0;
  let error = 0;
  let cancelled = 0;
  let expired = 0;
  let timeout = 0;
  for (const t of rows) {
    const raw = String(t.kind || 'OTHER');
    const k = Object.prototype.hasOwnProperty.call(by, raw) ? raw : (/^[A-Z0-9_]{1,24}$/.test(raw) ? raw : 'OTHER');
    if (by[k] === undefined) by[k] = 0;
    by[k] += 1;
    if (t.status === 'DONE') done += 1;
    else if (t.status === 'ERROR') error += 1;
    else if (t.status === 'CANCELLED') cancelled += 1;
    else if (t.status === 'EXPIRED') expired += 1;
    else if (t.status === 'TIMEOUT') timeout += 1;
  }
  return { by, cancelled, done, error, expired, timeout, total: rows.length };
}

// ---- Hàng đợi tuần tự (có vị trí, abort, stop xóa hàng đợi) ----
// fn(api) với api = { setAbort(fn), get cancelled }
export function createTaskQueue() {
  const waiting = [];
  let running = null; // { abort: fn|null, settled: bool }
  let seq = 0;

  function pump() {
    if (running) return;
    const next = waiting.shift();
    if (!next) return;
    const current = { abort: null, settled: false };
    running = current;
    const api = {
      get cancelled() {
        return next.cancelled;
      },
      setAbort(fn) {
        current.abort = typeof fn === 'function' ? fn : null;
      }
    };
    Promise.resolve()
      .then(() => (next.cancelled ? { stopped: true } : next.fn(api)))
      .then(
        (v) => finish(next, null, v),
        (e) => finish(next, e)
      );
  }

  function finish(next, err, value) {
    if (running) running = null;
    if (err) next.reject(err);
    else next.resolve(value);
    pump();
  }

  return {
    get busy() {
      return running !== null;
    },
    enqueue(fn) {
      seq += 1;
      // Vị trí thật: số task đang chờ trước nó + task đang chạy (nếu có).
      // Rảnh -> 0 (chạy ngay, không báo xếp hàng); bận -> >=1.
      const position = waiting.length + (running ? 1 : 0);
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      waiting.push({ cancelled: false, fn, id: seq, reject, resolve });
      pump();
      return { position, promise };
    },
    get size() {
      return waiting.length + (running ? 1 : 0);
    },
    // /stop: abort task đang chạy + xóa hàng đợi. Lệnh mới sau đó vẫn chạy.
    stop() {
      let aborted = false;
      let cleared = 0;
      for (const w of waiting.splice(0)) {
        w.cancelled = true;
        cleared += 1;
        w.resolve({ stopped: true });
      }
      if (running && running.abort) {
        aborted = true;
        try {
          running.abort();
        } catch { /* bỏ qua */ }
      }
      return { aborted, cleared };
    },
    // /pause: abort lượt đang chạy, GIỮ nguyên hàng đợi (resume bằng Tiếp tục/text).
    pause() {
      let aborted = false;
      if (running && running.abort) {
        aborted = true;
        try {
          running.abort();
        } catch { /* bỏ qua */ }
      }
      return { aborted };
    }
  };
}
