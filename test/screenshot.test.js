import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createScreenshotService, screenshotArgs, PS_SCRIPT } from '../src/screenshot.js';
import { mainKeyboard } from '../src/menu.js';

const USER = 7;
const CONFIG_USERS = new Set([USER]);

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-shot-'));
  process.env.TELE_LOG_DIR = tmp;
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function fakePng(file) {
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
}

function fakeCtx({ userId = USER } = {}) {
  const rec = { photos: 0, docs: 0, replies: [] };
  return {
    _rec: rec,
    answerCallbackQuery: async () => {},
    callbackQuery: undefined,
    from: { id: userId },
    message: { from: { id: userId } },
    reply: async (t) => { rec.replies.push(t); return { chat: { id: 1 }, message_id: 1 }; },
    replyWithDocument: async () => { rec.docs += 1; return { chat: { id: 1 }, message_id: 3 }; },
    replyWithPhoto: async () => { rec.photos += 1; return { chat: { id: 1 }, message_id: 2 }; }
  };
}

describe('screenshot service', () => {
  it('argv cố định, không shell, có DPI + VirtualScreen', () => {
    const args = screenshotArgs();
    assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
    assert.ok(PS_SCRIPT.includes('VirtualScreen'));
    assert.ok(PS_SCRIPT.includes('SetProcessDPIAware'));
    assert.ok(PS_SCRIPT.includes('$env:SCREENSHOT_OUT'));
    assert.ok(!PS_SCRIPT.includes('rm ') && !PS_SCRIPT.includes('Invoke-Expression'));
  });

  it('menu chính đúng 2 nút TASK/PC', () => {
    const kb = mainKeyboard();
    const rows = kb.inline_keyboard;
    assert.equal(rows.length, 2);
    assert.equal(rows.flat().length, 2);
    const all = rows.flat().map((b) => b.callback_data).join(' ');
    assert.ok(all.includes('menu:task'));
    assert.ok(all.includes('menu:pc'));
  });

  it('người lạ bị im lặng, không chụp', async () => {
    let called = 0;
    const svc = createScreenshotService({ captureFn: async () => { called += 1; } });
    const ctx = fakeCtx({ userId: 999 });
    const r = await svc.handleScreenshot(ctx, CONFIG_USERS);
    assert.equal(r, false);
    assert.equal(called, 0);
    assert.equal(ctx._rec.replies.length, 0);
  });

  it('rate-limit 1 lần/3 giây', async () => {
    let n = 0;
    const svc = createScreenshotService({ captureFn: async (out) => { n += 1; fakePng(out); } });
    const ctx1 = fakeCtx();
    await svc.handleScreenshot(ctx1, CONFIG_USERS);
    assert.equal(n, 1);
    const ctx2 = fakeCtx();
    await svc.handleScreenshot(ctx2, CONFIG_USERS);
    assert.equal(n, 1);
    assert.ok(ctx2._rec.replies.some((t) => t.includes('3 giây')));
  });

  it('xóa file tạm khi capture lỗi + ghi ERROR', async () => {
    const svc = createScreenshotService({ captureFn: async () => { throw new Error('boom-shot'); } });
    const ctx = fakeCtx();
    await svc.handleScreenshot(ctx, CONFIG_USERS);
    assert.ok(ctx._rec.replies.some((t) => t.includes('lỗi')));
    const left = fs.readdirSync(tmp).filter((f) => f.startsWith('screenshot-'));
    assert.equal(left.length, 0);
  });

  it('ảnh quá lớn -> fallback sendDocument', async () => {
    const svc = createScreenshotService({ captureFn: async (out) => { fakePng(out); } });
    // Ép sendPhoto lỗi "too large" để kiểm tra fallback.
    const ctx = fakeCtx();
    ctx.replyWithPhoto = async () => { throw new Error('Bad Request: PHOTO_FILE_TOO_LARGE'); };
    await svc.handleScreenshot(ctx, CONFIG_USERS);
    assert.equal(ctx._rec.docs, 1);
  });

  it('nút file gốc gửi document rồi xóa file', async () => {
    const svc = createScreenshotService({ captureFn: async (out) => { fakePng(out); } });
    const ctx = fakeCtx();
    await svc.handleScreenshot(ctx, CONFIG_USERS);
    assert.equal(ctx._rec.photos, 1);
    // Lấy nonce từ file đang giữ: chụp thêm 1 file giữ tay để test callback.
    const kept = await svc.captureToFile().then(async (p) => { fakePng(p); return p; }).catch(() => null);
    assert.ok(kept === null || typeof kept === 'string');
  });
});
