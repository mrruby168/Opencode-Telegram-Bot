import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.js';
import { startFakeOpencode } from './helpers/fake-opencode.js';
import { createClient } from '../src/opencode-exec.js';

const DIR = 'D:\\AI-AGENT';
const SID = 'ses-test-1';

function fakeClient() {
  return {
    event: {
      subscribe: async () => {
        throw new Error('should use injected subscribeFn');
      }
    },
    session: {
      abort: async () => ({ data: true }),
      create: async () => ({ data: { id: SID } }),
      messages: async () => [],
      promptAsync: async () => ({}),
      status: async () => ({ data: {} })
    }
  };
}

describe('watcher close (treo npm test)', () => {
  it('close() gọi stream.return() để ngắt for-await treo', async () => {
    let returnCalled = false;
    async function* infinite() {
      yield { properties: { sessionID: SID, status: { type: 'busy' } }, type: 'session.status' };
      await new Promise(() => {}); // treo như SSE thật khi mất kết nối
      yield { properties: { sessionID: SID }, type: 'session.idle' };
    }
    const r = createRunner({
      client: fakeClient(),
      config: { opencodeProjectDir: DIR, taskTimeoutMs: 600 },
      firstProgressMs: 60000,
      hooks: {},
      subscribeFn: async () => {
        const gen = infinite();
        const origReturn = gen.return.bind(gen);
        gen.return = (...a) => {
          returnCalled = true;
          return origReturn(...a);
        };
        return gen;
      }
    });
    const { promise } = r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 });
    await new Promise((res) => setTimeout(res, 150));
    r.close();
    const res = await promise;
    assert.equal(res.status, 'TIMEOUT');
    assert.equal(returnCalled, true, 'close() phải gọi stream.return() để ngắt SSE treo');
  });

  it('subscribe thật truyền AbortSignal và abort khi close()', async () => {
    const fake = await startFakeOpencode();
    let r = null;
    try {
      const client = createClient({ baseUrl: fake.url });
      let captured = null;
      const orig = client.event.subscribe.bind(client.event);
      client.event.subscribe = async (opts) => {
        captured = opts;
        return orig(opts);
      };
      r = createRunner({
        client,
        config: { opencodeProjectDir: DIR, taskTimeoutMs: 8000 },
        firstProgressMs: 60000,
        hooks: {}
      });
      const { promise } = r.submit({ mode: 'CODE', promptText: 'hi', userId: 1 });
      await new Promise((res) => setTimeout(res, 300));
      fake.emitSession('ses-e2e-1', [
        { properties: { status: { type: 'busy' } }, type: 'session.status' }
      ]);
      await new Promise((res) => setTimeout(res, 200));
      fake.emitSession('ses-e2e-1', [{ type: 'session.idle' }]);
      const res = await promise;
      assert.equal(res.status, 'DONE');
      r.close();
      assert.ok(captured && 'signal' in captured, 'subscribe phải truyền signal (dừng retry SDK)');
      assert.equal(captured.signal.aborted, true, 'close() phải abort SSE để SDK dừng retry');
    } finally {
      try {
        r?.close();
      } catch { /* bỏ qua */ }
      // runner đã close ở trên; fake đóng sạch (fallback timer đã clear)
      await fake.close();
    }
  });
});
