import { randomBytes } from 'node:crypto';
import { maskSecrets } from './common.js';

export const PERMISSION_TTL_DEFAULT_MS = 5 * 60 * 1000;
const CALLBACK_PREFIX = 'pm:';
const QUESTION_PREFIX = 'q:';

function shortNonce(bytes = 8) {
  return randomBytes(bytes).toString('hex');
}

function trunc(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function patternList(p) {
  const v = p?.pattern;
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

function insideDir(p, dir) {
  const norm = (s) => String(s).replace(/\//g, '\\').toLowerCase();
  const d = norm(dir);
  return norm(p).startsWith(d);
}

// "Luôn cho phép" chỉ hiện với sửa file trong project.
export function canAlways({ permission, projectDir }) {
  const type = String(permission?.type || '').toLowerCase();
  if (type !== 'edit' && type !== 'write') return false;
  const pats = patternList(permission);
  if (pats.length === 0) return false;
  return pats.every((p) => insideDir(p, projectDir));
}

export function describePermission(permission) {
  const type = permission?.type || 'unknown';
  const pats = patternList(permission);
  const what = pats.length > 0 ? pats.join(', ') : permission?.title || '';
  return `${type}: ${what}`;
}

export function buildPermissionText(permission) {
  const head = 'opencode xin quyền';
  const body = maskSecrets(describePermission(permission));
  return trunc(`${head}\n${body}`, 300);
}

export function createPermissionRegistry({ ttlMs = PERMISSION_TTL_DEFAULT_MS, onExpire = null } = {}) {
  const pending = new Map(); // nonce -> record

  function arm(record) {
    record.timer = setTimeout(() => {
      if (pending.get(record.nonce) === record) {
        pending.delete(record.nonce);
        try {
          onExpire?.({ kind: record.kind, permissionId: record.permissionId, sessionId: record.sessionId, userId: record.userId });
        } catch { /* bỏ qua */ }
      }
    }, ttlMs);
    if (typeof record.timer.unref === 'function') record.timer.unref();
  }

  // Đăng ký câu hỏi permission, trả text + buttons {text,data} (data ≤ 64 byte).
  function ask({ sessionId, userId, permission, allowAlways }) {
    const nonce = shortNonce();
    const record = {
      allowAlways: !!allowAlways,
      expiresAt: Date.now() + ttlMs,
      kind: 'perm',
      nonce,
      permissionId: permission?.id,
      sessionId,
      timer: null,
      userId
    };
    arm(record);
    pending.set(nonce, record);
    const buttons = [
      { data: `${CALLBACK_PREFIX}${nonce}:o`, text: 'Cho phép 1 lần' },
      ...(record.allowAlways ? [{ data: `${CALLBACK_PREFIX}${nonce}:a`, text: 'Luôn cho phép' }] : []),
      { data: `${CALLBACK_PREFIX}${nonce}:r`, text: 'Từ chối' }
    ];
    for (const b of buttons) {
      if (Buffer.byteLength(b.data, 'utf8') > 64) throw new Error('callback_data vượt 64 byte');
    }
    return { buttons, nonce, text: buildPermissionText(permission) };
  }

  // resolve ĐỒNG BỘ claim+delete trước mọi await của caller.
  function resolve({ allowedUsers, data, userId }) {
    const m = /^pm:([0-9a-f]+):([oar])$/.exec(String(data || ''));
    if (!m) return { action: 'reject', reason: 'invalid' };
    const [, nonce, code] = m;
    const rec = pending.get(nonce);
    if (!rec) return { action: 'reject', reason: 'expired' };
    pending.delete(nonce);
    clearTimeout(rec.timer);
    if (!allowedUsers?.has?.(userId) || userId !== rec.userId) {
      return { action: 'reject', reason: 'stranger' };
    }
    if (Date.now() > rec.expiresAt) return { action: 'reject', reason: 'expired', sessionId: rec.sessionId };
    if (code === 'a' && !rec.allowAlways) return { action: 'reject', reason: 'invalid', sessionId: rec.sessionId };
    const action = code === 'o' ? 'once' : code === 'a' ? 'always' : 'reject';
    return { action, permissionId: rec.permissionId, sessionId: rec.sessionId };
  }

  // Câu hỏi opencode: bản gọn chỉ nút có sẵn, không nhận ý kiến riêng.
  function askQuestion({ sessionId, userId, question }) {
    const nonce = shortNonce(6);
    const record = {
      allowAlways: false,
      expiresAt: Date.now() + ttlMs,
      kind: 'question',
      nonce,
      permissionId: null,
      question,
      sessionId,
      timer: null,
      userId
    };
    arm(record);
    pending.set(nonce, record);
    const title = maskSecrets(question?.question || question?.title || 'opencode đang hỏi');
    const options = Array.isArray(question?.options) ? question.options : [];
    const lines = options.map((o, i) => `${i + 1}. ${maskSecrets(o?.label || o?.title || o)}`);
    const hint = options.length > 0 ? 'Trả lời bằng nút.' : 'Trả lời bằng tin nhắn kế tiếp.';
    const text = trunc(`${trunc(title, 200)}\n${lines.join('\n')}\n\n${hint}`, 600);
    const buttons = options.slice(0, 8).map((_, i) => ({ data: `${QUESTION_PREFIX}${nonce}:${i}`, text: `${i + 1}` }));
    return { buttons, nonce, text };
  }

  function questionLabel(record, index) {
    const options = Array.isArray(record?.question?.options) ? record.question.options : [];
    const o = options[index];
    if (o == null) return '';
    return String(o?.label || o?.title || o);
  }

  function resolveQuestion({ allowedUsers, data, userId }) {
    const m = /^q:([0-9a-f]+):(\d+)$/.exec(String(data || ''));
    if (!m) return { action: 'reject', reason: 'invalid' };
    const [, nonce, idx] = m;
    const rec = pending.get(nonce);
    if (!rec || rec.kind !== 'question') return { action: 'reject', reason: 'expired' };
    pending.delete(nonce);
    clearTimeout(rec.timer);
    if (!allowedUsers?.has?.(userId) || userId !== rec.userId) {
      return { action: 'reject', reason: 'stranger' };
    }
    if (Date.now() > rec.expiresAt) return { action: 'reject', reason: 'expired', sessionId: rec.sessionId };
    const index = Number(idx);
    return { action: 'answer', index, sessionId: rec.sessionId, text: questionLabel(rec, index) };
  }

  function size() {
    return pending.size;
  }

  return { ask, askQuestion, resolve, resolveQuestion, size };
}
