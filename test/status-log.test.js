import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotHandlers } from '../src/router.js';
import { createConvoStore } from '../src/state.js';

const USER = 1;
const CONFIG = {
  allowedUsers: new Set([USER]),
  opencodeProjectDir: 'D:\\AI-AGENT',
  permissionTtlMs: 60000
};
const TOKEN_LIKE = '12345678:AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw9Q';

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-statuslog-'));
  process.env.TELE_LOG_DIR = tmp;
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function fakeCtx({ text = null } = {}) {
  const replies = [];
  const markups = [];
  return {
    _markups: markups,
    _replies: replies,
    api: { editMessageReplyMarkup: async () => {}, editMessageText: async () => {} },
    answerCallbackQuery: async () => {},
    callbackQuery: undefined,
    from: { id: USER },
    message: text !== null ? { chat: { id: 5 }, message_id: 7, text } : undefined,
    reply: async (t, extra) => {
      replies.push(t);
      markups.push(extra ?? null);
      return { chat: { id: 5 }, message_id: 9 };
    }
  };
}

function makeH({ health = async () => 'OK' } = {}) {
  const convo = createConvoStore({ idleTtlMs: 30 * 60 * 1000 });
  const calls = { submits: 0 };
  const runner = { queueSize: () => 0, stop: () => ({ aborted: false, cleared: 0 }), submit: () => { calls.submits += 1; return { position: 0, promise: Promise.resolve({}) }; } };
  const h = createBotHandlers({
    client: null,
    config: CONFIG,
    convo,
    runner,
    serverManager: { ensureServer: async () => 'OK', health },
    sessionStore: { clear: () => {}, get: () => null, set: () => {} }
  });
  return { calls, convo, h };
}

describe('P1-5 /status che secret', () => {
  it('/status đi qua mask+chunk, không bao giờ rỗng', async () => {
    const { h } = makeH();
    const ctx = fakeCtx({ text: '/status' });
    await h.handleStatus(ctx);
    assert.ok(ctx._replies.length >= 1);
    assert.ok(ctx._replies.every((t) => t.length > 0 && t.length <= 4000));
  });

  it('/status khi DOWN: vẫn báo trạng thái + hỏi bật Có/Không như /start', async () => {
    const { h } = makeH({ health: async () => 'DOWN' });
    const ctx = fakeCtx({ text: '/status' });
    await h.handleStatus(ctx);
    const all = ctx._replies.join('\n');
    assert.ok(all.includes('opencode: DOWN'));
    assert.ok(ctx._replies.some((t) => t.includes('bật luôn không?')));
    const hasYes = ctx._markups.some((m) => JSON.stringify(m ?? {}).includes('sv:yes'));
    assert.ok(hasYes, 'phải có nút sv:yes');
  });

  it('/status khi OK: không hỏi bật', async () => {
    const { h } = makeH({ health: async () => 'OK' });
    const ctx = fakeCtx({ text: '/status' });
    await h.handleStatus(ctx);
    assert.ok(!ctx._replies.some((t) => t.includes('bật luôn không?')));
  });

  it('text dạng lệnh khi đang ở submenu: không submit vào opencode, hiện lại menu', async () => {
    const { calls, convo, h } = makeH();
    convo.set(USER, 'AWAIT_INPUT', 'AIRDROP_NEWS');
    const ctx = fakeCtx({ text: '/status' });
    await h.handleText(ctx);
    assert.equal(calls.submits, 0);
    assert.ok(ctx._replies.some((t) => t === 'Chọn tác vụ:'));
    assert.ok(ctx._replies.some((t) => t.includes('Đây là lệnh')));
  });
});
