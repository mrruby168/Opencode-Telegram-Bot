import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, loadConfig } from '../src/config.js';

const BASE = {
  OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
  TELEGRAM_ALLOWED_USERS: '1784770769',
  TELEGRAM_BOT_TOKEN: 'fake-token-for-test'
};

describe('loadConfig', () => {
  it('loads defaults', () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.opencodeBin, 'opencode');
    assert.equal(c.opencodeProjectDir, DEFAULTS.opencodeProjectDir);
    assert.equal(c.opencodeServerPort, 4096);
    assert.equal(c.opencodeServerUsername, 'opencode');
    assert.equal(c.taskTimeoutMs, 30 * 60 * 1000);
    assert.equal(c.permissionTtlMs, 5 * 60 * 1000);
    assert.deepEqual([...c.allowedUsers], [1784770769]);
  });

  it('missing TELEGRAM_BOT_TOKEN throws naming the var', () => {
    const { TELEGRAM_BOT_TOKEN, ...rest } = BASE;
    assert.throws(() => loadConfig(rest), /TELEGRAM_BOT_TOKEN/);
  });

  it('NaN user id throws naming TELEGRAM_ALLOWED_USERS', () => {
    assert.throws(
      () => loadConfig({ ...BASE, TELEGRAM_ALLOWED_USERS: '1784770769,abc' }),
      /TELEGRAM_ALLOWED_USERS/
    );
  });

  it('empty user list throws', () => {
    assert.throws(() => loadConfig({ ...BASE, TELEGRAM_ALLOWED_USERS: '  ' }), /TELEGRAM_ALLOWED_USERS/);
  });

  it('non-local host is rejected', () => {
    assert.throws(
      () => loadConfig({ ...BASE, OPENCODE_SERVER_URL: 'http://192.168.1.2:4096' }),
      /OPENCODE_SERVER_URL/
    );
    assert.throws(
      () => loadConfig({ ...BASE, OPENCODE_SERVER_URL: 'https://example.com' }),
      /OPENCODE_SERVER_URL/
    );
  });

  it('localhost and custom port accepted', () => {
    const c = loadConfig({ ...BASE, OPENCODE_SERVER_URL: 'http://localhost:4097' });
    assert.equal(c.opencodeServerPort, 4097);
  });

  it('bad TASK_TIMEOUT_MS throws', () => {
    assert.throws(() => loadConfig({ ...BASE, TASK_TIMEOUT_MS: 'abc' }), /TASK_TIMEOUT_MS/);
  });

  it('mmo defaults: code 60p, task 30p, idle 10p, wait 15p, mmoDir theo project', () => {
    const c = loadConfig({ ...BASE });
    assert.equal(c.mmoCodeTimeoutMs, 60 * 60 * 1000);
    assert.equal(c.mmoTaskTimeoutMs, 30 * 60 * 1000);
    assert.equal(c.mmoIdleTimeoutMs, 10 * 60 * 1000);
    assert.equal(c.permissionWaitMaxMs, 15 * 60 * 1000);
    assert.equal(c.mmoDir, `${c.opencodeProjectDir}\\MMO\\Mmo`);
    const custom = loadConfig({ ...BASE, MMO_CODE_TIMEOUT_MS: '3600000', MMO_DIR: 'X:\\M' });
    assert.equal(custom.mmoCodeTimeoutMs, 3600000);
    assert.equal(custom.mmoDir, 'X:\\M');
    assert.throws(() => loadConfig({ ...BASE, MMO_CODE_TIMEOUT_MS: 'abc' }), /MMO_CODE_TIMEOUT_MS/);
  });

  it('model: null when unset, pair required', () => {
    assert.equal(loadConfig({ ...BASE }).opencodeModel, null);
    const c = loadConfig({ ...BASE, OPENCODE_MODEL_ID: 'm', OPENCODE_MODEL_PROVIDER: 'p' });
    assert.deepEqual(c.opencodeModel, { modelID: 'm', providerID: 'p' });
    assert.throws(() => loadConfig({ ...BASE, OPENCODE_MODEL_PROVIDER: 'p' }), /OPENCODE_MODEL_ID/);
    assert.throws(() => loadConfig({ ...BASE, OPENCODE_MODEL_ID: 'm' }), /OPENCODE_MODEL_PROVIDER/);
  });
});
