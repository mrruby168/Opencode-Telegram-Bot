import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chunkText, countTasks, loadTasks, maskSecrets, recordTask, saveTasksAtomic, telegramRetry } from '../src/common.js';

let tmp;
let oldEnv;

beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-common-'));
  process.env.TELE_LOG_DIR = tmp;
});

afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

describe('chunkText', () => {
  it('empty string -> no parts', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText(null), []);
  });

  it('cuts a single 5000-char line', () => {
    const parts = chunkText('x'.repeat(5000), 4000);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].length, 4000);
    assert.equal(parts[1].length, 1000);
  });

  it('no empty parts and every part within limit', () => {
    const parts = chunkText('a\n\n\nb\n' + 'y'.repeat(9000) + '\n\nc', 4000);
    assert.ok(parts.length > 0);
    for (const p of parts) {
      assert.ok(p.length > 0 && p.length <= 4000);
    }
  });

  it('short text stays in one part', () => {
    assert.deepEqual(chunkText('hello'), ['hello']);
  });
});

describe('maskSecrets', () => {
  it('masks telegram bot token', () => {
    const out = maskSecrets('token 8939343073:AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw here');
    assert.ok(!out.includes('AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw'));
    assert.ok(out.includes('[TOKEN ẨN]'));
  });

  it('masks password= and Bearer', () => {
    assert.ok(maskSecrets('password=hunter2 ok').includes('password=[ẨN]'));
    assert.ok(maskSecrets('Bearer abcdef123456 ok').includes('Bearer [ẨN]'));
  });

  it('leaves normal text alone', () => {
    assert.equal(maskSecrets('CODE DONE 3 task'), 'CODE DONE 3 task');
  });
});

describe('tasks store', () => {
  it('round-trips and counts 4 statuses', () => {
    recordTask({ cmd: '/a', kind: 'CODE', status: 'DONE' });
    recordTask({ cmd: '/b', kind: 'MMO', status: 'ERROR' });
    recordTask({ cmd: '/c', kind: 'POWER', status: 'CANCELLED' });
    recordTask({ cmd: '/d', kind: 'AIRDROP', status: 'EXPIRED' });
    const tasks = loadTasks();
    assert.equal(tasks.length, 4);
    const c = countTasks(tasks, 0);
    assert.equal(c.done, 1);
    assert.equal(c.error, 1);
    assert.equal(c.cancelled, 1);
    assert.equal(c.expired, 1);
    assert.equal(c.total, 4);
  });

  it('corrupt file is renamed, not overwritten', () => {
    const file = path.join(tmp, 'tasks.json');
    fs.writeFileSync(file, 'not-json{{{');
    assert.deepEqual(loadTasks(), []);
    const names = fs.readdirSync(tmp);
    assert.ok(names.some((n) => n.startsWith('tasks.json.corrupt-')));
    assert.ok(!names.includes('tasks.json'));
  });

  it('atomic write leaves valid JSON', () => {
    saveTasksAtomic([{ a: 1 }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8')), [{ a: 1 }]);
  });
});

describe('telegramRetry', () => {
  it('thử lại 1 lần khi 429 retry_after rồi thành công', async () => {
    let n = 0;
    const out = await telegramRetry(async () => {
      n += 1;
      if (n === 1) throw new Error('Too Many Requests: retry after 0');
      return 'ok';
    });
    assert.equal(out, 'ok');
    assert.equal(n, 2);
  });

  it('lỗi khác ném ngay, không retry', async () => {
    let n = 0;
    await assert.rejects(
      () => telegramRetry(async () => {
        n += 1;
        throw new Error('Bad Request: message is not modified');
      }),
      /not modified/
    );
    assert.equal(n, 1);
  });
});
