// MMO task discovery + prompt + pick registry + queue persistence.
// Nhiệm vụ duy nhất: liệt kê task folder, dựng prompt theo rule-mmo, giữ state chọn/chạy.
// Không gọi Telegram trực tiếp (router bọc), không đọc secret.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MMO_MODE_PREFIX = 'MMO:';
// Số lượt chạy tối đa cho 1 task (TIMEOUT nối tiếp). Quá thì dừng, báo user.
export const MAX_LEGS = 3;
// TTL của tin chọn task (khớp convo AWAIT_INPUT 30 phút).
export const TASK_PICK_TTL_MS = 30 * 60 * 1000;
export const MIN_TIMEOUT_MS = 30 * 1000;
export const MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export function mmoDirFor(projectDir, override) {
  const o = String(override || '').trim();
  if (o) return o;
  return `${String(projectDir || '')}\\MMO\\Mmo`;
}

export function mmoModeFor(folder) {
  return `${MMO_MODE_PREFIX}${folder}`;
}

export function folderOfMode(mode) {
  if (typeof mode !== 'string' || !mode.startsWith(MMO_MODE_PREFIX)) return null;
  const f = mode.slice(MMO_MODE_PREFIX.length);
  return f ? f : null;
}

// Task folder = thư mục con (trừ Rule) có task/task.md. Không suy diễn từ tên.
export function scanMmoTasks(mmoDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(mmoDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'Rule') continue;
    try {
      const st = fs.statSync(path.join(mmoDir, e.name, 'task', 'task.md'));
      if (st.isFile()) out.push(e.name);
    } catch {
      // Không phải task folder: bỏ qua, không báo lỗi.
    }
  }
  out.sort();
  return out;
}

// Cấu hình machine-readable tùy chọn: <task>/task/bot.json {type, timeoutMs}.
// Không parse Markdown để suy timeout (giòn khi format đổi).
export function readTaskBotConfig(taskDir) {
  try {
    const raw = fs.readFileSync(path.join(taskDir, 'task', 'bot.json'), 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return {};
    const out = {};
    if (['normal', 'code', 'automation'].includes(String(j.type))) out.type = String(j.type);
    const t = Number(j.timeoutMs);
    if (Number.isInteger(t) && t >= MIN_TIMEOUT_MS && t <= MAX_TIMEOUT_MS) out.timeoutMs = t;
    return out;
  } catch {
    return {};
  }
}

// Code 60p, task khác 30p (theo yêu cầu user). Chưa rõ type → trần an toàn 60p.
export function resolveTaskTimeout(taskDir, cfg = {}) {
  const bot = readTaskBotConfig(taskDir);
  if (bot.timeoutMs) return bot.timeoutMs;
  const code = Number(cfg.mmoCodeTimeoutMs) > 0 ? Number(cfg.mmoCodeTimeoutMs) : 60 * 60 * 1000;
  const other = Number(cfg.mmoTaskTimeoutMs) > 0 ? Number(cfg.mmoTaskTimeoutMs) : 30 * 60 * 1000;
  if (bot.type === 'code') return code;
  if (bot.type === 'normal' || bot.type === 'automation') return other;
  return code;
}

export function buildTaskPrompt({ projectDir, mmoDir, folder, userText, leg = 1, maxLegs = MAX_LEGS }) {
  const dir = String(projectDir || '');
  const taskDir = `${mmoDir}\\${folder}`;
  const resume = leg > 1
    ? ` Đây là lượt chạy tiếp theo (${leg}/${maxLegs}): đọc lại plan/plan.md và progress/progress.md thực tế trong task folder, tiếp tục đúng chỗ dở, không làm lại từ đầu, không bịa tiến độ, không đánh completed khi chưa verify thật.`
    : '';
  return (
    `[TELE/TASK:${folder}] (lượt ${leg}/${maxLegs}) Task folder đã chọn: ${taskDir}. ` +
    `Bỏ qua bước liệt kê và chờ user chọn task (B0) của rule MMO — chạy ngay folder này. ` +
    `Đọc ${dir}\\AGENTS.md và ${dir}\\MMO\\Mmo\\Rule\\rule-mmo.md trước, ` +
    `rồi đọc ${taskDir}\\task\\task.md, ${taskDir}\\skill\\skill.md (nếu có), ` +
    `${taskDir}\\plan\\plan.md và ${taskDir}\\progress\\progress.md (nếu có) ` +
    `để xác định Flow A/B, phân loại task type, rồi thực thi đúng MMO-EXECUTION-CORE.` +
    resume +
    ` Yêu cầu thêm: ${userText} ` +
    `Cập nhật plan/progress sau mỗi phần việc lớn. ` +
    `Trả lời ngắn gọn plain text, không ký hiệu markdown.`
  );
}

// Registry chọn task single: bấm nút task -> xác minh OK/Cancel.
// nonce ngắn (callback ≤64B), snapshot chống rescan lệch, idempotent
// (bấm OK 2 lần chỉ chạy 1 lần; nút cũ báo rõ thay vì im lặng).
export function createTaskPickRegistry({ ttlMs = TASK_PICK_TTL_MS } = {}) {
  const picks = new Map(); // nonce -> rec

  function arm(rec) {
    rec.timer = setTimeout(() => {
      if (picks.get(rec.nonce) === rec) picks.delete(rec.nonce);
    }, ttlMs);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();
  }

  function open({ folders, userId }) {
    const nonce = randomBytes(6).toString('hex');
    const rec = {
      done: new Set(),
      expiresAt: Date.now() + ttlMs,
      folders: [...folders],
      nonce,
      pending: null, // folders chờ xác minh OK (sau khi nhập STT đúng)
      timer: null,
      userId
    };
    arm(rec);
    picks.set(nonce, rec);
    return rec;
  }

  function check(nonce, userId) {
    const rec = picks.get(nonce);
    if (!rec) return { ok: false, reason: 'expired' };
    if (rec.userId !== userId) return { ok: false, reason: 'stranger' };
    if (Date.now() > rec.expiresAt) {
      picks.delete(nonce);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, rec };
  }

  // Bấm nút task -> lưu pending để chờ OK. Bấm task khác thì thay thế pending cũ.
  function runPicked(nonce, index, userId) {
    const c = check(nonce, userId);
    if (!c.ok) return c;
    if (c.rec.done.has('ok')) return { ok: false, reason: 'dup' };
    if (!Number.isInteger(index) || index < 0 || index >= c.rec.folders.length) {
      return { ok: false, reason: 'invalid' };
    }
    const folder = c.rec.folders[index];
    c.rec.pending = folder;
    return { ok: true, folder };
  }

  // OK — one-shot: bấm 2 lần chỉ chạy 1 lần. Giữ tombstone tới hết TTL
  // để lần 2 trả `dup` (phân biệt với hết hạn thật).
  function confirmOk(nonce, userId) {
    const c = check(nonce, userId);
    if (!c.ok) return c;
    if (c.rec.done.has('ok')) return { ok: false, reason: 'dup' };
    if (!c.rec.pending) return { ok: false, reason: 'nopending' };
    c.rec.done.add('ok');
    return { ok: true, folder: c.rec.pending };
  }

  // Cancel — xóa pending, giữ rec để bấm task khác (tới hết TTL).
  function confirmCancel(nonce, userId) {
    const c = check(nonce, userId);
    if (!c.ok) return c;
    if (c.rec.done.has('ok')) return { ok: false, reason: 'dup' };
    c.rec.pending = null;
    return { ok: true };
  }

  function cancel(nonce, userId) {
    const c = check(nonce, userId);
    if (!c.ok) return c;
    if (c.rec.done.has('ok')) return { ok: false, reason: 'dup' };
    clearTimeout(c.rec.timer);
    picks.delete(nonce);
    return { ok: true };
  }

  // Đọc snapshot/khả dụng mà không claim (để parse STT theo đúng list đã gửi).
  function peek(nonce, userId) {
    return check(nonce, userId);
  }

  return { cancel, confirmCancel, confirmOk, open, peek, runPicked, size: () => picks.size };
}

// Registry lượt chạy (Tiếp tục / Bỏ qua / Dừng): TTL + idempotent từng action.
export function createMmoRunRegistry({ ttlMs = TASK_PICK_TTL_MS } = {}) {
  const runs = new Map(); // nonce -> rec

  function open({ userId, folders, idx = 0 }) {
    const nonce = randomBytes(6).toString('hex');
    const rec = {
      done: new Set(),
      expiresAt: Date.now() + ttlMs,
      folders: [...folders],
      idx,
      legs: {},
      nonce,
      sessions: {},
      timer: null,
      userId
    };
    rec.timer = setTimeout(() => {
      if (runs.get(nonce) === rec) runs.delete(nonce);
    }, ttlMs);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();
    runs.set(nonce, rec);
    return rec;
  }

  function get(nonce, userId) {
    const rec = runs.get(nonce);
    if (!rec) return { ok: false, reason: 'expired' };
    if (rec.userId !== userId) return { ok: false, reason: 'stranger' };
    if (Date.now() > rec.expiresAt) {
      runs.delete(nonce);
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, rec };
  }

  // Claim 1 action duy nhất cho 1 nonce (chống double-tap Tiếp tục).
  function claim(nonce, action, userId) {
    const c = get(nonce, userId);
    if (!c.ok) return c;
    if (c.rec.done.has(action)) return { ok: false, reason: 'dup' };
    c.rec.done.add(action);
    return { ok: true, rec: c.rec };
  }

  function close(nonce) {
    const rec = runs.get(nonce);
    if (rec) clearTimeout(rec.timer);
    runs.delete(nonce);
  }

  return { claim, close, get, open, size: () => runs.size };
}

// Bàn phím xác minh sau khi bấm nút task: [OK] [Cancel].
export function taskConfirmKeyboard(nonce) {
  return {
    inline_keyboard: [[
      { callback_data: `cf:${nonce}:ok`, text: 'OK' },
      { callback_data: `cf:${nonce}:cancel`, text: 'Cancel' }
    ]]
  };
}

// Bàn phím list task: mỗi task 1 nút, mỗi nút 1 hàng, text = tên folder.
export function taskListKeyboard(nonce, folders) {
  return {
    inline_keyboard: (folders || []).map((f, i) => ([
      { callback_data: `tk:${nonce}:${i}`, text: String(f) }
    ]))
  };
}

// withCont=false khi đã hết leg: chỉ còn Bỏ qua / Dừng.
export function taskRunKeyboard(nonce, withCont = true) {
  const row1 = withCont
    ? [
      { callback_data: `tm:${nonce}:cont`, text: 'Tiếp tục' },
      { callback_data: `tm:${nonce}:skip`, text: 'Bỏ qua task' }
    ]
    : [{ callback_data: `tm:${nonce}:skip`, text: 'Bỏ qua task' }];
  return {
    inline_keyboard: [row1, [{ callback_data: `tm:${nonce}:stop`, text: 'Dừng hết' }]]
  };
}

// ---- Persist hàng đợi multi-task (atomic). Restart bot → INTERRUPTED ----
export function mmoQueueFile(dir) {
  return path.join(dir || '.', 'mmo-queue.json');
}

export function loadMmoQueue(dir) {
  try {
    const raw = fs.readFileSync(mmoQueueFile(dir), 'utf8');
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function saveMmoQueueAtomic(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const file = mmoQueueFile(dir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, file);
}

export function upsertMmoQueueRow(dir, row) {
  const rows = loadMmoQueue(dir).filter((r) => r && r.nonce !== row.nonce);
  rows.push({ ...row, updatedAt: new Date().toISOString() });
  while (rows.length > 200) rows.shift();
  saveMmoQueueAtomic(dir, rows);
}

export function removeMmoQueueRow(dir, nonce) {
  saveMmoQueueAtomic(dir, loadMmoQueue(dir).filter((r) => r && r.nonce !== nonce));
}

export function markInterrupted(dir) {
  const rows = loadMmoQueue(dir);
  let count = 0;
  for (const r of rows) {
    if (r && (r.status === 'running' || r.status === 'pending')) {
      r.status = 'INTERRUPTED';
      count += 1;
    }
  }
  if (count > 0) saveMmoQueueAtomic(dir, rows);
  return { count, rows: rows.filter((r) => r && r.status === 'INTERRUPTED') };
}
