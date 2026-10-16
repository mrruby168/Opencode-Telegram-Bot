import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBotHandlers } from '../src/router.js';
import { createConvoStore } from '../src/state.js';

const USER = 1;
const CONFIG = {
  allowedUsers: new Set([USER]),
  opencodeProjectDir: 'D:\\AI-AGENT',
  permissionTtlMs: 60000
};

function fakeCtx({ text = null, data = null } = {}) {
  const replies = [];
  return {
    _replies: replies,
    api: {
      editMessageReplyMarkup: async () => {},
      editMessageText: async () => {}
    },
    answerCallbackQuery: async () => {},
    callbackQuery: data
      ? { data, from: { id: USER }, message: { chat: { id: 5 }, message_id: 9 } }
      : undefined,
    from: { id: USER },
    message: text !== null ? { chat: { id: 5 }, message_id: 7, text } : undefined,
    reply: async (t, extra) => {
      replies.push({ extra, text: t });
      return { chat: { id: 5 }, message_id: 9 };
    }
  };
}

function makeH(over = {}) {
  const calls = { ensured: 0 };
  const convo = createConvoStore({ idleTtlMs: 30 * 60 * 1000 });
  const runner = { queueSize: () => 0, stop: () => ({ aborted: false, cleared: 0 }), submit: () => ({ position: 0, promise: Promise.resolve({}) }) };
  const serverManager = {
    ensureServer: async () => { calls.ensured += 1; return 'OK'; },
    health: async () => 'OK',
    ...over.serverManager
  };
  const h = createBotHandlers({
    client: null,
    config: CONFIG,
    convo,
    runner,
    serverManager,
    sessionStore: { clear: () => {}, get: () => null, set: () => {} }
  });
  return { calls, h };
}

describe('/start matrix', () => {
  it('OK -> "opencode đã bật" + menu', async () => {
    const { h } = makeH();
    const ctx = fakeCtx({ text: '/start' });
    await h.handleStart(ctx);
    assert.ok(ctx._replies.some((r) => r.text.includes('opencode đã bật')));
    assert.ok(ctx._replies.some((r) => r.text === 'Chọn tác vụ:'));
  });

  it('UNAUTHORIZED -> báo password, không menu', async () => {
    const { h } = makeH({ serverManager: { health: async () => 'UNAUTHORIZED' } });
    const ctx = fakeCtx({ text: '/start' });
    await h.handleStart(ctx);
    assert.ok(ctx._replies.some((r) => r.text.includes('OPENCODE_SERVER_PASSWORD')));
    assert.ok(!ctx._replies.some((r) => r.text === 'Chọn tác vụ:'));
  });

  it('DOWN -> hỏi bật; Không -> dừng', async () => {
    const { h } = makeH({ serverManager: { health: async () => 'DOWN' } });
    const ctx = fakeCtx({ text: '/start' });
    await h.handleStart(ctx);
    assert.ok(ctx._replies.some((r) => r.text.includes('bật luôn không')));
    const no = fakeCtx({ data: 'sv:no' });
    await h.handleServerCallback(no);
    assert.ok(no._replies.some((r) => r.text.includes('/opencode')));
  });

  it('DOWN + Có -> ensureServer -> "đã bật" + menu', async () => {
    const { calls, h } = makeH({ serverManager: { ensureServer: async () => { calls.ensured += 1; return 'OK'; }, health: async () => 'DOWN' } });
    await h.handleStart(fakeCtx({ text: '/start' }));
    const yes = fakeCtx({ data: 'sv:yes' });
    await h.handleServerCallback(yes);
    assert.equal(calls.ensured, 1);
    assert.ok(yes._replies.some((r) => r.text.includes('opencode CLI đã bật')));
    assert.ok(yes._replies.some((r) => r.text === 'Chọn tác vụ:'));
  });

  it('spawn lỗi -> báo lỗi rõ', async () => {
    const { h } = makeH({
      serverManager: {
        ensureServer: async () => { throw new Error('Không spawn được opencode (xxx). Bật tay: ...'); },
        health: async () => 'DOWN'
      }
    });
    await h.handleStart(fakeCtx({ text: '/start' }));
    const yes = fakeCtx({ data: 'sv:yes' });
    await h.handleServerCallback(yes);
    assert.ok(yes._replies.some((r) => r.text.includes('Bật opencode lỗi')));
  });
});

describe('askApproval + question text', () => {
  it('perm: sender nhận tin + resolve once qua callback', async () => {
    const { h } = makeH();
    const sent = [];
    const sender = { sendRaw: async (t, kb) => { sent.push({ kb, t }); } };
    const { nonce, promise } = await h.askApproval({
      permission: { id: 'p1', sessionID: 's1', title: 'run ls', type: 'bash' },
      sender,
      sessionId: 's1',
      userId: USER
    });
    assert.ok(nonce && sent.length === 1);
    assert.ok(sent[0].t.includes('bash'));
    let action = null;
    void promise.then((a) => { action = a; });
    const cb = fakeCtx({ data: `pm:${nonce}:o` });
    await h.handlePermCallback(cb);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(action, 'once');
  });

  it('question button -> forward label, text nhắc bấm nút', async () => {
    const { h } = makeH();
    const sent = [];
    const sender = { sendRaw: async (t) => { sent.push(t); } };
    const { nonce, promise } = await h.askApproval({
      question: { options: [{ label: 'Làm tiếp' }, { label: 'Bỏ qua' }], question: 'Tiếp tục?' },
      sender,
      sessionId: 's9',
      userId: USER
    });
    assert.ok(nonce && sent.length === 1);
    assert.ok(sent[0].includes('Trả lời bằng nút.'));
    let settled = null;
    void promise.then((v) => { settled = v; });
    // Text tự do lúc đang chờ: nhắc bấm nút, không resolve.
    const ctxText = fakeCtx({ text: 'ý kiến riêng' });
    await h.handleText(ctxText);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, null);
    assert.ok(ctxText._replies.some((r) => r.text.includes('chọn 1 nút')));
    // Bấm nút 1 -> resolve label, báo đã gửi.
    const cb = fakeCtx({ data: `q:${nonce}:0` });
    await h.handleQuestionCallback(cb);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, 'Làm tiếp');
    assert.ok(cb._replies.some((r) => r.text.includes('Đã gửi tới opencode')));
  });

  it('question không nút -> nhận text kế tiếp', async () => {
    const { h } = makeH();
    const sent = [];
    const sender = { sendRaw: async (t) => { sent.push(t); } };
    const { promise } = await h.askApproval({
      question: { options: [], question: 'Nói gì đi?' },
      sender,
      sessionId: 's10',
      userId: USER
    });
    assert.ok(sent[0].includes('tin nhắn kế tiếp'));
    let settled = null;
    void promise.then((v) => { settled = v; });
    const ctx = fakeCtx({ text: 'cứ làm đi' });
    await h.handleText(ctx);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(settled, 'cứ làm đi');
    assert.ok(ctx._replies.some((r) => r.text.includes('Đã gửi tới opencode')));
  });
});
