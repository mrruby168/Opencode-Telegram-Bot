import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { InlineKeyboard } from 'grammy';
import { logLine, recordTask, replyChunked, senderId, telegramRetry } from './common.js';

export const CONFIRM_TTL_MS = 60_000;
const SYSTEM_SHUTDOWN = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'shutdown.exe'
);
// Mã exit shutdown.exe CHƯA xác minh bằng chạy thật (ràng buộc cấm chạy thật).
// Phân loại thận trọng: chỉ 0 = thành công chắc chắn; mã khác → ERROR kèm mã số,
// trừ 2 mã hệ thống Windows dưới đây được coi là benign NHƯNG vẫn hiện mã số.
const EXIT_ALREADY_SCHEDULED = 1191; // UNVERIFIED: ERROR_SHUTDOWN_IN_PROGRESS?
const EXIT_NOTHING_TO_CANCEL = 1116; // UNVERIFIED: ERROR_NO_SHUTDOWN_IN_PROGRESS?

function defaultExecFn(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, err, out: String(stdout ?? '') + String(stderr ?? '') });
    });
  });
}

async function clearButtons(ctx, chatId, messageId) {
  try {
    await telegramRetry(() => ctx.api.editMessageReplyMarkup(chatId, messageId, {}));
  } catch { /* nút đã mất hoặc không sửa được: bỏ qua */ }
}

// Delay tối thiểu cho tắt ngay: giữ cửa hủy /cancel_shutdown (review v2).
export const SHUTDOWN_NOW_DELAY_S = 30;
export const SHUTDOWN_AT_MIN = 1;
export const SHUTDOWN_AT_MAX = 480;

export function createPowerController({ execFn = defaultExecFn, onMenu = null, confirmTtlMs = CONFIRM_TTL_MS } = {}) {
  const pending = new Map(); // userId -> { nonce, chatId, messageId, expiresAt, timer, seconds, label }

  async function menu(ctx) {
    if (onMenu) await onMenu(ctx);
  }

  // Đặt hẹn tắt chung. seconds>0. busy=true: task AI đang chạy → cảnh báo mất tiến độ.
  async function scheduleShutdown(ctx, seconds, title, { busy = false } = {}) {
    const userId = senderId(ctx);
    const nonce = randomBytes(8).toString('hex');
    const old = pending.get(userId);
    if (old) clearTimeout(old.timer);

    const warn = busy ? '\nCẢNH BÁO: đang có task AI chạy — tắt máy sẽ mất tiến độ.' : '';
    const sent = await ctx.reply(`Xác nhận ${title}?\nBấm YES trong 60 giây.${warn}`, {
      reply_markup: new InlineKeyboard()
        .text('YES - Tắt máy', `pw:yes:${nonce}`)
        .text('NO - Hủy', `pw:no:${nonce}`)
    });
    const record = {
      chatId: sent.chat.id,
      expiresAt: Date.now() + confirmTtlMs,
      label: title,
      messageId: sent.message_id,
      nonce,
      seconds,
      timer: null
    };
    record.timer = setTimeout(async () => {
      if (pending.get(userId)?.nonce === nonce) {
        pending.delete(userId);
        try {
          await telegramRetry(() => ctx.api.editMessageText(record.chatId, record.messageId, 'Hết hạn xác nhận shutdown (60 giây).'));
        } catch {}
        recordTask({ cmd: '/shutdown', kind: 'POWER', status: 'EXPIRED', note: 'confirm expired' });
      }
    }, confirmTtlMs + 500);
    if (typeof record.timer.unref === 'function') record.timer.unref();
    pending.set(userId, record);
    logLine('INFO', `shutdown pending user=${userId} msg=${sent.message_id}`);
  }

  // Giữ nguyên hành vi cũ: tắt sau 60s.
  async function cmdShutdown(ctx, opts = {}) {
    await scheduleShutdown(ctx, 60, 'TẮT MÁY sau 60s', opts);
  }

  // Tắt nhanh nhưng vẫn giữ cửa hủy: tối thiểu 30s.
  async function cmdShutdownNow(ctx, opts = {}) {
    await scheduleShutdown(ctx, SHUTDOWN_NOW_DELAY_S, `TẮT MÁY sau ${SHUTDOWN_NOW_DELAY_S}s`, opts);
  }

  // Hẹn giờ theo phút (1–480). Sai cú pháp → hướng dẫn, không làm gì.
  async function cmdShutdownAt(ctx, minutes, opts = {}) {
    const m = Number(minutes);
    if (!Number.isInteger(m) || m < SHUTDOWN_AT_MIN || m > SHUTDOWN_AT_MAX) {
      await replyChunked(
        ctx,
        `Số phút không hợp lệ. Gõ /shutdown_at <số phút ${SHUTDOWN_AT_MIN}-${SHUTDOWN_AT_MAX}>, ví dụ /shutdown_at 30.`
      );
      return;
    }
    await scheduleShutdown(ctx, m * 60, `TẮT MÁY sau ${m} phút`, opts);
  }

  async function cmdCancelShutdown(ctx) {
    const { code } = await execFn(SYSTEM_SHUTDOWN, ['/a']);
    if (code === 0) {
      await replyChunked(ctx, 'Đã HỦY lệnh shutdown.');
      recordTask({ cmd: '/cancel_shutdown', kind: 'POWER', status: 'DONE', note: 'aborted' });
    } else if (code === EXIT_NOTHING_TO_CANCEL) {
      await replyChunked(ctx, 'Không có lệnh shutdown nào để hủy.');
      recordTask({ cmd: '/cancel_shutdown', kind: 'POWER', status: 'DONE', note: `exit ${code}` });
    } else {
      await replyChunked(ctx, `Hủy shutdown lỗi (mã ${code}).`);
      recordTask({ cmd: '/cancel_shutdown', kind: 'POWER', status: 'ERROR', note: `exit ${code}` });
    }
    await menu(ctx);
  }

  // Trả true nếu callback đã được xử lý ở đây (luôn answerCallbackQuery ở caller).
  async function handlePowerCallback(ctx, allowedUsers) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('pw:')) return false;
    try {
      await ctx.answerCallbackQuery();
    } catch { /* bỏ qua: nút không được quay mãi */ }
    const userId = senderId(ctx);
    if (!allowedUsers?.has?.(userId)) return true; // caller im lặng với người lạ
    const parts = data.split(':');
    const action = parts[1];
    const nonce = parts[2];
    // Claim + delete ĐỒNG BỘ trước mọi await (chống bấm 2 lần).
    const p = pending.get(userId);
    if (!p || p.nonce !== nonce) {
      await replyChunked(ctx, 'Xác nhận không hợp lệ hoặc đã hết hạn.');
      return true;
    }
    pending.delete(userId);
    clearTimeout(p.timer);
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (action !== 'yes' && action !== 'no') {
      await replyChunked(ctx, 'Lựa chọn không hợp lệ.');
      return true;
    }
    if (msgId !== p.messageId || Date.now() > p.expiresAt) {
      await clearButtons(ctx, p.chatId, p.messageId);
      await replyChunked(ctx, 'Đã HẾT HẠN xác nhận (60 giây).');
      recordTask({ cmd: '/shutdown', kind: 'POWER', status: 'EXPIRED', note: 'expired/wrong message' });
      await menu(ctx);
      return true;
    }
    await clearButtons(ctx, p.chatId, p.messageId);
    if (action === 'no') {
      await replyChunked(ctx, 'Đã HỦY shutdown.');
      recordTask({ cmd: '/shutdown', kind: 'POWER', status: 'CANCELLED', note: 'denied by user' });
      await menu(ctx);
      return true;
    }
    // action === 'yes' duy nhất được chạy shutdown.
    logLine('INFO', `shutdown YES user=${userId} nonce=${nonce}`);
    const secs = Number(p.seconds) > 0 ? Number(p.seconds) : 60;
    const { code } = await execFn(SYSTEM_SHUTDOWN, ['/s', '/t', String(secs)]);
    if (code === 0) {
      await replyChunked(ctx, `Đã đặt ${p.label || 'TẮT MÁY'}. Dùng /cancel_shutdown để hủy.`);
      recordTask({ cmd: '/shutdown', kind: 'POWER', status: 'DONE', note: `scheduled +${secs}s` });
    } else if (code === EXIT_ALREADY_SCHEDULED) {
      await replyChunked(ctx, 'Đã CÓ lệnh shutdown được đặt trước đó.');
      recordTask({ cmd: '/shutdown', kind: 'POWER', status: 'DONE', note: `exit ${code}` });
    } else {
      await replyChunked(ctx, `Đặt shutdown lỗi (mã ${code}).`);
      recordTask({ cmd: '/shutdown', kind: 'POWER', status: 'ERROR', note: `exit ${code}` });
    }
    await menu(ctx);
    return true;
  }

  function pendingSize() {
    return pending.size;
  }

  return { cmdCancelShutdown, cmdShutdown, cmdShutdownAt, cmdShutdownNow, handlePowerCallback, pendingSize };
}
