import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPowerController } from '../src/power.js';

const USER = 1784770769;
const USERS = new Set([USER]);

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-power-'));
  process.env.TELE_LOG_DIR = tmp;
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function fakeCtx({ userId = USER, data = null, messageId = 42, chatId = 5 } = {}) {
  const sent = [];
  const edits = [];
  let answered = 0;
  return {
    _answered: () => answered,
    _edits: edits,
    _sent: sent,
    answerCallbackQuery: async () => { answered += 1; },
    api: {
      editMessageReplyMarkup: async (...a) => { edits.push(['markup', ...a]); },
      editMessageText: async (...a) => { edits.push(['text', ...a]); }
    },
    callbackQuery: data ? { data, from: { id: userId }, message: { message_id: messageId } } : undefined,
    from: { id: userId },
    message: data ? undefined : { chat: { id: chatId }, message_id: messageId },
    reply: async (text, extra) => {
      sent.push({ extra, text });
      return { chat: { id: chatId }, message_id: 42 };
    }
  };
}

function mockExec(calls, code = 0) {
  return async (exe, args) => {
    calls.push({ args, exe });
    return { code, err: code === 0 ? null : { code }, out: '' };
  };
}

function nonceOf(ctx) {
  const kb = ctx._sent[0].extra.reply_markup;
  const data = kb.inline_keyboard[0][0].callback_data;
  return data.split(':')[2];
}

function tasks() {
  return JSON.parse(fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8'));
}

describe('power controller', () => {
  it('YES -> exec đúng 1 lần, path tuyệt đối, args cố định, xóa nút, log userId+nonce', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    const nonce = nonceOf(c);
    const cb = fakeCtx({ data: `pw:yes:${nonce}` });
    assert.equal(await ctl.handlePowerCallback(cb, USERS), true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].exe.toLowerCase().endsWith('shutdown.exe'));
    // shutdown.exe luôn là path Windows -> dùng path.win32 để test xanh cả Linux (P1-4)
    assert.ok(path.win32.isAbsolute(calls[0].exe));
    assert.deepEqual(calls[0].args, ['/s', '/t', '60']);
    assert.ok(cb._edits.some((e) => e[0] === 'markup'), 'phải xóa nút');
    assert.equal(tasks().at(-1).status, 'DONE');
    const log = fs.readFileSync(path.join(tmp, 'bot.log'), 'utf8');
    assert.ok(log.includes(`shutdown YES user=${USER} nonce=${nonce}`));
  });

  it('NO -> không exec, CANCELLED, xóa nút', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    const cb = fakeCtx({ data: `pw:no:${nonceOf(c)}` });
    await ctl.handlePowerCallback(cb, USERS);
    assert.equal(calls.length, 0);
    assert.equal(tasks().at(-1).status, 'CANCELLED');
    assert.ok(cb._edits.some((e) => e[0] === 'markup'));
  });

  it('action lạ -> "không hợp lệ", không exec', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    const cb = fakeCtx({ data: `pw:maybe:${nonceOf(c)}` });
    await ctl.handlePowerCallback(cb, USERS);
    assert.equal(calls.length, 0);
    assert.ok(cb._sent.some((s) => s.text.includes('không hợp lệ')));
  });

  it('bấm YES 2 lần -> chỉ exec 1 lần', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    const nonce = nonceOf(c);
    await ctl.handlePowerCallback(fakeCtx({ data: `pw:yes:${nonce}` }), USERS);
    const cb2 = fakeCtx({ data: `pw:yes:${nonce}` });
    await ctl.handlePowerCallback(cb2, USERS);
    assert.equal(calls.length, 1);
    assert.ok(cb2._sent.some((s) => /hết hạn|không hợp lệ/i.test(s.text)));
  });

  it('sai message -> EXPIRED', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    const cb = fakeCtx({ data: `pw:yes:${nonceOf(c)}`, messageId: 999 });
    await ctl.handlePowerCallback(cb, USERS);
    assert.equal(calls.length, 0);
    assert.equal(tasks().at(-1).status, 'EXPIRED');
  });

  it('cancel_shutdown: exit 0 DONE / 1116 DONE / 5 ERROR; không exec thật', async () => {
    for (const [code, status] of [[0, 'DONE'], [1116, 'DONE'], [5, 'ERROR']]) {
      const calls = [];
      const ctl = createPowerController({ execFn: mockExec(calls, code), onMenu: async () => {} });
      await ctl.cmdCancelShutdown(fakeCtx());
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ['/a']);
      assert.ok(calls[0].exe.toLowerCase().endsWith('shutdown.exe'));
      assert.equal(tasks().at(-1).status, status, `code=${code}`);
      if (code !== 0) assert.ok(tasks().at(-1).note.includes(String(code)));
    }
  });

  it('mọi callback power đều answerCallbackQuery (kể cả người lạ)', async () => {
    const ctl = createPowerController({ execFn: mockExec([], 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    const cb = fakeCtx({ data: `pw:yes:${nonceOf(c)}` });
    await ctl.handlePowerCallback(cb, USERS);
    assert.equal(cb._answered(), 1);
    const stranger = fakeCtx({ data: 'pw:yes:deadbeef', userId: 999 });
    await ctl.handlePowerCallback(stranger, USERS);
    assert.equal(stranger._answered(), 1);
  });

  it('tin nhắn không chứa chữ 绑定 hay chi tiết nội bộ', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdown(c);
    for (const s of c._sent) {
      assert.ok(!s.text.includes('绑定'));
      assert.ok(!s.text.includes('nonce'));
    }
  });

  it('shutdown_now: delay tối thiểu 30s, giữ cửa hủy', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdownNow(c);
    assert.ok(c._sent.some((s) => s.text.includes('30s')));
    const cb = fakeCtx({ data: `pw:yes:${nonceOf(c)}` });
    await ctl.handlePowerCallback(cb, USERS);
    assert.deepEqual(calls[0].args, ['/s', '/t', '30']);
    assert.ok(calls[0].args[2] !== '0', 'không cho /t 0 (mất cửa hủy)');
  });

  it('shutdown_at: phút hợp lệ đặt hẹn, sai thì hướng dẫn', async () => {
    const calls = [];
    const ctl = createPowerController({ execFn: mockExec(calls, 0), onMenu: async () => {} });
    await ctl.cmdShutdownAt(fakeCtx(), 'x');
    assert.equal(calls.length, 0);
    await ctl.cmdShutdownAt(fakeCtx(), '999');
    assert.equal(calls.length, 0);
    const c = fakeCtx();
    await ctl.cmdShutdownAt(c, '10');
    const cb = fakeCtx({ data: `pw:yes:${nonceOf(c)}` });
    await ctl.handlePowerCallback(cb, USERS);
    assert.deepEqual(calls[0].args, ['/s', '/t', '600']);
  });

  it('busy=true: cảnh báo mất tiến độ trong tin confirm', async () => {
    const ctl = createPowerController({ execFn: mockExec([], 0), onMenu: async () => {} });
    const c = fakeCtx();
    await ctl.cmdShutdownNow(c, { busy: true });
    assert.ok(c._sent.some((s) => s.text.includes('CẢNH BÁO')));
    const c2 = fakeCtx();
    await ctl.cmdShutdownNow(c2, { busy: false });
    assert.ok(!c2._sent.some((s) => s.text.includes('CẢNH BÁO')));
  });
});
