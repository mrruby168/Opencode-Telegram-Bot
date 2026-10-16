import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from 'grammy';
import { startFakeOpencode } from './helpers/fake-opencode.js';
import { createClient } from '../src/opencode-exec.js';
import { createConvoStore, clearModeSession, getModeSession, setModeSession } from '../src/state.js';
import { createRunner } from '../src/runner.js';
import { createServerManager } from '../src/server.js';
import { createBotHandlers } from '../src/router.js';
import { createPowerController } from '../src/power.js';
import { sendMainMenu } from '../src/menu.js';
import { logLine, senderId } from '../src/common.js';

const USER = 1;
const STRANGER = 999;
const TOKEN_LIKE = '12345678:AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw9Q';

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-e2e-'));
  process.env.TELE_LOG_DIR = tmp;
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs = 15000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await sleep(50);
  }
}

async function makeWorld({ configOver = {}, onPrompt = null, powerOver = {}, serverDeps = null } = {}) {
  const fake = await startFakeOpencode();
  if (onPrompt) fake.state.onPrompt = onPrompt;
  // Fixture MMO: 1 task thật để luồng /tasks quét được.
  const tmpMmo = path.join(tmp, 'Mmo');
  fs.mkdirSync(path.join(tmpMmo, 'task-e2e', 'task'), { recursive: true });
  fs.writeFileSync(path.join(tmpMmo, 'task-e2e', 'task', 'task.md'), '# TASK\nviệc e2e\n');
  const config = {
    allowedUsers: new Set([USER]),
    mmoCodeTimeoutMs: 15000,
    mmoDir: tmpMmo,
    mmoIdleTimeoutMs: 60000,
    mmoTaskTimeoutMs: 15000,
    opencodeBin: 'opencode',
    opencodeModel: null,
    opencodeProjectDir: 'D:\\E2E',
    opencodeServerPassword: '',
    opencodeServerPort: new URL(fake.url).port ? Number(new URL(fake.url).port) : 0,
    opencodeServerUrl: fake.url,
    opencodeServerUsername: 'opencode',
    permissionTtlMs: 60000,
    permissionWaitMaxMs: 60000,
    taskTimeoutMs: 15000,
    telegramBotToken: 'fake-token',
    ...configOver
  };
  const client = createClient(config);
  const convo = createConvoStore({ idleTtlMs: 30 * 60 * 1000 });
  const sessionStore = { clear: clearModeSession, get: getModeSession, set: setModeSession };
  const serverManager = createServerManager({ client, config, deps: serverDeps || {} });
  const execCalls = [];
  const power = createPowerController({
    confirmTtlMs: powerOver.confirmTtlMs,
    execFn: async (exe, args) => {
      execCalls.push({ args, exe });
      return { code: powerOver.exitCode ?? 0, err: null, out: '' };
    },
    onMenu: (ctx) => sendMainMenu(ctx)
  });
  let handlers;
  const runner = createRunner({
    client,
    config,
    firstProgressMs: configOver.firstProgressMs ?? 30000,
    hooks: {
      onPermission: (e) => handlers.runnerOnPermission(e),
      onRetry: (e) => handlers.runnerOnRetry(e),
      onSilent: (e) => handlers.runnerOnSilent(e),
      onText: (e) => handlers.runnerOnText(e)
    },
    resyncIntervalMs: configOver.resyncIntervalMs ?? 30000,
    watchdogMs: configOver.watchdogMs ?? 120000
  });
  handlers = createBotHandlers({ client, config, convo, power, runner, serverManager, sessionStore });

  const bot = new Bot('fake-token-for-test', {
    botInfo: {
      can_join_groups: true,
      can_read_all_group_messages: false,
      first_name: 'TestBot',
      id: 999,
      is_bot: true,
      supports_inline_queries: false,
      username: 'testbot'
    }
  });
  const rec = { answers: [], deletes: [], edits: [], markups: [], sent: [] };
  let mid = 1000;
  bot.api.config.use(async (prev, method, payload) => {
    const ok = (result) => ({ ok: true, result });
    if (method === 'deleteMessage') {
      rec.deletes.push({ chat_id: payload.chat_id, message_id: payload.message_id });
      return ok(true);
    }
    if (method === 'sendMessage') {
      mid += 1;
      rec.sent.push({ chat_id: payload.chat_id, message_id: mid, reply_markup: payload.reply_markup, text: payload.text });
      return ok({ chat: { id: payload.chat_id, type: 'private' }, date: 1, message_id: mid, text: payload.text });
    }
    if (method === 'editMessageText') {
      rec.edits.push({ message_id: payload.message_id, text: payload.text });
      return ok(true);
    }
    if (method === 'answerCallbackQuery') {
      rec.answers.push(payload);
      return ok(true);
    }
    if (method === 'editMessageReplyMarkup') {
      rec.markups.push(payload);
      return ok(true);
    }
    if (method === 'setMyCommands' || method === 'setChatMenuButton' || method === 'getMe') {
      return ok(true);
    }
    return prev(method, payload);
  });
  // Middleware whitelist giống bot.js thật (người lạ: im lặng, chỉ log ID).
  bot.use(async (ctx, next) => {
    const id = senderId(ctx);
    if (!config.allowedUsers.has(id)) {
      logLine('WARN', `stranger blocked id=${String(id)}`);
      return;
    }
    await next();
  });
  handlers.register(bot);

  let updateId = 0;
  let msgId = 0;
  const fromUser = (id) => ({ first_name: id === USER ? 'U' : 'S', id, is_bot: false });
  async function sendText(text, from = USER, entities = null) {
    msgId += 1;
    const message = { chat: { id: 5, type: 'private' }, date: 1, from: fromUser(from), message_id: msgId, text };
    if (entities) message.entities = entities;
    await bot.handleUpdate({ update_id: ++updateId, message });
  }
  async function sendCommand(cmd) {
    await sendText(cmd, USER, [{ length: cmd.length, offset: 0, type: 'bot_command' }]);
  }
  async function click(data, from = USER, messageId = 9) {
    await bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        chat_instance: 'x',
        data,
        from: fromUser(from),
        id: `cb${updateId}`,
        message: { chat: { id: 5, type: 'private' }, date: 1, message_id: messageId, text: 'm' }
      }
    });
  }
  function buttonData(matchText) {
    for (let i = rec.sent.length - 1; i >= 0; i--) {
      const kb = rec.sent[i].reply_markup?.inline_keyboard || [];
      for (const row of kb) {
        for (const b of row) {
          if (b.text === matchText) return b.callback_data;
        }
      }
    }
    return null;
  }
  return {
    bot,
    buttonData,
    click,
    config,
    execCalls,
    fake,
    handlers,
    rec,
    sendCommand,
    sendText,
    close: async () => {
      runner.close();
      await fake.close();
    }
  };
}

async function runFirstTask(w, idx = 0) {
  // Menu TASK -> bấm nút task -> bấm OK xác minh.
  // Lấy tin list MỚI NHẤT: list cũ mang nonce cũ, bấm vào đó báo hết hạn.
  const sentBefore = w.rec.sent.length;
  await w.click(w.buttonData('TASK'));
  const listMsg = await waitFor(
    () => [...w.rec.sent].reverse().find((s) => typeof s.text === 'string' && s.text === 'Bạn hãy chọn task cần thực thi'),
    8000,
    'task list'
  );
  assert.ok(w.rec.sent.indexOf(listMsg) >= sentBefore, 'phải là tin list mới, không dùng lại list cũ');
  const taskBtns = listMsg.reply_markup.inline_keyboard.flat();
  assert.ok(taskBtns.some((b) => b.text === 'task-e2e'));
  await w.click(taskBtns[idx].callback_data);
  const confirm = await waitFor(
    () => [...w.rec.sent].reverse().find((s) => typeof s.text === 'string' && s.text.includes('Xác nhận thực thi')),
    8000,
    'confirm'
  );
  const okData = confirm.reply_markup.inline_keyboard.flat().find((b) => b.text === 'OK').callback_data;
  await w.click(okData);
}

function cumulativeAnswer(sid, full) {
  // Mô phỏng server thật: part mang toàn bộ text hiện tại (P0-1).
  const cuts = [];
  for (let i = 1; i <= full.length; i++) cuts.push(full.slice(0, i));
  return [
    { properties: { status: { type: 'busy' } }, type: 'session.status' },
    { properties: { info: { id: 'm-u', role: 'user' } }, type: 'message.updated' },
    { properties: { info: { id: 'm-a', role: 'assistant' } }, type: 'message.updated' },
    ...cuts.map((t) => ({
      properties: { part: { id: 'p1', messageID: 'm-a', text: t, type: 'text' } },
      type: 'message.part.updated'
    })),
    { type: 'session.idle' }
  ];
}

describe('e2e offline', () => {
  it('1. start -> menu -> TASK chọn + chạy -> ⏳/✅ gọn, ẩn suy nghĩ', async () => {
    const w = await makeWorld({
      onPrompt: async (sid) => {
        await sleep(30);
        w.fake.emitSession(sid, cumulativeAnswer(sid, 'Xin chào bạn'));
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      assert.ok(w.rec.sent.some((s) => s.text.includes('opencode đã bật')));
      await runFirstTask(w);
      await waitFor(
        () => w.rec.sent.some((s) => typeof s.text === 'string' && s.text === '⏳ do task task-e2e'),
        15000,
        'started'
      );
      const final = await waitFor(
        () => w.rec.sent.find((s) => typeof s.text === 'string' && s.text === '✅ task-e2e Done'),
        15000,
        'final'
      );
      assert.ok(final);
      assert.ok(!w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('Xin chào bạn')), 'text AI không echo');
      assert.equal(w.rec.edits.length, 0, 'ẩn suy nghĩ AI: không stream edit');
    } finally {
      await w.close();
    }
  });

  it('2a. start khi DOWN -> Có -> spawn mock -> menu, bấm 2 lần spawn 1', async () => {
    let up = false;
    let spawns = 0;
    const w = await makeWorld({
      serverDeps: {
        healthFn: async () => {
          if (!up) throw new Error('fetch failed');
          return {};
        },
        sleepFn: async (ms) => sleep(Math.min(ms, 20)),
        spawnFn: (bin, args, opts) => {
          spawns += 1;
          setTimeout(() => { up = true; }, 60);
          return { once: () => {}, unref: () => {} };
        }
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text.includes('bật luôn không')), 8000, 'ask boot');
      const data = w.buttonData('Có, bật');
      assert.ok(data);
      await w.click(data);
      await w.click(data);
      await waitFor(() => w.rec.sent.some((s) => s.text.includes('opencode CLI đã bật')), 15000, 'booted');
      assert.equal(spawns, 1);
      assert.ok(w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'));
    } finally {
      await w.close();
    }
  });

  it('2b. start khi DOWN -> Không -> dừng đúng thông điệp', async () => {
    const w = await makeWorld({
      serverDeps: {
        healthFn: async () => { throw new Error('nope'); },
        sleepFn: async () => {},
        spawnFn: () => { throw new Error('should not spawn'); }
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text.includes('bật luôn không')), 8000, 'ask boot');
      await w.click(w.buttonData('Không'));
      await waitFor(() => w.rec.sent.some((s) => s.text.includes('/opencode')), 8000, 'declined');
    } finally {
      await w.close();
    }
  });

  it('3. permission: allow once -> fake nhận once + xong; người lạ; task tiếp theo', async () => {
    const w = await makeWorld({
      configOver: { permissionTtlMs: 60000 },
      onPrompt: async (sid) => {
        const n = w.fake.state.prompts.length;
        await sleep(30);
        w.fake.emitSession(sid, [
          { properties: { status: { type: 'busy' } }, type: 'session.status' },
          { properties: { id: `p${n}`, sessionID: sid, title: 'run ls', type: 'bash' }, type: 'permission.asked' }
        ]);
        await sleep(1200);
        w.fake.emitSession(sid, [{ type: 'session.idle' }]);
      }
    });
    try {
      // task chạy khi chọn trong /tasks: allow once
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      const permMsg = await waitFor(
        () => w.rec.sent.find((s) => s.text.includes('xin quyền')),
        10000,
        'perm msg'
      );
      const onceData = permMsg.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Cho phép 1 lần').callback_data;
      await w.click(onceData);
      await waitFor(() => w.fake.state.permissions.some((p) => p.response === 'once'), 8000, 'once recorded');
      await waitFor(() => w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('✅ task-e2e Done')), 15000, 'done');
      // stranger click bị bỏ qua
      const before = w.fake.state.permissions.length;
      await w.click(onceData, STRANGER);
      await sleep(300);
      assert.equal(w.fake.state.permissions.length, before);
      assert.ok(w.rec.answers.length >= 1, 'mọi callback đều được answer');
      // task tiếp theo: xong task trước đã tự về menu IDLE nên chọn lại task
      // (cùng mode MMO:task-e2e, session tái dùng) — xin quyền lần nữa rồi xong
      await runFirstTask(w);
      const perm2 = await waitFor(
        () => w.rec.sent.filter((s) => s.text.includes('xin quyền')).at(-1) &&
          w.rec.sent.filter((s) => s.text.includes('xin quyền')).length >= 2
          ? w.rec.sent.filter((s) => s.text.includes('xin quyền')).at(-1) : null,
        10000,
        'perm 2 asked'
      );
      const d2 = perm2.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Cho phép 1 lần').callback_data;
      await w.click(d2);
      await waitFor(
        () => w.fake.state.permissions.filter((p) => p.response === 'once').length >= 2,
        10000,
        'both replied'
      );
      await waitFor(
        () => w.rec.sent.filter((s) => typeof s.text === 'string' && s.text.includes('✅ task-e2e Done')).length >= 2,
        15000,
        'done2'
      );
    } finally {
      await w.close();
    }
  });

  it('3b. permission deny + hết hạn', async () => {
    const w = await makeWorld({
      configOver: { permissionTtlMs: 500 },
      onPrompt: async (sid) => {
        await sleep(30);
        w.fake.emitSession(sid, [
          { properties: { status: { type: 'busy' } }, type: 'session.status' },
          { properties: { id: 'pd', sessionID: sid, title: 'rm', type: 'bash' }, type: 'permission.asked' }
        ]);
        await sleep(600);
        w.fake.emitSession(sid, [{ type: 'session.idle' }]);
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      const permMsg = await waitFor(() => w.rec.sent.find((s) => s.text.includes('xin quyền')), 10000, 'perm');
      const denyData = permMsg.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Từ chối').callback_data;
      await w.click(denyData);
      await waitFor(() => w.fake.state.permissions.some((p) => p.response === 'reject'), 8000, 'reject recorded');
      // hết hạn: task mới qua /tasks (xong task trước đã tự về menu IDLE)
      await runFirstTask(w);
      const n0 = w.fake.state.permissions.length;
      await waitFor(
        () => w.fake.state.permissions.length > n0 &&
          w.fake.state.permissions.at(-1).response === 'reject',
        8000,
        'auto reject'
      );
    } finally {
      await w.close();
    }
  });

  it('4. /stop giữa chừng -> abort + hàng đợi xóa + dùng tiếp được', async () => {
    const w = await makeWorld({
      onPrompt: async (sid) => {
        await sleep(20);
        w.fake.emitSession(sid, [
          { properties: { status: { type: 'busy' } }, type: 'session.status' }
        ]);
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      await sleep(400);
      await w.sendCommand('/stop');
      await waitFor(() => w.fake.state.aborts.length >= 1, 8000, 'aborted');
      await waitFor(() => w.rec.sent.some((s) => s.text.includes('Đã dừng')), 8000, 'stopped msg');
      // dùng tiếp được
      w.fake.state.onPrompt = async (sid) => {
        await sleep(20);
        w.fake.emitSession(sid, [
          { properties: { status: { type: 'busy' } }, type: 'session.status' },
          { properties: { info: { id: 'm2', role: 'assistant' } }, type: 'message.updated' },
          { properties: { part: { id: 'p2', messageID: 'm2', text: 'xong nhanh', type: 'text' } }, type: 'message.part.updated' },
          { type: 'session.idle' }
        ]);
      };
      await w.sendText('việc nhanh');
      await waitFor(() => w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('✅ task-e2e Done')), 15000, 'reuse ok');
    } finally {
      await w.close();
    }
  });

  it('5. retry 5 lần -> báo + nút Dừng -> abort + lỗi model', async () => {
    const w = await makeWorld({
      onPrompt: async (sid) => {
        await sleep(20);
        w.fake.emitSession(sid, [{ properties: { status: { type: 'busy' } }, type: 'session.status' }]);
        for (let i = 1; i <= 5; i++) {
          await sleep(30);
          w.fake.emitSession(sid, [{
            properties: { sessionID: sid, status: { attempt: i, message: 'Endpoint is unavailable', type: 'retry' } },
            type: 'session.status'
          }]);
        }
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      const notice = await waitFor(() => w.rec.sent.find((s) => s.text.includes('thử lại')), 10000, 'retry notice');
      const stopBtn = notice.reply_markup.inline_keyboard.flat().find((b) => b.text === 'Dừng');
      assert.ok(stopBtn && stopBtn.callback_data === 'go:stop-task');
      await waitFor(() => w.fake.state.aborts.length >= 1, 10000, 'auto abort');
      await waitFor(
        () => w.rec.sent.some((s) => s.text.includes('OPENCODE_MODEL_PROVIDER')),
        10000,
        'model error'
      );
    } finally {
      await w.close();
    }
  });

  it('6+13. timeout -> tự chạy lại 3 lượt rồi ❌ + ⛔; tasks.json ghi TIMEOUT', async () => {
    const w = await makeWorld({
      configOver: { firstProgressMs: 60000, mmoCodeTimeoutMs: 800, taskTimeoutMs: 800 },
      onPrompt: async () => {}
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      await waitFor(() => w.fake.state.aborts.length >= 3, 15000, 'timeout abort x3');
      await waitFor(() => w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('tự chạy lại')), 15000, 'auto retry');
      await waitFor(() => w.rec.sent.some((s) => typeof s.text === 'string' && s.text.startsWith('❌ Hết giờ')), 20000, 'final timeout');
      await waitFor(() => w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('⛔ task-e2e stop')), 20000, 'stop line');
      // tasks.json ghi nhận TIMEOUT (không gộp ERROR)
      const tasks = JSON.parse(fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8'));
      assert.ok(tasks.some((t) => t.kind === 'MMO' && t.status === 'TIMEOUT'), JSON.stringify(tasks.slice(-3)));
    } finally {
      await w.close();
    }
  });

  it('7. prompt không event -> lỗi hướng dẫn chọn model', async () => {
    const w = await makeWorld({
      configOver: { firstProgressMs: 400 },
      onPrompt: async () => {}
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      await waitFor(() => w.rec.sent.some((s) => s.text.includes('OPENCODE_MODEL_PROVIDER')), 15000, 'model hint');
    } finally {
      await w.close();
    }
  });

  it('8. SSE đứt giữa chừng -> nối lại -> DONE bằng messages', async () => {
    const w = await makeWorld({
      configOver: { resyncIntervalMs: 1200 },
      onPrompt: async (sid) => {
        await sleep(20);
        w.fake.emitSession(sid, [{ properties: { status: { type: 'busy' } }, type: 'session.status' }]);
        await sleep(60);
        w.fake.killSse();
        w.fake.state.statusMap[sid] = { type: 'idle' };
        w.fake.state.messagesMap[sid] = [{ parts: [{ text: 'lấy từ messages', type: 'text' }], role: 'assistant' }];
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      const final = await waitFor(() => w.rec.sent.find((s) => typeof s.text === 'string' && s.text.includes('✅ task-e2e Done')), 20000, 'resync done');
      assert.ok(final);
      assert.ok(!w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('lấy từ messages')), 'text lấy sau idle cũng ẩn');
    } finally {
      await w.close();
    }
  });

  it('9. người lạ nhắn tin -> không phản hồi, log ID', async () => {
    const w = await makeWorld({});
    try {
      await w.sendText('tôi là ai', STRANGER);
      await sleep(500);
      assert.equal(w.rec.sent.length, 0);
      const log = fs.readFileSync(path.join(tmp, 'bot.log'), 'utf8');
      assert.ok(log.includes('999'));
    } finally {
      await w.close();
    }
  });

  it('10. text khi IDLE -> menu + nhắc', async () => {
    const w = await makeWorld({});
    try {
      await w.sendText('alo');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      assert.ok(w.rec.sent.some((s) => s.text.includes('Chọn 1 mục trước')));
    } finally {
      await w.close();
    }
  });

  it('11. shutdown qua nút PC: YES 1 lần / NO không gọi / YES 2 lần 1 lần / hết hạn EXPIRED', async () => {
    async function openShutdownConfirm(ww) {
      await ww.sendCommand('/start');
      await waitFor(() => ww.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await ww.click(ww.buttonData('ON/OFF PC'));
      await waitFor(() => ww.rec.sent.some((s) => s.text === 'ON/OFF PC:'), 8000, 'pc menu');
      await ww.click(ww.buttonData('Tắt PC sau 60s'));
      // Lấy confirm MỚI NHẤT (tránh bấm lại nút của confirm cũ đã hết hạn).
      return waitFor(
        () => [...ww.rec.sent].reverse().find((s) => typeof s.text === 'string' && s.text.includes('TẮT MÁY') && !s.text.includes('Đã đặt')),
        8000,
        'confirm'
      );
    }
    const w = await makeWorld({});
    try {
      let confirm = await openShutdownConfirm(w);
      const yesData = confirm.reply_markup.inline_keyboard.flat().find((b) => b.text.startsWith('YES')).callback_data;
      await w.click(yesData, USER, confirm.message_id);
      await w.click(yesData, USER, confirm.message_id);
      await sleep(400);
      assert.equal(w.execCalls.length, 1);
      assert.ok(w.execCalls[0].exe.toLowerCase().endsWith('shutdown.exe'));
      assert.deepEqual(w.execCalls[0].args, ['/s', '/t', '60']);
      // NO
      confirm = await openShutdownConfirm(w);
      const noData = confirm.reply_markup.inline_keyboard.flat().find((b) => b.text.startsWith('NO')).callback_data;
      await w.click(noData, USER, confirm.message_id);
      await sleep(300);
      assert.equal(w.execCalls.length, 1);
    } finally {
      await w.close();
    }
    // hết hạn với TTL ngắn (timer SỬA tin nhắn, không gửi tin mới)
    const w2 = await makeWorld({ powerOver: { confirmTtlMs: 300 } });
    try {
      await openShutdownConfirm(w2);
      await waitFor(() => w2.rec.sent.find((s) => s.text.includes('TẮT MÁY')), 8000, 'confirm3');
      await waitFor(() => w2.rec.edits.some((e) => e.text && e.text.includes('Hết hạn')), 8000, 'expired msg');
      assert.equal(w2.execCalls.length, 0);
      const tasks = JSON.parse(fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8'));
      assert.ok(tasks.some((t) => t.status === 'EXPIRED'));
    } finally {
      await w2.close();
    }
  });

  it('12. output lớn/token: ẩn khỏi chat, tin nào cũng ≤4000', async () => {
    const big = `${TOKEN_LIKE}\n${'A'.repeat(5000)}\n${TOKEN_LIKE}`;
    const w = await makeWorld({
      onPrompt: async (sid) => {
        await sleep(20);
        w.fake.emitSession(sid, [
          { properties: { status: { type: 'busy' } }, type: 'session.status' },
          { properties: { info: { id: 'm-big', role: 'assistant' } }, type: 'message.updated' },
          { properties: { part: { id: 'p-big', messageID: 'm-big', text: big, type: 'text' } }, type: 'message.part.updated' },
          { type: 'session.idle' }
        ]);
      }
    });
    try {
      await w.sendCommand('/start');
      await waitFor(() => w.rec.sent.some((s) => s.text === 'Chọn tác vụ:'), 8000, 'menu');
      await runFirstTask(w);
      await waitFor(() => w.rec.sent.some((s) => typeof s.text === 'string' && s.text.includes('✅ task-e2e Done')), 15000, 'final');
      for (const s of w.rec.sent) {
        assert.ok(s.text.length > 0 && s.text.length <= 4000, `len=${s.text.length}`);
        assert.ok(!s.text.includes(TOKEN_LIKE), 'token phải bị che mọi nơi');
        assert.ok(!s.text.includes('A'.repeat(100)), 'text AI dài không echo ra chat');
      }
    } finally {
      await w.close();
    }
  });
});
