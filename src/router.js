import { InlineKeyboard } from 'grammy';
import {
  chunkText,
  isAllowed,
  logDir,
  logLine,
  maskSecrets,
  recordTask,
  replyChunked,
  senderId,
  telegramRetry
} from './common.js';
import { createPowerController } from './power.js';
import { canAlways, createPermissionRegistry } from './permissions.js';
import {
  sendMainMenu,
  sendPcMenu
} from './menu.js';
import {
  MAX_LEGS,
  buildTaskPrompt,
  createMmoRunRegistry,
  createTaskPickRegistry,
  folderOfMode,
  loadMmoQueue,
  markInterrupted,
  mmoDirFor,
  mmoModeFor,
  removeMmoQueueRow,
  resolveTaskTimeout,
  scanMmoTasks,
  taskConfirmKeyboard,
  taskListKeyboard,
  upsertMmoQueueRow
} from './mmo-tasks.js';
import { createScreenshotService } from './screenshot.js';

export const MODES = ['TASK', 'PC'];

// Sender gom Telegram I/O cho 1 task (streaming edit + chốt kết quả).
// Mọi cuộc gọi Telegram đều có timeout: mạng Telegram treo không được giữ task/opencode.
export const SENDER_SEND_TIMEOUT_MS = 20000;

function telegramWithTimeout(promise, label, ms = SENDER_SEND_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`telegram ${label} timeout after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createSender(ctx, { sendTimeoutMs = SENDER_SEND_TIMEOUT_MS } = {}) {
  let chatId = null;
  let msgId = null;
  const retryRef = { chatId: null, msgId: null };
  const tw = (p, label) => telegramWithTimeout(p, label, sendTimeoutMs);
  async function send(text, keyboard = null) {
    const m = await tw(telegramRetry(() => ctx.reply(text, keyboard ? { reply_markup: keyboard } : {})), 'send');
    if (chatId === null) {
      chatId = m.chat.id;
      msgId = m.message_id;
    }
    return m;
  }
  return {
    chat: () => ({ chatId, msgId }),
    async sendFinal(text, keyboard) {
      // Chống lặp kết quả: xóa tin tiến trình "Đang xử lý…" trước khi đăng kết quả.
      if (chatId !== null && msgId !== null) {
        const c = chatId;
        const m = msgId;
        chatId = null;
        msgId = null;
        try {
          await tw(telegramRetry(() => ctx.api.deleteMessage(c, m)), 'delete-progress');
        } catch (e) {
          logLine('WARN', `delete progress failed: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
      const parts = chunkText(maskSecrets(text));
      if (parts.length === 0) {
        await send('(không có nội dung text)', keyboard);
        return;
      }
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        await send(parts[i], last ? keyboard : null);
      }
    },
    async sendInitial() {
      await send('Đang xử lý…');
    },
    async sendRaw(text, keyboard = null) {
      await send(text, keyboard);
    },
    async retryNotice(attempt, message) {
      // Một tin duy nhất, sửa lại mỗi lần retry (không spam).
      const text = maskSecrets(`Model đang thử lại (lần ${attempt}): ${message || ''}`).slice(0, 900);
      const kb = { inline_keyboard: [[{ callback_data: 'go:stop-task', text: 'Dừng' }]] };
      if (retryRef.msgId === null) {
        const m = await send(text, kb);
        retryRef.chatId = m.chat.id;
        retryRef.msgId = m.message_id;
        return;
      }
      try {
        await tw(telegramRetry(() => ctx.api.editMessageText(retryRef.chatId, retryRef.msgId, text)), 'retry-edit');
      } catch (e) {
        if (!/not modified/i.test(String(e?.message ?? e))) {
          logLine('WARN', `retry edit failed: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    },
    async update(text, toolNote) {
      if (chatId === null || msgId === null) return;
      const body = chunkText(maskSecrets(text || 'Đang xử lý…'))[0] || 'Đang xử lý…';
      const shown = toolNote ? `${body}\n\n${maskSecrets(toolNote)}` : body;
      const cut = shown.length > 4000 ? shown.slice(0, 4000) : shown;
      try {
        await tw(telegramRetry(() => ctx.api.editMessageText(chatId, msgId, cut)), 'update');
      } catch (e) {
        if (!/not modified/i.test(String(e?.message ?? e))) {
          logLine('WARN', `editMessage failed: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    }
  };
}

export function createBotHandlers({ config, convo, runner, client, serverManager, sessionStore, power = null, screenshot = null }) {
  const powerCtl = power || createPowerController({ onMenu: (ctx) => sendMainMenu(ctx) });
  const shotSvc = screenshot || createScreenshotService();
  const questionWaiters = new Map(); // userId -> { nonce, resolve, sender, sessionId }
  const permRegistry = createPermissionRegistry({
    onExpire: ({ kind, sessionId, userId }) => {
      if (kind === 'question') {
        const qw = questionWaiters.get(userId);
        if (qw && qw.nonce) {
          questionWaiters.delete(userId);
          qw.resolve('');
          void qw.sender.sendRaw('Hết hạn trả lời câu hỏi của opencode.').catch(() => {});
        }
        return;
      }
      const w = waiters.get(`perm:${sessionId}`);
      if (w) {
        waiters.delete(`perm:${sessionId}`);
        w('reject');
      }
    },
    ttlMs: config.permissionTtlMs
  });
  const waiters = new Map(); // key -> resolve(action)
  const senders = new Map(); // userId -> sender
  // v2: chọn task (toggle) + lượt chạy multi (Tiếp tục/Bỏ qua/Dừng).
  const pickReg = createTaskPickRegistry({ ttlMs: 30 * 60 * 1000 });
  const runReg = createMmoRunRegistry({ ttlMs: 30 * 60 * 1000 });
  // Khóa nối tiếp callback theo user: Telegram/grammY không đảm bảo thứ tự xử lý
  // giữa 2 update liên tiếp (handler fire-and-forget), nhưng toggle→go BẮT BUỘC
  // đúng thứ tự (go đọc state mà toggle ghi). Không khóa chéo user khác.
  const userLocks = new Map(); // userId -> Promise đuôi hàng đợi
  function userChain(userId, fn) {
    const prev = userLocks.get(userId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    userLocks.set(userId, next.catch(() => {}));
    return next;
  }
  const seenCb = new Map(); // key callback -> timestamp (idempotent, chống double-tap)
  const mmoRunsByUser = new Map(); // userId -> Set<nonce>
  function onceCb(key) {
    if (seenCb.has(key)) return false;
    seenCb.set(key, Date.now());
    if (seenCb.size > 1000) {
      const [first] = seenCb.keys();
      seenCb.delete(first);
    }
    return true;
  }
  function trackMmoRun(userId, nonce) {
    let s = mmoRunsByUser.get(userId);
    if (!s) {
      s = new Set();
      mmoRunsByUser.set(userId, s);
    }
    s.add(nonce);
  }
  function closeMmoRun(userId, nonce) {
    runReg.close(nonce);
    try {
      removeMmoQueueRow(logDir(), nonce);
    } catch { /* không chặn bot vì log */ }
    const s = mmoRunsByUser.get(userId);
    if (s) {
      s.delete(nonce);
      if (s.size === 0) mmoRunsByUser.delete(userId);
    }
  }
  function closeAllMmoRuns(userId) {
    const s = mmoRunsByUser.get(userId);
    if (!s) return 0;
    let n = 0;
    for (const nonce of [...s]) {
      closeMmoRun(userId, nonce);
      n += 1;
    }
    return n;
  }
  // Restart bot: hàng multi-task dở dang → INTERRUPTED, không chạy tiếp trong im lặng.
  try {
    const { count } = markInterrupted(logDir());
    if (count > 0) logLine('WARN', `mmo-queue INTERRUPTED on boot: ${count}`);
  } catch { /* không chặn bot vì log */ }

  function convoMode(userId) {
    return convo.get(userId).mode;
  }

  async function answerCb(ctx, text = null) {
    try {
      await ctx.answerCallbackQuery(text ? { text } : {});
    } catch { /* bỏ qua */ }
  }

  // ---- Permission UI ----
  // Trả {nonce, promise}: promise resolve action cho runner; nonce để test/callback.
  async function askApproval({ userId, sessionId, permission, question, sender = senders.get(userId) }) {
    if (!sender) return { nonce: null, promise: Promise.resolve('reject') };
    if (question) {
      const q = permRegistry.askQuestion({ question, sessionId, userId });
      const rows = q.buttons.length > 0 ? [q.buttons] : [];
      try {
        await sender.sendRaw(q.text, rows.length > 0 ? { inline_keyboard: rows.map((r) => r.map((b) => ({ callback_data: b.data, text: b.text }))) } : null);
      } catch (e) {
        // Telegram gửi không được (treo/timeout): coi như hết hạn, task tiếp tục thay vì kẹt.
        logLine('WARN', `question ask send failed: ${String(e?.message ?? e).slice(0, 120)}`);
        return { nonce: q.nonce, promise: Promise.resolve('') };
      }
      // Bản gọn: có nút -> promise resolve label nút; không nút -> nhận text kế tiếp.
      const promise = new Promise((resolve) => {
        questionWaiters.set(userId, { hasButtons: q.buttons.length > 0, nonce: q.nonce, resolve, sender, sessionId });
      });
      return { nonce: q.nonce, promise };
    }
    const allowAlways = canAlways({ permission, projectDir: config.opencodeProjectDir });
    const { buttons, nonce, text } = permRegistry.ask({ allowAlways, permission, sessionId, userId });
    const rows = [buttons.slice(0, 2)];
    if (buttons.length > 2) rows.push(buttons.slice(2));
    try {
      await sender.sendRaw(text, {
        inline_keyboard: rows.map((r) => r.map((b) => ({ callback_data: b.data, text: b.text })))
      });
    } catch (e) {
      // Telegram gửi không được: từ chối an toàn, task tiếp tục thay vì kẹt chờ duyệt.
      logLine('WARN', `perm ask send failed: ${String(e?.message ?? e).slice(0, 120)}`);
      return { nonce, promise: Promise.resolve('reject') };
    }
    const promise = new Promise((resolve) => {
      waiters.set(`perm:${sessionId}`, (action) => resolve(action));
    });
    return { nonce, promise };
  }

  // Ẩn suy nghĩ AI (v4.2): không stream text dở vào Telegram.
  // Chỉ báo ⏳/✅/❌/⛔/🎯 qua sendRaw ở settle. Giữ hàm để wiring không vỡ.
  async function runnerOnText() {}

  async function runnerOnSilent({ userId }) {
    const sender = senders.get(userId);
    if (!sender) return;
    await sender.sendRaw('opencode đang im lặng quá 2 phút (không có event mới). Task vẫn đang chạy.', {
      inline_keyboard: [[{ callback_data: 'go:stop-task', text: 'Dừng' }]]
    });
  }

  async function runnerOnRetry({ userId, attempt, message }) {
    const sender = senders.get(userId);
    if (!sender) return;
    await sender.retryNotice(attempt ?? '?', message || '');
  }

  async function runnerOnPermission({ userId, sessionId, permission, question }) {
    const { promise } = await askApproval({ permission, question, sessionId, userId });
    return promise;
  }

  async function editAwayButtons(ctx, message) {
    try {
      await telegramRetry(() => ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {}));
    } catch { /* bỏ qua */ }
  }

  // Sửa nút an toàn: bỏ qua lỗi "not modified" do spam toggle/double-tap.
  async function safeEditReplyMarkup(ctx, chatId, messageId, keyboard) {
    try {
      await telegramRetry(() => ctx.api.editMessageReplyMarkup(chatId, messageId, keyboard || {}));
    } catch (e) {
      if (!/not modified/i.test(String(e?.message ?? e))) {
        logLine('WARN', `editMarkup failed: ${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  }

  async function handlePermCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('pm:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true; // im lặng
    const res = permRegistry.resolve({ allowedUsers: config.allowedUsers, data, userId });
    await editAwayButtons(ctx, ctx.callbackQuery.message);
    const w = res.sessionId ? waiters.get(`perm:${res.sessionId}`) : null;
    if (w) {
      waiters.delete(`perm:${res.sessionId}`);
      w(res.action);
    }
    return true;
  }

  async function handleQuestionCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('q:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    const res = permRegistry.resolveQuestion({ allowedUsers: config.allowedUsers, data, userId });
    const msg = ctx.callbackQuery.message;
    if (msg) await editAwayButtons(ctx, msg);
    const qw = questionWaiters.get(userId);
    if (qw && res.action === 'answer') {
      questionWaiters.delete(userId);
      qw.resolve(res.text || String(res.index + 1));
      await ctx.reply(`Đã gửi tới opencode: ${res.text || `lựa chọn ${res.index + 1}`}`);
    }
    return true;
  }

  // ---- Task MMO theo folder (v2, thay AIRDROP_NEWS) ----
  // Liệt kê mọi folder có task/task.md trong MMO/Mmo (trừ Rule), sort theo tên.
  function currentMmoDir() {
    return mmoDirFor(config.opencodeProjectDir, config.mmoDir);
  }

  // List single task: mỗi task 1 nút, bấm trực tiếp để chọn.
  // State PICK:<nonce> chạy trên convo AWAIT_INPUT nên TTL 30p áp dụng như cũ.
  async function showTaskList(ctx, userId) {
    const dir = currentMmoDir();
    const folders = scanMmoTasks(dir);
    if (folders.length === 0) {
      await ctx.reply(
        `Chưa có task nào trong ${dir}. Mỗi task là 1 folder có task/task.md (trừ folder Rule).`
      );
      return;
    }
    const rec = pickReg.open({ folders, userId });
    convo.set(userId, 'AWAIT_INPUT', `PICK:${rec.nonce}`);
    await ctx.reply('Bạn hãy chọn task cần thực thi', {
      reply_markup: taskListKeyboard(rec.nonce, folders)
    });
  }

  function pickNonceOf(st) {
    if (st && st.status === 'AWAIT_INPUT' && typeof st.mode === 'string' && st.mode.startsWith('PICK:')) {
      const n = st.mode.slice('PICK:'.length);
      return n || null;
    }
    return null;
  }

  // Bấm nút task -> lưu pending + hỏi xác minh 1 lần (OK / Cancel).
  async function handleTaskButton(ctx, userId, nonce, index) {
    const peeked = pickReg.peek(nonce, userId);
    if (!peeked.ok) {
      await ctx.reply('Lựa chọn đã hết hạn, bấm TASK để chọn lại.');
      return;
    }
    const r = pickReg.runPicked(nonce, index, userId);
    if (!r.ok) {
      if (r.reason === 'stranger') await ctx.reply('Lựa chọn này không dành cho bạn.');
      else await ctx.reply('Lựa chọn đã hết hạn, bấm TASK để chọn lại.');
      return;
    }
    await ctx.reply(`Xác nhận thực thi ${r.folder} ?`, {
      reply_markup: taskConfirmKeyboard(nonce)
    });
  }

  // Bắt đầu 1 task single. Timeout riêng theo bot.json/type.
  async function startMmoRun(ctx, userId, folders, userText) {
    const rec = runReg.open({ folders, userId });
    rec.done = [];
    rec.failed = [];
    trackMmoRun(userId, rec.nonce);
    upsertMmoQueueRow(logDir(), { folders, idx: 0, nonce: rec.nonce, status: 'running', userId });
    convo.set(userId, 'RUNNING', mmoModeFor(folders[0]));
    const sender = createSender(ctx);
    senders.set(userId, sender);
    await runMmoLeg({ ctx, folder: folders[0], leg: 1, nonce: rec.nonce, rec, sender, userId, userText });
  }

  async function runMmoLeg({ announce = null, ctx, folder, leg, nonce, rec, sender, userId, userText, sessionId = null }) {
    const dir = currentMmoDir();
    const taskDir = `${dir}\\${folder}`;
    const timeoutMs = resolveTaskTimeout(taskDir, config);
    const promptText = buildTaskPrompt({
      folder,
      leg,
      maxLegs: MAX_LEGS,
      mmoDir: dir,
      projectDir: config.opencodeProjectDir,
      userText
    });
    const mode = mmoModeFor(folder);
    rec.legs[folder] = leg;
    if (sessionId) rec.sessions[folder] = sessionId;
    await sender.sendRaw(announce !== null ? announce : `⏳ do task ${folder}`);
    const { position, promise } = runner.submit({
      mode,
      promptText,
      sessionId: sessionId || rec.sessions[folder] || null,
      timeoutMs,
      userId
    });
    if (position > 0) {
      await sender.sendRaw(`Đã xếp hàng (vị trí ${position}).`);
    }
    promise.then(
      async (res) => settleMmoLeg({ ctx, folder, leg, nonce, rec, res, sender, userId }),
      async (e) => {
        senders.delete(userId);
        recordTask({ cmd: '/tasks', kind: 'MMO', note: `${folder}: ${String(e?.message ?? e).slice(0, 200)}`, status: 'ERROR' });
        closeMmoRun(userId, nonce);
        convo.set(userId, 'IDLE');
        await sender.sendRaw(`❌ Lỗi ${shortErr(e?.message ?? e)}`);
        await sender.sendRaw(`⛔ ${folder} stop`);
        await sendMainMenu(ctx);
      }
    ).catch((e) => logLine('ERROR', `mmo settle: ${String(e?.message ?? e).slice(0, 120)}`));
  }

  // Lỗi rút gọn 1 dòng cho notify (đã che secret).
  function shortErr(e) {
    const s = maskSecrets(String(e ?? '').split('\n')[0]).slice(0, 200).trim();
    return s || 'không rõ';
  }

  // Notify gọn v4.2 (ẩn suy nghĩ AI): ⏳ start → ✅ Done | ❌ + ⛔ → 🎯 tổng kết.
  // Multi lỗi 1 task → skip task đó, chuyển task tiếp theo (không dừng cả hàng).
  async function settleMmoLeg({ ctx, folder, leg, nonce, rec, res, sender, userId }) {
    const mode = mmoModeFor(folder);
    const got = runReg.get(nonce, userId);
    if (!got.ok) {
      // Run đã đóng (stop/hết hạn): bỏ kết quả đến muộn.
      senders.delete(userId);
      return;
    }
    const single = rec.folders.length === 1;
    if (res.stopped === true) {
      senders.delete(userId);
      recordTask({ cmd: '/tasks', kind: 'MMO', note: `${folder} (chờ chạy)`, status: 'CANCELLED' });
      closeMmoRun(userId, nonce);
      convo.set(userId, 'IDLE');
      await sender.sendRaw(`⛔ ${folder} stop`);
      await sendMainMenu(ctx);
      return;
    }
    if (res.status === 'ABORTED') {
      senders.delete(userId);
      recordTask({ cmd: '/tasks', kind: 'MMO', note: folder, status: 'CANCELLED' });
      closeMmoRun(userId, nonce);
      convo.set(userId, 'IDLE');
      await sender.sendRaw(`⛔ ${folder} stop`);
      await sendMainMenu(ctx);
      return;
    }
    if (res.status === 'DONE') {
      if (res.sessionId) rec.sessions[folder] = res.sessionId;
      recordTask({ cmd: '/tasks', kind: 'MMO', note: folder, status: 'DONE' });
      rec.done.push(folder);
      await sender.sendRaw(`✅ ${folder} Done`);
      return advanceMmoRun({ ctx, nonce, rec, sender, userId });
    }
    // ERROR / TIMEOUT. TIMEOUT còn lượt → tự chạy lại cùng session (không hỏi).
    // Hết lượt hoặc ERROR → ghi lỗi gọn, skip sang task tiếp theo (multi) / end (single).
    const isTimeout = res.status === 'TIMEOUT';
    if (res.sessionId) rec.sessions[folder] = res.sessionId;
    if (isTimeout && leg < MAX_LEGS) {
      recordTask({ cmd: '/tasks', kind: 'MMO', note: `${folder}: timeout lượt ${leg}`, status: 'TIMEOUT' });
      convo.set(userId, 'RUNNING', mode);
      await runMmoLeg({
        announce: `⏳ ${folder} hết giờ, tự chạy lại (lượt ${leg + 1}/${MAX_LEGS})`,
        ctx,
        folder,
        leg: leg + 1,
        nonce,
        rec,
        sender,
        sessionId: rec.sessions[folder] || null,
        userId,
        userText: 'Tiếp tục đúng chỗ dở theo progress thực tế trong task folder.'
      });
      return;
    }
    const err = isTimeout ? `Hết giờ ${MAX_LEGS} lượt` : `Lỗi ${shortErr(res.error || res.status)}`;
    recordTask({ cmd: '/tasks', kind: 'MMO', note: `${folder}: ${err}`.slice(0, 200), status: isTimeout ? 'TIMEOUT' : 'ERROR' });
    rec.failed.push({ error: err, folder });
    convo.set(userId, 'AWAIT_INPUT', mode);
    await sender.sendRaw(`❌ ${err}`);
    await sender.sendRaw(single ? `⛔ ${folder} stop — check lỗi và thử lại` : `⛔ ${folder} stop`);
    return advanceMmoRun({ ctx, nonce, rec, sender, userId });
  }

  // Auto về menu khi lượt chạy kết thúc (xong hết hoặc lỗi cuối).
  async function advanceMmoRun({ ctx, nonce, rec, sender, userId }) {
    const nextIdx = rec.idx + 1;
    if (nextIdx >= rec.folders.length) {
      // Hết hàng: tổng kết gọn rồi tự về menu chính.
      senders.delete(userId);
      closeMmoRun(userId, nonce);
      convo.set(userId, 'IDLE');
      if (rec.folders.length > 1) {
        if (rec.failed.length === 0) {
          await sender.sendRaw('🎯 đã hoàn thành tất cả task yêu cầu');
        } else {
          const doneNames = rec.done.join(', ') || '—';
          const failLines = rec.failed.map((f) => `❌ ${f.folder} lỗi ${f.error}`).join('\n');
          await sender.sendRaw(`🎯 đã hoàn thành task ${doneNames}\n${failLines}`);
        }
      }
      await sendMainMenu(ctx);
      return;
    }
    rec.idx = nextIdx;
    upsertMmoQueueRow(logDir(), { folders: rec.folders, idx: nextIdx, nonce, status: 'running', userId });
    const folder = rec.folders[nextIdx];
    convo.set(userId, 'RUNNING', mmoModeFor(folder));
    await runMmoLeg({ ctx, folder, leg: 1, nonce, rec, sender, userId, userText: 'Thực thi theo đúng rule của task.' });
  }

  // Bấm nút task ở tin list: tk:<nonce>:<idx> (mỗi task 1 nút).
  async function handleTaskPickCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('tk:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    const m = /^tk:([0-9a-f]+):(\d+)$/.exec(data);
    if (!m) return true;
    const [, nonce, idx] = m;
    const msg = ctx.callbackQuery.message;
    const msgKey = msg ? `${msg.chat.id}:${msg.message_id}` : 'nomsg';
    if (!onceCb(`tk:${nonce}:${idx}:${msgKey}:${userId}`)) return true; // double-tap cùng tin
    if (msg) await safeEditReplyMarkup(ctx, msg.chat.id, msg.message_id, {});
    await handleTaskButton(ctx, userId, nonce, Number(idx));
    return true;
  }

  // Xác minh sau bấm nút task: cf:<nonce>:ok (chạy) | cf:<nonce>:cancel (hủy, về list task).
  async function handleTaskConfirmCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('cf:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    const m = /^cf:([0-9a-f]+):(ok|cancel)$/.exec(data);
    if (!m) return true;
    const [, nonce, act] = m;
    const msg = ctx.callbackQuery.message;
    const msgKey = msg ? `${msg.chat.id}:${msg.message_id}` : 'nomsg';
    if (!onceCb(`cf:${nonce}:${act}:${msgKey}:${userId}`)) return true; // double-tap cùng tin
    if (act === 'cancel') {
      const r = pickReg.confirmCancel(nonce, userId);
      if (!r.ok) {
        await ctx.reply(r.reason === 'stranger' ? 'Nút này không dành cho bạn.' : 'Lựa chọn đã hết hạn, bấm TASK để chọn lại.');
        return true;
      }
      if (msg) await safeEditReplyMarkup(ctx, msg.chat.id, msg.message_id, {});
      await showTaskList(ctx, userId);
      return true;
    }
    // ok — one-shot qua registry (bấm 2 lần chỉ chạy 1 lần).
    const r = pickReg.confirmOk(nonce, userId);
    if (!r.ok) {
      if (r.reason === 'stranger') await ctx.reply('Nút này không dành cho bạn.');
      else if (r.reason === 'dup') await ctx.reply('Đã bấm OK rồi, task đang chạy.');
      else if (r.reason === 'nopending') await ctx.reply('Chưa có lựa chọn nào. Bấm 1 task ở trên trước.');
      else await ctx.reply('Lựa chọn đã hết hạn, bấm TASK để chọn lại.');
      return true;
    }
    if (msg) await safeEditReplyMarkup(ctx, msg.chat.id, msg.message_id, {});
    await startMmoRun(ctx, userId, [r.folder], 'Thực thi theo đúng rule của task.');
    return true;
  }

  // ---- Menu / text ----
  async function toMenu(ctx, userId) {
    convo.set(userId, 'IDLE');
    await sendMainMenu(ctx);
  }

  async function handleMenuCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('menu:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    const key = data.slice(5);
    if (key === 'task') {
      await showTaskList(ctx, userId);
      return true;
    }
    if (key === 'pc') {
      await sendPcMenu(ctx);
      return true;
    }
    return true;
  }

  async function handleGoCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('go:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    const [, what, ...rest] = data.split(':');
    const arg = rest.join(':');
    if (what === 'menu') {
      await toMenu(ctx, userId);
      return true;
    }
    if (what === 'pc') {
      const busy = runner.queueSize(userId) > 0;
      if (arg === 'shutdown') {
        await powerCtl.cmdShutdown(ctx, { busy });
        return true;
      }
      if (arg === 'now') {
        await powerCtl.cmdShutdownNow(ctx, { busy });
        return true;
      }
      if (arg === 'at') {
        await ctx.reply('Gõ /shutdown_at <số phút 1-480>, ví dụ /shutdown_at 30.');
        return true;
      }
      if (arg === 'shot') {
        await shotSvc.handleScreenshot(ctx, config.allowedUsers);
        return true;
      }
      await sendPcMenu(ctx);
      return true;
    }
    if (what === 'stop-task') {
      await doStop(ctx, userId);
      return true;
    }
    return true;
  }

  async function handleText(ctx) {
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return; // im lặng
    convo.touch(userId); // giữ TTL hoạt động khi user còn nhắn
    const text = ctx.message?.text ?? '';
    // Text dạng lệnh (thiếu entity bot_command nên grammy không match bot.command):
    // không bao giờ đưa vào task — hiện lại menu để user bấm lệnh.
    if (text.trim().startsWith('/')) {
      await sendMainMenu(ctx);
      await ctx.reply('Đây là lệnh, hãy bấm lại từ menu hoặc gõ đúng lệnh (ví dụ /status, /start).');
      return;
    }
    // Câu hỏi opencode đang chờ: có nút -> nhắc bấm nút; không nút -> nhận text kế tiếp.
    const qw = questionWaiters.get(userId);
    if (qw) {
      if (qw.hasButtons) {
        await ctx.reply('Opencode đang chờ bạn chọn 1 nút ở trên.');
        return;
      }
      questionWaiters.delete(userId);
      qw.resolve(text);
      await ctx.reply(`Đã gửi tới opencode: ${text.slice(0, 200)}`);
      return;
    }
    const st = convo.get(userId);
    // Đang ở màn chọn task: text không có tác dụng, nhắc bấm nút task.
    const pickNonce = pickNonceOf(st);
    if (pickNonce) {
      await ctx.reply('Hãy bấm 1 task ở trên.');
      return;
    }
    if (st.status === 'IDLE') {
      await sendMainMenu(ctx);
      await ctx.reply('Chọn 1 mục trước.');
      return;
    }
    // AWAIT_INPUT hoặc RUNNING với task MMO: text = yêu cầu thêm cho task đó.
    const mmoFolder = st.mode ? folderOfMode(st.mode) : null;
    if (mmoFolder) {
      await startMmoRun(ctx, userId, [mmoFolder], text);
      return;
    }
    await sendMainMenu(ctx);
  }

  // ---- Lệnh ----
  async function handleStart(ctx) {
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return;
    const h = await serverManager.health();
    if (h === 'OK') {
      await ctx.reply('opencode đã bật');
      await toMenu(ctx, userId);
    } else if (h === 'UNAUTHORIZED') {
      await ctx.reply('Sai mật khẩu server, kiểm tra OPENCODE_SERVER_PASSWORD.');
    } else {
      serverPending.set(userId, true);
      await ctx.reply('opencode chưa bật, bật luôn không?', {
        reply_markup: new InlineKeyboard().text('Có, bật', 'sv:yes').text('Không', 'sv:no')
      });
    }
  }

  const serverPending = new Map(); // userId -> true

  async function handleServerCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('sv:')) return false;
    await answerCb(ctx);
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return true;
    if (!serverPending.get(userId)) return true;
    serverPending.delete(userId);
    try {
      await ctx.api.editMessageReplyMarkup(ctx.callbackQuery.message.chat.id, ctx.callbackQuery.message.message_id, {});
    } catch { /* bỏ qua */ }
    if (data === 'sv:no') {
      await ctx.reply('Chưa bật. Gõ /opencode khi cần.');
      return true;
    }
    await ctx.reply('Đang bật opencode…');
    try {
      await serverManager.ensureServer();
      await ctx.reply('opencode CLI đã bật');
      await toMenu(ctx, userId);
    } catch (e) {
      await ctx.reply(`Bật opencode lỗi: ${String(e?.message ?? e).slice(0, 500)}`);
    }
    return true;
  }

  async function doStop(ctx, userId) {
    const { aborted, cleared } = runner.stop(userId);
    const runs = closeAllMmoRuns(userId);
    recordTask({ cmd: '/stop', kind: 'OTHER', note: `aborted=${aborted} cleared=${cleared} mmoruns=${runs}`, status: 'DONE' });
    const mode = convoMode(userId);
    if (mode) convo.set(userId, 'AWAIT_INPUT', mode);
    else convo.set(userId, 'IDLE');
    await ctx.reply(`Đã dừng: abort=${aborted ? 'có' : 'không'}, xóa ${cleared} task chờ.`);
  }

  async function handleStop(ctx) {
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return;
    await doStop(ctx, userId);
  }

  async function handleNew(ctx) {
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return;
    const mode = convoMode(userId);
    if (mode && sessionStore) sessionStore.clear(mode);
    await ctx.reply(mode ? `Đã tạo phiên mới cho ${mode}.` : 'Chọn 1 mục trước.');
  }

  async function handleStatus(ctx) {
    const userId = senderId(ctx);
    if (!isAllowed(ctx, config.allowedUsers)) return;
    const st = convo.get(userId);
    const h = await serverManager.health();
    const lines = [
      `Bot: ${runner.queueSize(userId) > 0 ? 'bận' : 'rảnh'}`,
      `Mode: ${st.mode || '—'}`,
      `Hàng đợi: ${runner.queueSize(userId)}`,
      `opencode: ${h}`
    ];
    await replyChunked(ctx, lines.join('\n'));
    if (h !== 'OK' && h !== 'UNAUTHORIZED') {
      serverPending.set(userId, true);
      await ctx.reply('opencode chưa bật, bật luôn không?', {
        reply_markup: new InlineKeyboard().text('Có, bật', 'sv:yes').text('Không', 'sv:no')
      });
    }
  }

  function register(bot) {
    bot.command('start', (ctx) => void handleStart(ctx).catch((e) => logLine('ERROR', String(e?.message ?? e).slice(0, 120))));
    bot.command('status', (ctx) => void handleStatus(ctx).catch(() => {}));
    bot.command('stop', (ctx) => void handleStop(ctx).catch(() => {}));
    bot.command('new', (ctx) => void handleNew(ctx).catch(() => {}));
    bot.on('message:text', (ctx) => void handleText(ctx).catch((e) => logLine('ERROR', String(e?.message ?? e).slice(0, 120))));
    bot.on('callback_query:data', (ctx) => {
      void (async () => {
        if (await powerCtl.handlePowerCallback(ctx, config.allowedUsers)) return;
        if (await shotSvc.handleFileCallback(ctx, config.allowedUsers)) return;
        if (await handlePermCallback(ctx)) return;
        if (await handleQuestionCallback(ctx)) return;
        if (await handleMenuCallback(ctx)) return;
        if (await handleGoCallback(ctx)) return;
        if (await handleServerCallback(ctx)) return;
        // tk:/cf: đi qua khóa user để giữ thứ tự xử lý cùng user.
        if (await userChain(senderId(ctx), () => handleTaskPickCallback(ctx))) return;
        if (await userChain(senderId(ctx), () => handleTaskConfirmCallback(ctx))) return;
        await answerCb(ctx);
      })().catch((e) => logLine('ERROR', String(e?.message ?? e).slice(0, 120)));
    });
  }

  return {
    askApproval,
    handleGoCallback,
    handleMenuCallback,
    handleNew,
    handlePermCallback,
    handleQuestionCallback,
    handleServerCallback,
    handleStart,
    handleStatus,
    handleStop,
    handleTaskConfirmCallback,
    handleTaskPickCallback,
    handleText,
    register,
    runnerOnPermission,
    runnerOnSilent,
    runnerOnRetry,
    runnerOnText,
    showTaskList,
    startMmoRun
  };
}
