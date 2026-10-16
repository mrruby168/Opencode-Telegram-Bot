import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServerManager, healthCheck } from '../src/server.js';
import { basicAuthHeader } from '../src/opencode-exec.js';

const CONFIG = { opencodeBin: 'opencode', opencodeProjectDir: 'D:\\AI-AGENT', opencodeServerPort: 4199 };

describe('basicAuthHeader', () => {
  it('null when no password', () => {
    assert.equal(basicAuthHeader('opencode', ''), null);
  });
  it('Basic base64(user:pass)', () => {
    assert.equal(
      basicAuthHeader('opencode', 'pw'),
      'Basic ' + Buffer.from('opencode:pw').toString('base64')
    );
  });
});

describe('healthCheck', () => {
  it('OK', async () => {
    assert.equal(await healthCheck({ statusFn: async () => ({}) }), 'OK');
  });
  it('401 -> UNAUTHORIZED', async () => {
    const e = new Error('session.status: {"error":{"status":401}}');
    assert.equal(await healthCheck({ statusFn: async () => { throw e; } }), 'UNAUTHORIZED');
  });
  it('fetch failed/timeout -> DOWN', async () => {
    assert.equal(
      await healthCheck({ statusFn: async () => { throw new Error('fetch failed'); } }),
      'DOWN'
    );
    assert.equal(
      await healthCheck({ statusFn: async () => { throw new Error('session.status timeout after 3000ms'); } }),
      'DOWN'
    );
  });
});

function mockSpawn(log) {
  const handlers = {};
  const child = {
    fire: (ev, ...args) => {
      if (handlers[ev]) handlers[ev](...args);
    },
    on: () => {},
    once: (ev, fn) => {
      handlers[ev] = fn;
    },
    unref: () => {
      log.unrefed = true;
    }
  };
  const fn = (bin, args, opts) => {
    log.calls.push({ args, bin, opts: { ...opts, env: opts.env ? 'inherited' : 'missing' } });
    log.child = child;
    return child;
  };
  return fn;
}

function logDeps(tail = '') {
  return {
    closeFD: () => {},
    logFile: () => 'serve.log',
    openLogFD: () => 99,
    readLogTail: () => tail
  };
}

describe('ensureServer', () => {
  it('already OK -> no spawn', async () => {
    const log = { calls: [] };
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: { ...logDeps(), healthFn: async () => ({}), sleepFn: async () => {}, spawnFn: mockSpawn(log) }
    });
    assert.equal(await m.ensureServer(), 'OK');
    assert.equal(log.calls.length, 0);
  });

  it('UNAUTHORIZED -> no spawn', async () => {
    const log = { calls: [] };
    const e = new Error('401 Unauthorized');
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: { ...logDeps(),
        healthFn: async () => { throw e; },
        sleepFn: async () => {},
        spawnFn: mockSpawn(log)
      }
    });
    assert.equal(await m.ensureServer(), 'UNAUTHORIZED');
    assert.equal(log.calls.length, 0);
  });

  it('DOWN -> spawn with fixed argv/cwd/detached/unref/env, then OK', async () => {
    const log = { calls: [], unrefed: false };
    let up = false;
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: { ...logDeps(),
        healthFn: async () => {
          if (!up) throw new Error('fetch failed');
          return {};
        },
        sleepFn: async () => {
          up = true;
        },
        spawnFn: mockSpawn(log)
      }
    });
    assert.equal(await m.ensureServer(), 'OK');
    assert.equal(log.calls.length, 1);
    const c = log.calls[0];
    assert.equal(c.bin, 'opencode');
    assert.deepEqual(c.args, ['serve', '--port', '4199', '--hostname', '127.0.0.1']);
    assert.equal(c.opts.cwd, 'D:\\AI-AGENT');
    assert.equal(c.opts.detached, true);
    assert.deepEqual(c.opts.stdio, ['ignore', 99, 99]);
    assert.equal(c.opts.env, 'inherited');
    assert.equal(log.unrefed, true);
  });

  it('spawn throws -> clear error with manual hint', async () => {
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: { ...logDeps(),
        healthFn: async () => { throw new Error('fetch failed'); },
        sleepFn: async () => {},
        spawnFn: () => { throw new Error('spawn ENOENT'); }
      }
    });
    await assert.rejects(() => m.ensureServer(), /opencode serve --port 4199/);
  });

  it('never up -> timeout error after polls', async () => {
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: { ...logDeps(),
        healthFn: async () => { throw new Error('fetch failed'); },
        sleepFn: async () => {},
        spawnFn: mockSpawn({ calls: [] })
      }
    });
    await assert.rejects(() => m.ensureServer(), /30s/);
  });

  it('double ensure -> single spawn (lock)', async () => {
    const log = { calls: [] };
    let up = false;
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: { ...logDeps(),
        healthFn: async () => {
          if (!up) throw new Error('down');
          return {};
        },
        sleepFn: async () => {
          await new Promise((r) => setTimeout(r, 20));
          up = true;
        },
        spawnFn: mockSpawn(log)
      }
    });
    const [a, b] = await Promise.all([m.ensureServer(), m.ensureServer()]);
    assert.equal(a, 'OK');
    assert.equal(b, 'OK');
    assert.equal(log.calls.length, 1);
  });

  it('P1-3: timeout đọc log, phát hiện cổng bị chiếm', async () => {
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: {
        ...logDeps('listen EADDRINUSE: address already in use 127.0.0.1:4199'),
        healthFn: async () => { throw new Error('fetch failed'); },
        sleepFn: async () => {},
        spawnFn: mockSpawn({ calls: [] })
      }
    });
    await assert.rejects(() => m.ensureServer(), /cổng 4199 đang bị chiếm/);
    await assert.rejects(() => m.ensureServer(), /OPENCODE_SERVER_URL/);
  });

  it('P1-3: tiến trình thoát sớm -> báo mã + log cuối', async () => {
    const log = { calls: [] };
    const m = createServerManager({
      client: null,
      config: CONFIG,
      deps: {
        ...logDeps('ServeError: Unexpected error'),
        healthFn: async () => { throw new Error('fetch failed'); },
        sleepFn: async () => {},
        spawnFn: mockSpawn(log)
      }
    });
    const p = m.ensureServer();
    await new Promise((r) => setTimeout(r, 50));
    log.child.fire('exit', 1);
    await assert.rejects(() => p, /thoát sớm \(mã 1\)/);
    await assert.rejects(() => m.ensureServer(), /ServeError/);
  });
});
