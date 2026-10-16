import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promptAsync } from '../src/opencode-exec.js';

function fakeClient(captured) {
  return {
    session: {
      promptAsync: async (opts) => {
        captured.push(opts);
        if (captured.failWith) throw captured.failWith;
        return {};
      }
    }
  };
}

describe('promptAsync model', () => {
  it('truyền model vào body khi có', async () => {
    const captured = [];
    await promptAsync(fakeClient(captured), {
      directory: 'D:\\x',
      model: { modelID: 'm', providerID: 'p' },
      sessionId: 's',
      text: 'hi'
    });
    assert.deepEqual(captured[0].body.model, { modelID: 'm', providerID: 'p' });
  });

  it('không có model khi null', async () => {
    const captured = [];
    await promptAsync(fakeClient(captured), { directory: 'D:\\x', model: null, sessionId: 's', text: 'hi' });
    assert.ok(!('model' in captured[0].body));
  });

  it('lỗi thiếu model được diễn giải rõ', async () => {
    const captured = [];
    captured.failWith = new Error('session.promptAsync: no model configured');
    await assert.rejects(
      () => promptAsync(fakeClient(captured), { directory: 'D:\\x', model: null, sessionId: 's', text: 'hi' }),
      /OPENCODE_MODEL_PROVIDER/
    );
  });
});
