import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBotHandlers, createSender } from '../src/router.js';
import { SUBS } from '../src/modes.js';
import { createConvoStore } from '../src/state.js';
import { recordTask } from '../src/common.js';

const USER = 1;
const CONFIG = {
  allowedUsers: new Set([USER]),
  mmoCodeTimeoutMs: 60000,
  mmoTaskTimeoutMs: 60000,
  opencodeProjectDir: 'D:\\AI-AGENT',
  permissionTtlMs: 60000
};

let tmp;
let tmpMmo;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-convo-'));
  process.env.TELE_LOG_DIR = tmp;
  tmpMmo = path.join(tmp, 'Mmo');
  for (const n of ['task-a', 'task-b']) {
    fs.mkdirSync(path.join(tmpMmo, n, 'task'), { recursive: true });
    fs.writeFileSync(path.join(tmpMmo, n, 'task', 'task.md'), '# TASK\nlàm đi\n');
  }
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function fakeCtx({ text = null, data = null } = {}) {
  const replies = [];
  const edits = [];
  const deletes = [];
  let cbAnswered = 0;
  return {
    _answered: () => cbAnswered,
    _deletes: deletes,
    _edits: edits,
    _replies: replies,
    api: {
      deleteMessage: async (...a) => { deletes.push(a); return true; },
      editMessageReplyMarkup: async (...a) => { edits.push(a); },
      editMessageText: async (...a) => { edits.push(a); }
    },
    answerCallbackQuery: async () => { cbAnswered += 1; },
    callbackQuery: data
      ? { data, from: { id: USER }, message: { chat: { id: 5 }, message_id: 9 } }
      : undefined,
    from: { id: USER },
    message: text !== null ? { chat: { id: 5 }, message_id: 7, text } : undefined,
    reply: async (text, extra) => {
      replies.push({ extra, text });
      return { chat: { id: 5 }, message_id: 9 };
    }
  };
}

function makeDeps(over = {}) {
  const calls = { submits: [], power: [], cleared: [] };
  const convo = createConvoStore({ idleTtlMs: 30 * 60 * 1000 });
  const config = { ...CONFIG, mmoDir: tmpMmo };
  const runner = {
    pause: () => ({ aborted: false }),
    queueSize: () => 0,
    stop: () => ({ aborted: false, cleared: 0 }),
    submit: ({ mode, promptText, sessionId, timeoutMs, userId }) => {
      calls.submits.push({ mode, promptText, sessionId, timeoutMs, userId });
      return { position: 0, promise: Promise.resolve({ sessionId: 's', status: 'DONE', text: 'ok' }) };
    },
    ...over.runner
  };
  const power = {
    cmdCancelShutdown: async () => { calls.power.push('cancel'); },
    cmdShutdown: async () => { calls.power.push('shutdown'); },
    handlePowerCallback: async () => false,
    ...over.power
  };
  const sessionStore = {
    clear: (m) => { calls.cleared.push(m); },
    get: () => null,
    ...over.sessionStore
  };
  const serverManager = {
    ensureServer: async () => 'OK',
    health: async () => 'OK',
    ...over.serverManager
  };
  const h = createBotHandlers({ client: null, config, convo, power, runner, serverManager, sessionStore });
  return { calls, config, convo, h };
}

// Mở menu:task -> bấm nút task. Trả ctx xác minh + tin danh sách.
async function runTaskA(h, idx = 0) {
  const listCtx = fakeCtx({ data: 'menu:task' });
  await h.handleMenuCallback(listCtx);
  const listMsg = listCtx._replies.find((r) => typeof r.text === 'string' && r.text === 'Bạn hãy chọn task cần thực thi');
  assert.ok(listMsg, 'phải hiện danh sách task');
  const btns = listMsg.extra.reply_markup.inline_keyboard.flat();
  assert.deepEqual(btns.map((b) => b.text), ['task-a', 'task-b']);
  const pickCtx = fakeCtx({ data: btns[idx].callback_data });
  await h.handleTaskPickCallback(pickCtx);
  return { goCtx: pickCtx, listCtx, pickCtx };
}

// Bấm OK trên tin xác minh mới nhất của ctx chạy. Trả okCtx (nhận output run).
async function clickOk(h, ctx) {
  const confirm = [...ctx._replies].reverse().find((r) => typeof r.text === 'string' && r.text.includes('Xác nhận thực thi'));
  assert.ok(confirm, 'phải có tin xác minh OK/Cancel');
  const btns = confirm.extra.reply_markup.inline_keyboard.flat();
  assert.deepEqual(btns.map((b) => b.text), ['OK', 'Cancel']);
  const okData = btns.find((b) => b.text === 'OK').callback_data;
  assert.ok(okData.startsWith('cf:'), okData);
  const okCtx = fakeCtx({ data: okData });
  await h.handleTaskConfirmCallback(okCtx);
  await new Promise((r) => setTimeout(r, 20));
  return { okCtx };
}

describe('state machine 2-mode', () => {
  it('IDLE + text -> menu + nhắc chọn mục', async () => {
    const { convo, h } = makeDeps();
    const ctx = fakeCtx({ text: 'làm gì đó' });
    await h.handleText(ctx);
    assert.equal(convo.get(USER).status, 'IDLE');
    assert.ok(ctx._replies.some((r) => r.text === 'Chọn tác vụ:'));
    assert.ok(ctx._replies.some((r) => r.text.includes('Chọn 1 mục trước')));
  });

  it('menu chính đúng 2 nút TASK/PC', async () => {
    const { h } = makeDeps();
    const ctx = fakeCtx({ text: '/start' });
    await h.handleStart(ctx);
    const menu = ctx._replies.find((r) => r.text === 'Chọn tác vụ:');
    assert.ok(menu, 'phải hiện menu chính');
    const btns = menu.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(btns, ['TASK', 'ON/OFF PC']);
  });

  it('menu:task -> mỗi task 1 nút, chưa submit', async () => {
    const { calls, h } = makeDeps();
    const ctx = fakeCtx({ data: 'menu:task' });
    await h.handleMenuCallback(ctx);
    assert.equal(calls.submits.length, 0);
    const listMsg = ctx._replies.find((r) => typeof r.text === 'string' && r.text === 'Bạn hãy chọn task cần thực thi');
    assert.ok(listMsg, 'phải liệt kê task');
    const texts = listMsg.extra.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(texts, ['task-a', 'task-b']);
  });

  it('gõ text khi ở màn chọn task -> nhắc bấm nút, không submit', async () => {
    const { calls, convo, h } = makeDeps();
    const listCtx = fakeCtx({ data: 'menu:task' });
    await h.handleMenuCallback(listCtx);
    const ctx = fakeCtx({ text: '1' });
    await h.handleText(ctx);
    assert.ok(ctx._replies.some((r) => r.text.includes('bấm 1 task ở trên')));
    assert.equal(calls.submits.length, 0);
    assert.ok(convo.get(USER).mode.startsWith('PICK:'));
  });

  it('bấm task-a + OK -> submit MMO:task-a, prompt bỏ B0 + rule-mmo', async () => {
    const { calls, config, convo, h } = makeDeps();
    const { pickCtx } = await runTaskA(h, 0);
    assert.equal(calls.submits.length, 0, 'chưa OK thì chưa submit');
    await clickOk(h, pickCtx);
    assert.equal(calls.submits.length, 1);
    assert.equal(calls.submits[0].mode, 'MMO:task-a');
    assert.ok(calls.submits[0].promptText.includes('rule-mmo.md'));
    assert.ok(calls.submits[0].promptText.includes('Bỏ qua bước liệt kê'));
    assert.ok(calls.submits[0].promptText.includes(config.mmoDir));
    assert.ok(calls.submits[0].timeoutMs > 0);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(convo.get(USER).status, 'IDLE', 'xong task tự về IDLE');
  });

  it('Cancel sau xác minh: quay lại list task, bấm task khác chạy', async () => {
    const { calls, h } = makeDeps();
    const { pickCtx } = await runTaskA(h, 0);
    const confirm = [...pickCtx._replies].reverse().find((r) => typeof r.text === 'string' && r.text.includes('Xác nhận thực thi'));
    const cancelData = confirm.extra.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Cancel').callback_data;
    const cancelCtx = fakeCtx({ data: cancelData });
    await h.handleTaskConfirmCallback(cancelCtx);
    assert.equal(calls.submits.length, 0);
    const listAgain = cancelCtx._replies.find((r) => typeof r.text === 'string' && r.text === 'Bạn hãy chọn task cần thực thi');
    assert.ok(listAgain, 'Cancel phải quay lại list task');
    const btns = listAgain.extra.reply_markup.inline_keyboard.flat();
    const pick2 = fakeCtx({ data: btns[1].callback_data });
    await h.handleTaskPickCallback(pick2);
    await clickOk(h, pick2);
    assert.equal(calls.submits.length, 1);
    assert.equal(calls.submits[0].mode, 'MMO:task-b');
  });

  it('menu:pc -> submenu; go:pc:shutdown gọi power; go:pc:shot chụp màn hình', async () => {
    const { calls, h } = makeDeps();
    const ctx = fakeCtx({ data: 'menu:pc' });
    await h.handleMenuCallback(ctx);
    assert.ok(ctx._replies.some((r) => r.text === 'ON/OFF PC:'));
    await h.handleGoCallback(fakeCtx({ data: 'go:pc:shutdown' }));
    assert.deepEqual(calls.power, ['shutdown']);
  });

  it('notify gọn: ⏳ rồi ✅, ẩn text AI (không echo nội dung)', async () => {
    const { h } = makeDeps({
      runner: {
        queueSize: () => 0,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: () => ({ position: 0, promise: Promise.resolve({ sessionId: 's9', status: 'DONE', text: 'Dự án **L1**, cost **0**' }) })
      }
    });
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    const all = okCtx._replies.map((r) => r.text).join('\n');
    assert.ok(all.includes('⏳ do task task-a'));
    assert.ok(all.includes('✅ task-a Done'));
    assert.ok(!all.includes('Dự án'), 'text AI không echo ra chat');
    assert.ok(!all.includes('**'));
    assert.ok(okCtx._replies.some((r) => r.text === 'Chọn tác vụ:'), 'xong task tự về menu');
  });

  it('tin ⏳/✅ gửi mới, không xóa tin cũ', async () => {
    const { h } = makeDeps();
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    assert.deepEqual(okCtx._deletes, []);
    assert.ok(okCtx._replies.some((r) => r.text.includes('✅ task-a Done')));
  });

  it('RUNNING + text -> xếp hàng cùng task, báo vị trí', async () => {
    let resolveTask;
    const gate = new Promise((res) => { resolveTask = res; });
    const { calls, convo, h } = makeDeps({
      runner: {
        queueSize: () => 2,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: ({ mode, promptText }) => {
          calls.submits.push({ mode, promptText });
          if (calls.submits.length === 1) return { position: 0, promise: gate };
          return { position: 1, promise: Promise.resolve({ status: 'DONE', text: 'ok' }) };
        }
      }
    });
    convo.set(USER, 'AWAIT_INPUT', 'MMO:task-a');
    await h.handleText(fakeCtx({ text: 'việc 1' }));
    assert.equal(convo.get(USER).status, 'RUNNING');
    const ctx2 = fakeCtx({ text: 'việc 2' });
    await h.handleText(ctx2);
    assert.equal(calls.submits.length, 2);
    assert.ok(calls.submits.every((s) => s.mode === 'MMO:task-a'));
    assert.ok(ctx2._replies.some((r) => r.text.includes('vị trí 1')));
    resolveTask({ status: 'DONE', text: 'xong' });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('cf: lạ/hết hạn -> báo chạy lại, không crash', async () => {
    const { h } = makeDeps();
    const ctx = fakeCtx({ data: 'cf:deadbeefcafe:ok' });
    await h.handleTaskConfirmCallback(ctx);
    assert.ok(ctx._replies.some((r) => r.text.includes('TASK')));
    const ctx2 = fakeCtx({ data: 'go:pc:bogus' });
    await h.handleGoCallback(ctx2);
    assert.ok(ctx2._replies.some((r) => r.text === 'ON/OFF PC:'));
  });

  it('TIMEOUT -> tự chạy lại cùng session (không hỏi), rồi ✅', async () => {
    const { calls, h } = makeDeps({
      runner: {
        queueSize: () => 0,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: ({ sessionId }) => {
          calls.submits.push({ sessionId });
          if (calls.submits.length === 1) {
            return { position: 0, promise: Promise.resolve({ sessionId: 's-time', status: 'TIMEOUT', text: 'dở **đây**' }) };
          }
          return { position: 0, promise: Promise.resolve({ sessionId: 's-time', status: 'DONE', text: 'xong' }) };
        }
      }
    });
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.submits.length, 2, 'tự retry leg 2');
    assert.equal(calls.submits[1].sessionId, 's-time');
    const papers = okCtx._replies.map((r) => r.text).join('\n');
    assert.ok(papers.includes('tự chạy lại (lượt 2/3)'));
    assert.ok(papers.includes('✅ task-a Done'));
    assert.ok(!papers.includes('dở đây'), 'text dở không echo');
  });

  it('TIMEOUT hết 3 lượt -> ❌ + ⛔, không hỏi', async () => {
    const { h } = makeDeps({
      runner: {
        queueSize: () => 0,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: () => ({ position: 0, promise: Promise.resolve({ sessionId: 's-t', status: 'TIMEOUT', text: '' }) })
      }
    });
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    await new Promise((r) => setTimeout(r, 30));
    const papers = okCtx._replies.map((r) => r.text).join('\n');
    assert.ok(papers.includes('❌ Hết giờ 3 lượt'));
    assert.ok(papers.includes('⛔ task-a stop'));
  });

  it('ERROR single -> ❌ + ⛔ stop check lỗi, text dở không echo', async () => {
    const { h } = makeDeps({
      runner: {
        queueSize: () => 0,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: () => ({ position: 0, promise: Promise.resolve({ sessionId: 's-e', status: 'ERROR', text: 'partial', error: 'api key hết hạn\nchi tiết' }) })
      }
    });
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    await new Promise((r) => setTimeout(r, 20));
    const papers = okCtx._replies.map((r) => r.text).join('\n');
    assert.ok(papers.includes('❌ Lỗi api key hết hạn'));
    assert.ok(!papers.includes('chi tiết'), 'chỉ 1 dòng đầu');
    assert.ok(papers.includes('⛔ task-a stop'));
  });

  it('go lạ -> bỏ qua, không crash', async () => {
    const { h } = makeDeps();
    const ctx = fakeCtx({ data: 'go:cont:BOGUS' });
    await h.handleGoCallback(ctx);
    const ctx2 = fakeCtx({ data: 'go:pc:bogus' });
    await h.handleGoCallback(ctx2);
    assert.ok(ctx2._replies.some((r) => r.text === 'ON/OFF PC:'));
  });

  it('/new xóa session task hiện tại', async () => {
    const { calls, convo, h } = makeDeps();
    convo.set(USER, 'AWAIT_INPUT', 'MMO:task-a');
    const ctx = fakeCtx({ text: '/new' });
    await h.handleNew(ctx);
    assert.deepEqual(calls.cleared, ['MMO:task-a']);
    assert.ok(ctx._replies.some((r) => r.text.includes('MMO:task-a')));
  });

  it('go:stop-task -> runner.stop + báo kết quả', async () => {
    let stopped = 0;
    const { h } = makeDeps({
      runner: {
        queueSize: () => 1,
        stop: () => { stopped += 1; return { aborted: true, cleared: 2 }; },
        submit: () => ({ position: 0, promise: Promise.resolve({}) })
      }
    });
    const ctx = fakeCtx({ data: 'go:stop-task' });
    await h.handleGoCallback(ctx);
    assert.equal(stopped, 1);
    assert.ok(ctx._replies.some((r) => r.text.includes('Đã dừng')));
  });

  it('task bị hủy trước khi chạy (stopped) -> một dòng, không fallback rỗng', async () => {
    const { h } = makeDeps({
      runner: {
        queueSize: () => 0,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: () => ({ position: 0, promise: Promise.resolve({ stopped: true }) })
      }
    });
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    const all = okCtx._replies.map((r) => r.text).join('\n');
    assert.ok(all.includes('⛔ task-a stop'));
  });

  it('task bị abort giữa chừng (ABORTED) -> một dòng, không đổ partial cũ', async () => {
    const { h } = makeDeps({
      runner: {
        queueSize: () => 0,
        stop: () => ({ aborted: false, cleared: 0 }),
        submit: () => ({ position: 0, promise: Promise.resolve({ status: 'ABORTED', text: 'nội dung dở dang rất dài' }) })
      }
    });
    const { goCtx } = await runTaskA(h);
    const { okCtx } = await clickOk(h, goCtx);
    const all = okCtx._replies.map((r) => r.text).join('\n');
    assert.ok(all.includes('⛔ task-a stop'));
    assert.ok(!all.includes('nội dung dở dang rất dài'));
  });
});

describe('sender telegram timeout (P3)', () => {
  it('ctx.reply treo -> sendInitial reject trong ~timeout, không chờ vô hạn', async () => {
    const hanging = { api: {}, reply: () => new Promise(() => {}) };
    const s = createSender(hanging, { sendTimeoutMs: 50 });
    const t0 = Date.now();
    await assert.rejects(() => s.sendInitial(), /timeout/);
    assert.ok(Date.now() - t0 < 5000, 'phải timeout nhanh, không treo');
  });

  it('ctx.reply nhanh -> gửi bình thường, giữ chat/msg id', async () => {
    const ok = { api: {}, reply: async (t) => ({ chat: { id: 5 }, message_id: 9 }) };
    const s = createSender(ok, { sendTimeoutMs: 1000 });
    await s.sendInitial();
    assert.deepEqual(s.chat(), { chatId: 5, msgId: 9 });
  });

  it('askApproval khi gửi Telegram lỗi -> resolve reject, task không kẹt', async () => {
    const { h } = makeDeps();
    const badSender = { sendRaw: async () => { throw new Error('net down'); } };
    const { promise } = await h.askApproval({
      permission: { id: 'p1', pattern: 'ls', type: 'bash' },
      sender: badSender,
      sessionId: 'ses-1',
      userId: USER
    });
    const action = await promise;
    assert.equal(action, 'reject');
  });
});
