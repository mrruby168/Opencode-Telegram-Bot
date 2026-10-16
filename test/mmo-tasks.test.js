import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_LEGS,
  createMmoRunRegistry,
  createTaskPickRegistry,
  loadMmoQueue,
  markInterrupted,
  mmoModeFor,
  folderOfMode,
  readTaskBotConfig,
  removeMmoQueueRow,
  resolveTaskTimeout,
  scanMmoTasks,
  taskConfirmKeyboard,
  taskListKeyboard,
  taskRunKeyboard,
  upsertMmoQueueRow
} from '../src/mmo-tasks.js';

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-mmo-'));
  process.env.TELE_LOG_DIR = tmp;
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function makeMmo(names) {
  const dir = path.join(tmp, 'Mmo');
  for (const n of names) {
    fs.mkdirSync(path.join(dir, n, 'task'), { recursive: true });
    fs.writeFileSync(path.join(dir, n, 'task', 'task.md'), '# TASK\nlàm đi\n');
  }
  // Folder Rule + folder không task phải bị loại.
  fs.mkdirSync(path.join(dir, 'Rule'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'notask'), { recursive: true });
  return dir;
}

describe('scanMmoTasks', () => {
  it('liệt kê folder có task/task.md, loại Rule/notask, sort tên', () => {
    const dir = makeMmo(['task-b', 'task-a']);
    assert.deepEqual(scanMmoTasks(dir), ['task-a', 'task-b']);
  });

  it('thư mục không tồn tại -> rỗng, không throw', () => {
    assert.deepEqual(scanMmoTasks(path.join(tmp, 'nope')), []);
  });
});

describe('readTaskBotConfig + resolveTaskTimeout', () => {
  it('thiếu bot.json -> {} -> default code 60p', () => {
    const dir = makeMmo(['t1']);
    assert.deepEqual(readTaskBotConfig(path.join(dir, 't1')), {});
    assert.equal(resolveTaskTimeout(path.join(dir, 't1'), {}), 60 * 60 * 1000);
  });

  it('bot.json type normal -> 30p; timeoutMs hợp lệ được ưu tiên', () => {
    const dir = makeMmo(['t1']);
    fs.writeFileSync(
      path.join(dir, 't1', 'task', 'bot.json'),
      JSON.stringify({ timeoutMs: 5 * 60 * 1000, type: 'normal' })
    );
    assert.equal(resolveTaskTimeout(path.join(dir, 't1'), {}), 5 * 60 * 1000);
  });

  it('bot.json type automation không timeoutMs -> 30p; type code -> 60p', () => {
    const dir = makeMmo(['a', 'c']);
    fs.writeFileSync(path.join(dir, 'a', 'task', 'bot.json'), JSON.stringify({ type: 'automation' }));
    fs.writeFileSync(path.join(dir, 'c', 'task', 'bot.json'), JSON.stringify({ type: 'code' }));
    assert.equal(resolveTaskTimeout(path.join(dir, 'a'), {}), 30 * 60 * 1000);
    assert.equal(resolveTaskTimeout(path.join(dir, 'c'), {}), 60 * 60 * 1000);
  });

  it('bot.json hỏng/sai -> bỏ qua, type lạ -> 60p an toàn', () => {
    const dir = makeMmo(['t1']);
    fs.writeFileSync(path.join(dir, 't1', 'task', 'bot.json'), '{hong');
    assert.deepEqual(readTaskBotConfig(path.join(dir, 't1')), {});
    assert.equal(resolveTaskTimeout(path.join(dir, 't1'), {}), 60 * 60 * 1000);
  });
});

describe('pick registry single (bấm nút + xác minh OK/Cancel)', () => {
  it('runPicked 1 index; OK one-shot; OK lần 2 -> dup', () => {
    const reg = createTaskPickRegistry({ ttlMs: 60000 });
    const rec = reg.open({ folders: ['b', 'a'], userId: 1 });
    const r = reg.runPicked(rec.nonce, 1, 1);
    assert.ok(r.ok);
    assert.equal(r.folder, 'a');
    const ok = reg.confirmOk(rec.nonce, 1);
    assert.ok(ok.ok);
    assert.equal(ok.folder, 'a');
    assert.equal(reg.confirmOk(rec.nonce, 1).reason, 'dup');
  });

  it('người lạ bị từ chối; index sai -> invalid', () => {
    const reg = createTaskPickRegistry({ ttlMs: 60000 });
    const rec = reg.open({ folders: ['a'], userId: 1 });
    assert.equal(reg.runPicked(rec.nonce, 0, 999).reason, 'stranger');
    assert.equal(reg.runPicked(rec.nonce, 9, 1).reason, 'invalid');
    assert.equal(reg.runPicked(rec.nonce, -1, 1).reason, 'invalid');
  });

  it('cancel: xóa pending, giữ rec để bấm task khác', () => {
    const reg = createTaskPickRegistry({ ttlMs: 60000 });
    const rec = reg.open({ folders: ['a', 'b'], userId: 1 });
    assert.ok(reg.runPicked(rec.nonce, 1, 1).ok);
    assert.ok(reg.confirmCancel(rec.nonce, 1).ok);
    const r2 = reg.runPicked(rec.nonce, 0, 1);
    assert.ok(r2.ok);
    assert.equal(r2.folder, 'a');
    assert.ok(reg.confirmOk(rec.nonce, 1).ok);
  });

  it('nonce lạ -> expired; OK khi chưa pick -> nopending', () => {
    const reg = createTaskPickRegistry({ ttlMs: 60000 });
    assert.equal(reg.runPicked('deadbeefcafe', 0, 1).reason, 'expired');
    const rec = reg.open({ folders: ['a'], userId: 1 });
    assert.equal(reg.confirmOk(rec.nonce, 1).reason, 'nopending');
    assert.ok(reg.cancel(rec.nonce, 1).ok);
    assert.equal(reg.runPicked(rec.nonce, 0, 1).reason, 'expired');
  });

  it('callback_data luôn ≤64 byte; list mỗi task 1 nút 1 hàng', () => {
    const kb = taskConfirmKeyboard('abcdef123456');
    const texts = kb.inline_keyboard.flat().map((b) => b.text);
    assert.deepEqual(texts, ['OK', 'Cancel']);
    for (const row of kb.inline_keyboard) {
      for (const b of row) {
        assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, b.callback_data);
      }
    }
    const list = taskListKeyboard('abcdef123456', ['task-a', 'task-b']);
    assert.equal(list.inline_keyboard.length, 2);
    assert.deepEqual(list.inline_keyboard.flat().map((b) => b.text), ['task-a', 'task-b']);
    for (const row of list.inline_keyboard) {
      for (const b of row) {
        assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, b.callback_data);
      }
    }
    const rk = taskRunKeyboard('abcdef123456', true);
    for (const row of rk.inline_keyboard) {
      for (const b of row) {
        assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, b.callback_data);
      }
    }
    assert.ok((MAX_LEGS) === 3);
  });
});

describe('run registry + queue persist', () => {
  it('claim cont nhiều lần qua get (không one-shot), skip/stop one-shot', () => {
    const reg = createMmoRunRegistry({ ttlMs: 60000 });
    const rec = reg.open({ folders: ['a', 'b'], userId: 1 });
    assert.ok(reg.get(rec.nonce, 1).ok);
    assert.ok(reg.get(rec.nonce, 1).ok); // cont bấm nhiều lượt được
    assert.ok(reg.claim(rec.nonce, 'skip', 1).ok);
    assert.equal(reg.claim(rec.nonce, 'skip', 1).reason, 'dup');
    assert.equal(reg.get(rec.nonce, 999).reason, 'stranger');
  });

  it('persist queue atomic + restart đánh INTERRUPTED', () => {
    const dir = path.join(tmp, 'logs');
    upsertMmoQueueRow(dir, { folders: ['a'], idx: 0, nonce: 'n1', status: 'running', userId: 1 });
    upsertMmoQueueRow(dir, { folders: ['b'], idx: 0, nonce: 'n2', status: 'DONE', userId: 1 });
    assert.equal(loadMmoQueue(dir).length, 2);
    const { count, rows } = markInterrupted(dir);
    assert.equal(count, 1);
    assert.deepEqual(rows.map((r) => r.nonce), ['n1']);
    removeMmoQueueRow(dir, 'n1');
    assert.equal(loadMmoQueue(dir).length, 1);
  });

  it('mmoModeFor/folderOfMode round-trip', () => {
    assert.equal(mmoModeFor('x'), 'MMO:x');
    assert.equal(folderOfMode('MMO:x'), 'x');
    assert.equal(folderOfMode('nope'), null);
  });
});
