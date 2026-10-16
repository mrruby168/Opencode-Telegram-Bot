import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDoctor, defaultExecFn } from '../scripts/doctor.mjs';

const TOKEN = '87654321:' + 'A'.repeat(35);
const PASS = 'pw-fake-doctor-1';

let tmp;
let oldEnv;
beforeEach(() => {
  oldEnv = process.env.TELE_LOG_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-doctor-'));
});
afterEach(() => {
  if (oldEnv === undefined) delete process.env.TELE_LOG_DIR;
  else process.env.TELE_LOG_DIR = oldEnv;
  fs.rmSync(tmp, { force: true, recursive: true });
});

function writeEnv(extra = {}) {
  const f = path.join(tmp, '.env.test');
  const base = {
    OPENCODE_SERVER_PASSWORD: PASS,
    OPENCODE_SERVER_URL: 'http://127.0.0.1:4096',
    TELEGRAM_ALLOWED_USERS: '1',
    TELEGRAM_BOT_TOKEN: TOKEN,
    ...extra
  };
  fs.writeFileSync(f, Object.entries(base).map(([k, v]) => `${k}=${v}`).join('\n'));
  return f;
}

function stubFetch({ status = 'OK', providers = null, getMe = 'ok' } = {}) {
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    calls.push(String(url));
    if (String(url).includes('/session/status')) {
      if (status === 'OK') return { ok: true, status: 200 };
      if (status === 'UNAUTH') return { ok: false, status: 401 };
      throw new Error('fetch failed');
    }
    if (String(url).includes('/config/providers')) {
      if (providers === 'error') throw new Error('nope');
      return { ok: true, status: 200, json: async () => providers ?? { default: {}, providers: [] } };
    }
    if (String(url).includes('api.telegram.org')) {
      if (getMe === 'ok') return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'fakebot' } }) };
      if (getMe === 'unauth') return { ok: false, status: 401 };
      throw new Error('net down');
    }
    throw new Error('unexpected url ' + url);
  };
  return { calls, fetchFn };
}

const okExec = async () => ({ err: null, out: '1.18.33\n' });

describe('doctor', () => {
  it('đủ 8 nhóm, toàn ok khi môi trường tốt', async () => {
    const { fetchFn } = stubFetch({
      providers: { default: { model: 'x' }, providers: [{ id: 'p1', key: 'k', models: { m1: {}, m2: {} } }] }
    });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn });
    assert.equal(r.groups.length, 8);
    assert.deepEqual(r.groups.map((g) => g.name), ['node', 'env', 'token', 'opencode-bin', 'powershell', 'server', 'model', 'telegram']);
    assert.equal(r.failed, false);
    assert.ok(r.lines.join('\n').includes('@fakebot'));
  });

  it('KHÔNG BAO GIỜ in giá trị bí mật', async () => {
    const { fetchFn } = stubFetch({ status: 'UNAUTH' });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn });
    const all = r.lines.join('\n');
    assert.ok(!all.includes(TOKEN), 'token phải bị giấu');
    assert.ok(!all.includes(PASS), 'password phải bị giấu');
    assert.equal(r.failed, true); // UNAUTH là lỗi nặng
  });

  it('thiếu file env → fail; token sai dạng → fail và không gọi getMe', async () => {
    const { calls, fetchFn } = stubFetch({});
    const r1 = await runDoctor({ env: {}, envFile: path.join(tmp, 'nope.env'), execFn: okExec, fetchFn });
    assert.equal(r1.failed, true);
    const r2 = await runDoctor({ env: {}, envFile: writeEnv({ TELEGRAM_BOT_TOKEN: 'sai' }), execFn: okExec, fetchFn });
    assert.equal(r2.failed, true);
    assert.ok(r2.groups.find((g) => g.name === 'token').status === 'fail');
    assert.ok(!calls.some((u) => u.includes('api.telegram.org')), 'token sai thì không gọi getMe');
  });

  it('server DOWN → warn (exit 0 khi không lỗi nặng); bin lỗi → warn', async () => {
    const { fetchFn } = stubFetch({ status: 'DOWN', providers: { default: {}, providers: [] } });
    const badExec = async () => ({ err: new Error('no bin'), out: '' });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: badExec, fetchFn, offline: true });
    assert.equal(r.groups.find((g) => g.name === 'server').status, 'warn');
    assert.equal(r.groups.find((g) => g.name === 'opencode-bin').status, 'warn');
    assert.equal(r.groups.find((g) => g.name === 'telegram').detail.includes('--offline'), true);
    assert.equal(r.failed, false);
  });

  it('không model nào → warn và gợi ý OPENCODE_MODEL_PROVIDER', async () => {
    const { fetchFn } = stubFetch({ providers: { default: {}, providers: [] } });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn, offline: true });
    const g = r.groups.find((x) => x.name === 'model');
    assert.equal(g.status, 'warn');
    assert.ok(g.detail.includes('OPENCODE_MODEL_PROVIDER'));
  });

  it('gợi ý tối đa 5 model, đánh dấu thiếu key', async () => {
    const providers = [{
      id: 'p1',
      models: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {} }
    }];
    const { fetchFn } = stubFetch({ providers: { default: {}, providers } });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn, offline: true });
    const g = r.groups.find((x) => x.name === 'model');
    assert.ok(g.detail.includes('p1/a') && g.detail.includes('p1/e'));
    assert.ok(!g.detail.includes('p1/f'), 'quá 5 thì cắt');
    assert.ok(g.detail.includes('chưa key'));
  });

  it('getMe 401 → fail (token đã thu hồi)', async () => {
    const { fetchFn } = stubFetch({ getMe: 'unauth' });
    const r = await runDoctor({ env: {}, envFile: writeEnv(), execFn: okExec, fetchFn });
    assert.equal(r.groups.find((g) => g.name === 'telegram').status, 'fail');
    assert.equal(r.failed, true);
  });

  it('exec thật: opencode --version chạy được (shell win32)', async () => {
    const r = await defaultExecFn('opencode', ['--version'], 5000);
    const v = r.out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    assert.ok(/^\d+\.\d+\.\d+/.test(v), `version=${v.slice(0, 40)}`);
  });
});
