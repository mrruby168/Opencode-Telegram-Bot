import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskQueue } from '../src/common.js';

function tick(ms = 5) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('createTaskQueue', () => {
  it('rảnh -> position 0 (chạy ngay, không báo xếp hàng)', async () => {
    const q = createTaskQueue();
    const a = q.enqueue(async () => 'A');
    assert.equal(a.position, 0);
    assert.equal(await a.promise, 'A');
  });

  it('runs sequentially in order', async () => {
    const q = createTaskQueue();
    const order = [];
    const a = q.enqueue(async () => {
      await tick(10);
      order.push('a');
      return 'A';
    });
    const b = q.enqueue(async () => {
      order.push('b');
      return 'B';
    });
    assert.equal(b.position, 1);
    assert.deepEqual([await a.promise, await b.promise], ['A', 'B']);
    assert.deepEqual(order, ['a', 'b']);
  });

  it('stop clears waiting and aborts running; later commands still run', async () => {
    const q = createTaskQueue();
    let aborted = false;
    const gate = q.enqueue(async (api) => {
      api.setAbort(() => {
        aborted = true;
      });
      await tick(30);
      return 'gate';
    });
    const w1 = q.enqueue(async () => 'w1');
    const w2 = q.enqueue(async () => 'w2');
    await tick(5);
    const res = q.stop();
    assert.equal(res.aborted, true);
    assert.equal(res.cleared, 2);
    assert.equal(aborted, true);
    assert.deepEqual(await w1.promise, { stopped: true });
    assert.deepEqual(await w2.promise, { stopped: true });
    await gate.promise;
    const after = q.enqueue(async () => 'after');
    assert.equal(await after.promise, 'after');
  });

  it('size counts running + waiting', async () => {
    const q = createTaskQueue();
    assert.equal(q.size, 0);
    const a = q.enqueue(async () => {
      await tick(15);
      return 1;
    });
    q.enqueue(async () => 2);
    await tick(2);
    assert.equal(q.size, 2);
    assert.equal(q.busy, true);
    await a.promise;
  });

  it('pause aborts running nhưng GIỮ hàng đợi (resume được)', async () => {
    const q = createTaskQueue();
    let aborted = false;
    const gate = q.enqueue(async (api) => {
      api.setAbort(() => {
        aborted = true;
      });
      await tick(30);
      return 'gate';
    });
    const w1 = q.enqueue(async () => 'w1');
    await tick(5);
    const res = q.pause();
    assert.equal(res.aborted, true);
    assert.equal(aborted, true);
    assert.equal(await w1.promise, 'w1', 'hàng đợi không bị xóa');
    await gate.promise;
  });

  it('pause khi rảnh -> aborted false, không crash', async () => {
    const q = createTaskQueue();
    assert.deepEqual(q.pause(), { aborted: false });
  });
});
