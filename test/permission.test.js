import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPermissionText,
  canAlways,
  createPermissionRegistry,
  PERMISSION_TTL_DEFAULT_MS
} from '../src/permissions.js';
import { normalizeEvent } from '../src/events.js';

const USERS = new Set([1784770769]);
const PERM_BASH = { id: 'p1', messageID: 'm1', sessionID: 's1', title: 'run', type: 'bash' };
const PERM_EDIT_IN = {
  id: 'p2',
  messageID: 'm1',
  pattern: 'D:\\AI-AGENT\\CODE\\a.txt',
  sessionID: 's1',
  title: 'edit',
  type: 'edit'
};

describe('permission registry', () => {
  it('once/always/reject', () => {
    const r = createPermissionRegistry({ ttlMs: 60000 });
    for (const [code, action] of [['o', 'once'], ['a', 'always'], ['r', 'reject']]) {
      const { nonce } = r.ask({ allowAlways: true, permission: PERM_EDIT_IN, sessionId: 's1', userId: 1784770769 });
      const res = r.resolve({ allowedUsers: USERS, data: `pm:${nonce}:${code}`, userId: 1784770769 });
      assert.equal(res.action, action);
      assert.equal(res.sessionId, 's1');
    }
  });

  it('always không hiện với bash', () => {
    assert.equal(canAlways({ permission: PERM_BASH, projectDir: 'D:\\AI-AGENT' }), false);
    const r = createPermissionRegistry({ ttlMs: 60000 });
    const { buttons } = r.ask({ allowAlways: false, permission: PERM_BASH, sessionId: 's', userId: 1 });
    assert.equal(buttons.length, 2);
    assert.ok(buttons.every((b) => Buffer.byteLength(b.data, 'utf8') <= 64));
  });

  it('always hiện với edit trong project', () => {
    assert.equal(canAlways({ permission: PERM_EDIT_IN, projectDir: 'D:\\AI-AGENT' }), true);
    assert.equal(
      canAlways({
        permission: { ...PERM_EDIT_IN, pattern: 'C:\\Windows\\x.txt' },
        projectDir: 'D:\\AI-AGENT'
      }),
      false
    );
  });

  it('nonce sai / hết hạn / action lạ -> reject', async () => {
    const expired = [];
    const r = createPermissionRegistry({ onExpire: (e) => expired.push(e), ttlMs: 30 });
    const { nonce } = r.ask({ allowAlways: true, permission: PERM_BASH, sessionId: 's', userId: 1784770769 });
    assert.deepEqual(r.resolve({ allowedUsers: USERS, data: 'pm:deadbeef:o', userId: 1784770769 }).reason, 'expired');
    assert.deepEqual(r.resolve({ allowedUsers: USERS, data: 'pm:oops', userId: 1784770769 }).reason, 'invalid');
    await new Promise((res) => setTimeout(res, 80));
    assert.equal(expired.length, 1);
    assert.deepEqual(r.resolve({ allowedUsers: USERS, data: `pm:${nonce}:o`, userId: 1784770769 }).reason, 'expired');
  });

  it('người lạ -> reject + giữ whitelist', () => {
    const r = createPermissionRegistry({ ttlMs: 60000 });
    const { nonce } = r.ask({ allowAlways: true, permission: PERM_BASH, sessionId: 's', userId: 1784770769 });
    const res = r.resolve({ allowedUsers: USERS, data: `pm:${nonce}:o`, userId: 999 });
    assert.equal(res.action, 'reject');
    assert.equal(res.reason, 'stranger');
  });

  it('text che secret + cắt 300 ký tự', () => {
    const t = buildPermissionText({ ...PERM_BASH, title: 'x'.repeat(500), type: 'bash 8939343073:AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw' });
    assert.ok(t.length <= 301);
    assert.ok(!t.includes('AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw'));
  });

  it('default TTL = 5 phút', () => {
    assert.equal(PERMISSION_TTL_DEFAULT_MS, 5 * 60 * 1000);
  });

  it('question: buttons + resolve answer', () => {
    const r = createPermissionRegistry({ ttlMs: 60000 });
    const q = r.askQuestion({
      question: { options: [{ label: 'A' }, { label: 'B' }], question: 'Chọn?' },
      sessionId: 's',
      userId: 1784770769
    });
    assert.equal(q.buttons.length, 2);
    const res = r.resolveQuestion({ allowedUsers: USERS, data: `q:${q.nonce}:1`, userId: 1784770769 });
    assert.equal(res.action, 'answer');
    assert.equal(res.index, 1);
  });

  it('fixture thật: normalize mọi event không crash (hiện chưa có permission live)', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'events-smoke.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let permLike = 0;
    for (const p of data.prompts) {
      for (const e of p.events) {
        const n = normalizeEvent(e);
        assert.ok(n && typeof n.kind === 'string');
        if (n.kind === 'permission' || n.kind === 'question') permLike += 1;
      }
    }
    assert.equal(permLike, 0, 'fixture hiện tại chưa có event permission/question live (UNVERIFIED)');
  });
});
