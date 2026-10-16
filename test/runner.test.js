import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.js';
import { normalizeEvent } from '../src/events.js';

const DIR = 'D:\\AI-AGENT';
const SID = 'ses-test-1';

function fakeClient(log = {}) {
  return {
    event: {
      subscribe: async () => {
        throw new Error('should use injected subscribeFn');
      }
    },
    session: {
      abort: async ({ path }) => {
        log.aborted = path.id;
        return { data: true };
      },
      create: async () => ({ data: { id: SID } }),
      messages: async () => [{ role: 'assistant', parts: [{ type: 'text', text: 'final' }] }],
      promptAsync: async () => {
        log.prompted = (log.prompted || 0) + 1;
        return {};
      }
    }
  };
}

function scriptedStream(events) {
  // events: [{at, event}] — at = ms delay từ lúc bắt đầu
  return async function* () {
    const t0 = Date.now();
    for (const { at, event } of events) {
      const wait = t0 + at - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      yield event;
    }
  };
}

const idleEv = { properties: { sessionID: SID }, type: 'session.idle' };
const idleByStatusEv = { properties: { sessionID: SID, status: { type: 'idle' } }, type: 'session.status' };
const msgEv = (id, role) => ({ properties: { info: { id, role, sessionID: SID }, sessionID: SID }, type: 'message.updated' });
const textEv = (mid, t, pid) => ({
  properties: { part: { id: pid || `p-${mid}`, messageID: mid, text: t, type: 'text' }, sessionID: SID },
  type: 'message.part.updated'
});
const busyEv = { properties: { sessionID: SID, status: { type: 'busy' } }, type: 'session.status' };
const USER_TEXT = [msgEv('m-u', 'user'), textEv('m-u', 'lệnh của tôi ')];
const ASST_TEXT = (t) => [msgEv('m-a', 'assistant'), textEv('m-a', t)];

describe('runner', () => {
  it('idle đúng session -> DONE + chỉ gom text assistant', async () => {
    const texts = [];
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: { onText: async ({ text }) => texts.push(text) },
      subscribeFn: scriptedStream([
        { at: 10, event: msgEv('m-u', 'user') },
        { at: 12, event: textEv('m-u', 'lệnh của tôi ') },
        { at: 15, event: msgEv('m-a', 'assistant') },
        { at: 20, event: textEv('m-a', 'hello ', 'pa') },
        { at: 22, event: textEv('m-a', 'world', 'pb') },
        { at: 30, event: idleEv }
      ])
    });
    const { promise } = r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 });
    const res = await promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.ok(!res.text.includes('lệnh của tôi'), 'text user không được lẫn vào đáp án');
    assert.ok(res.text.includes('hello'));
    assert.ok(texts.length >= 1);
  });

  it('idle qua session.status event -> DONE', async () => {
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      subscribeFn: scriptedStream([
        { at: 10, event: msgEv('m-a', 'assistant') },
        { at: 12, event: textEv('m-a', ' xong') },
        { at: 20, event: idleByStatusEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.ok(res.text.includes('xong'));
  });

  it('bỏ qua event của session khác', async () => {
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 5000 },
      hooks: {},
      subscribeFn: scriptedStream([
        { at: 10, event: { properties: { sessionID: 'ses-other' }, type: 'session.idle' } },
        { at: 15, event: busyEv },
        { at: 20, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.equal(res.sessionId, SID);
  });

  it('timeout khi không có idle -> abort thật', async () => {
    const log = {};
    const r = createRunner({
      client: fakeClient(log),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 300 },
      hooks: {},
      subscribeFn: scriptedStream([])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'TIMEOUT');
    assert.equal(log.aborted, SID);
  });

  it('stop -> abort session đang chạy', async () => {
    const log = {};
    const r = createRunner({
      client: fakeClient(log),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      subscribeFn: scriptedStream([])
    });
    const { promise } = r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 });
    await new Promise((res) => setTimeout(res, 50));
    const stopped = r.stop(1);
    assert.equal(stopped.aborted, true);
    const res = await promise;
    r.close();
    assert.equal(res.status, 'ABORTED');
    assert.equal(log.aborted, SID);
  });

  it('chờ permission thì tạm dừng timeout', async () => {
    const permEv = {
      properties: { id: 'perm-1', sessionID: SID, title: 'run cmd', type: 'bash' },
      type: 'permission.asked'
    };
    const replied = [];
    const client = fakeClient();
    client.postSessionIdPermissionsPermissionId = async () => {
      replied.push(1);
      return { data: true };
    };
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 400 },
      hooks: {
        onPermission: async () => {
          await new Promise((res) => setTimeout(res, 600));
          return 'reject';
        },
        onText: async () => {}
      },
      subscribeFn: scriptedStream([
        { at: 10, event: permEv },
        { at: 750, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.equal(replied.length, 1);
  });

  it('streaming giới hạn 1.5s (throttle)', async () => {
    let now = 0;
    let calls = 0;
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: { onText: async () => { calls += 1; } },
      nowFn: () => now,
      subscribeFn: scriptedStream([
        { at: 5, event: msgEv('m-a', 'assistant') },
        { at: 6, event: textEv('m-a', 'a', 'p1') },
        { at: 7, event: textEv('m-a', 'b', 'p2') },
        { at: 8, event: busyEv },
        { at: 9, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.ok(res.text.includes('a') && res.text.includes('b'));
    assert.ok(calls <= 2, `calls=${calls}`);
  });

  it('normalize: tool + permission v1/v2 + question', () => {
    const tool = normalizeEvent({
      properties: { part: { filename: 'a.txt', tool: 'edit', type: 'tool' }, sessionID: SID },
      type: 'message.part.updated'
    });
    assert.equal(tool.kind, 'tool');
    assert.ok(tool.note.includes('a.txt'));
    const v1 = normalizeEvent({
      properties: { id: 'p1', sessionID: SID, title: 'run', type: 'bash' },
      type: 'permission.updated'
    });
    assert.equal(v1.kind, 'permission');
    const v2 = normalizeEvent({ properties: { sessionID: SID }, type: 'permission.asked' });
    assert.equal(v2.kind, 'permission');
    const q = normalizeEvent({ properties: { sessionID: SID }, type: 'question.asked' });
    assert.equal(q.kind, 'question');
    const busy = normalizeEvent({ properties: { sessionID: SID, status: { type: 'busy' } }, type: 'session.status' });
    assert.equal(busy.kind, 'status');
  });

  it('watchdog: im lặng -> poll status idle -> DONE, không báo', async () => {
    let silent = 0;
    const client = fakeClient();
    client.session.status = async () => ({ data: { [SID]: { type: 'idle' } } });
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: { onSilent: async () => { silent += 1; } },
      subscribeFn: scriptedStream([]),
      watchdogMs: 300
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.equal(silent, 0);
  });

  it('watchdog: vẫn busy -> báo 1 lần + nút Dừng, task tiếp tục', async () => {
    let silent = 0;
    const client = fakeClient();
    client.session.status = async () => ({ data: { [SID]: { type: 'busy' } } });
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: { onSilent: async () => { silent += 1; } },
      subscribeFn: scriptedStream([{ at: 100, event: busyEv }, { at: 1200, event: idleEv }]),
      watchdogMs: 300
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.equal(silent, 1);
  });

  it('404 khi prompt -> tạo session mới, thử lại 1 lần', async () => {
    const log = { created: 0 };
    const client = fakeClient(log);
    let n = 0;
    client.session.promptAsync = async () => {
      n += 1;
      if (n === 1) throw new Error('session.prompt: 404 NotFound');
      return {};
    };
    client.session.create = async () => {
      log.created += 1;
      return { data: { id: `ses-new-${log.created}` } };
    };
    const store = { data: {}, get(m) { return this.data[m] || null; }, set(m, v) { this.data[m] = v; } };
    store.set('CODE', 'ses-old');
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      sessionStore: store,
      subscribeFn: scriptedStream([
        { at: 20, event: { properties: { sessionID: 'ses-new-1', status: { type: 'busy' } }, type: 'session.status' } },
        { at: 30, event: { properties: { sessionID: 'ses-new-1' }, type: 'session.idle' } }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.equal(res.sessionId, 'ses-new-1');
    assert.equal(store.get('CODE'), 'ses-new-1');
  });

  it('P0-1: part tích lũy 3 bước -> thay thế, không nhân đôi', async () => {
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      subscribeFn: scriptedStream([
        { at: 5, event: busyEv },
        { at: 6, event: msgEv('m-a', 'assistant') },
        { at: 10, event: textEv('m-a', 'Xin', 'p1') },
        { at: 15, event: textEv('m-a', 'Xin chào', 'p1') },
        { at: 20, event: textEv('m-a', 'Xin chào bạn', 'p1') },
        { at: 25, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.equal(res.text, 'Xin chào bạn');
  });

  it('P0-1: nhiều part nối bằng dòng trống; delta cộng dồn', async () => {
    const deltaEv = (mid, pid, d) => ({
      properties: { delta: d, part: { id: pid, messageID: mid, type: 'text' }, sessionID: SID },
      type: 'message.part.updated'
    });
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      subscribeFn: scriptedStream([
        { at: 5, event: busyEv },
        { at: 6, event: msgEv('m-a', 'assistant') },
        { at: 10, event: textEv('m-a', 'phần một', 'pa') },
        { at: 12, event: textEv('m-a', 'phần hai', 'pb') },
        { at: 14, event: deltaEv('m-a', 'pb', ' + thêm') },
        { at: 20, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.text, 'phần một\n\nphần hai + thêm');
  });

  it('P0-1: part đến trước role -> giữ tạm, phân loại sau, user bị loại', async () => {
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      subscribeFn: scriptedStream([
        { at: 5, event: busyEv },
        { at: 6, event: textEv('m-x', 'đoán?', 'px') },
        { at: 8, event: textEv('m-y', 'đáp án', 'py') },
        { at: 10, event: msgEv('m-x', 'user') },
        { at: 12, event: msgEv('m-y', 'assistant') },
        { at: 20, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.text, 'đáp án');
  });

  it('P0-1: part synthetic/ignored bị bỏ', async () => {
    const synthEv = {
      properties: { part: { id: 'ps', messageID: 'm-a', synthetic: true, text: 'rác', type: 'text' }, sessionID: SID },
      type: 'message.part.updated'
    };
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      hooks: {},
      subscribeFn: scriptedStream([
        { at: 5, event: busyEv },
        { at: 6, event: msgEv('m-a', 'assistant') },
        { at: 8, event: synthEv },
        { at: 10, event: textEv('m-a', 'sạch', 'p1') },
        { at: 20, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.text, 'sạch');
  });

  it('P0-4: idle đến trước busy/message bị bỏ qua', async () => {
    const log = { aborted: null };
    const client = fakeClient(log);
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 3000 },
      firstProgressMs: 60000,
      hooks: {},
      subscribeFn: scriptedStream([{ at: 10, event: idleEv }])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    // idle sớm bị bỏ qua → hết timeout (và abort), không DONE sớm
    assert.equal(res.status, 'TIMEOUT');
    assert.equal(log.aborted, SID);
  });

  it('P0-2: chuỗi retry từ fixture -> 5 lần abort + ERROR model', async () => {
    const fs = await import('node:fs');
    const fxPath = new URL('./fixtures/events-smoke.json', import.meta.url);
    const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'));
    const retries = [];
    for (const p of fx.prompts) {
      for (const e of p.events) {
        if (e?.type === 'session.status' && e?.properties?.status?.type === 'retry') {
          const clone = JSON.parse(JSON.stringify(e));
          clone.properties.sessionID = SID;
          retries.push(clone);
        }
      }
    }
    // Fixture smoke thay đổi theo model thật từng lần chạy (có thể không còn retry
    // storm); thiếu retry thật thì dựng đúng shape đã đo để giữ tính quyết định.
    while (retries.length < 5) {
      retries.push({
        properties: { sessionID: SID, status: { attempt: retries.length + 1, message: 'Endpoint is unavailable', type: 'retry' } },
        type: 'session.status'
      });
    }
    const seen = [];
    const log = {};
    const client = fakeClient(log);
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 60000 },
      firstProgressMs: 60000,
      hooks: {
        onRetry: async ({ attempt, message }) => { seen.push({ attempt, message }); }
      },
      subscribeFn: (async function* () {
        yield busyEv;
        for (const e of retries.slice(0, 5)) yield e;
      })
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(seen.length, 5, 'đúng 5 lần retry rồi abort');
    assert.equal(log.aborted, SID);
    assert.equal(res.status, 'ERROR');
    assert.ok(/OPENCODE_MODEL_PROVIDER/.test(res.error || ''));
  });

  it('P0-2: tiến triển reset đếm retry', async () => {
    let retries = 0;
    const client = fakeClient();
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      firstProgressMs: 60000,
      hooks: { onRetry: async () => { retries += 1; } },
      subscribeFn: scriptedStream([
        { at: 5, event: busyEv },
        { at: 10, event: { properties: { sessionID: SID, status: { type: 'retry' } }, type: 'session.status' } },
        { at: 15, event: msgEv('m-a', 'assistant') },
        { at: 16, event: textEv('m-a', 'tiếp tục', 'p1') },
        { at: 20, event: { properties: { sessionID: SID, status: { type: 'retry' } }, type: 'session.status' } },
        { at: 30, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(retries, 2);
    assert.equal(res.status, 'DONE');
  });

  it('P0-3: prompt xong 30s không dấu hiệu -> ERROR chọn model', async () => {
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 60000 },
      firstProgressMs: 200,
      hooks: {},
      subscribeFn: scriptedStream([])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'ERROR');
    assert.ok(/OPENCODE_MODEL_PROVIDER/.test(res.error || ''));
  });

  it('P0-6: đứt stream rồi nối lại, server idle -> DONE', async () => {
    let calls = 0;
    const client = fakeClient();
    client.session.status = async () => ({ data: { [SID]: { type: 'idle' } } });
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 15000 },
      firstProgressMs: 60000,
      hooks: {},
      subscribeFn: async () => {
        calls += 1;
        if (calls === 1) {
          // stream đầu: busy rồi treo luôn (mô phỏng đứt mà SDK không báo)
          return (async function* () {
            yield busyEv;
            await new Promise(() => {});
            yield busyEv;
          })();
        }
        return (async function* () {
          await new Promise(() => {});
          yield busyEv;
        })();
      }
    });
    const { promise } = r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 });
    await new Promise((res) => setTimeout(res, 300));
    await r.resyncNow();
    const res = await promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.ok(res.text.includes('final'), 'lấy text từ messages khi resync');
  });

  it('P1-1: hai permission xếp hàng FIFO, reply đúng id', async () => {
    const mkPerm = (id) => ({ properties: { id, sessionID: SID, title: 'x', type: 'bash' }, type: 'permission.asked' });
    const replied = [];
    const client = fakeClient();
    client.postSessionIdPermissionsPermissionId = async ({ path, body }) => {
      replied.push({ id: path.permissionID, response: body.response });
      return { data: true };
    };
    const answers = ['once', 'always'];
    const r = createRunner({
      client,
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      firstProgressMs: 60000,
      hooks: { onPermission: async () => answers.shift() || 'reject' },
      subscribeFn: scriptedStream([
        { at: 5, event: busyEv },
        { at: 10, event: mkPerm('perm-1') },
        { at: 15, event: mkPerm('perm-2') },
        { at: 400, event: idleEv }
      ])
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'DONE');
    assert.deepEqual(replied.map((x) => x.id), ['perm-1', 'perm-2']);
    assert.deepEqual(replied.map((x) => x.response), ['once', 'always']);
  });

  it('P1-2: session.error đọc properties.error.data.message', async () => {
    const errEv = {
      properties: { error: { data: { message: 'boom-provider' }, name: 'UnknownError' }, sessionID: SID },
      type: 'session.error'
    };
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 10000 },
      firstProgressMs: 60000,
      hooks: {},
      subscribeFn: async function* () {
        yield { properties: { sessionID: SID, status: { type: 'busy' } }, type: 'session.status' };
        yield errEv;
      }
    });
    const res = await r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 }).promise;
    r.close();
    assert.equal(res.status, 'ERROR');
    assert.ok(/boom-provider/.test(res.error || ''));
  });
});
