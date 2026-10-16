import fs from 'node:fs';
import { stateFile, logDir } from './common.js';

// Task MMO dùng mode `MMO:<folder>` (động theo folder, không liệt kê cứng).
export const MODES = ['TASK', 'PC'];

// Session bền vững theo mode, lưu atomic.
export function loadSessions() {
  try {
    const file = stateFile();
    if (!fs.existsSync(file)) return { sessions: {} };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || typeof data.sessions !== 'object') return { sessions: {} };
    return { sessions: data.sessions };
  } catch {
    return { sessions: {} };
  }
}

export function saveSessionsAtomic(sessions) {
  fs.mkdirSync(logDir(), { recursive: true });
  const file = stateFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
  fs.renameSync(tmp, file);
}

export function getModeSession(mode) {
  return loadSessions().sessions?.[mode] || null;
}

export function setModeSession(mode, sessionId) {
  const { sessions } = loadSessions();
  sessions[mode] = sessionId;
  saveSessionsAtomic(sessions);
}

export function clearModeSession(mode) {
  const { sessions } = loadSessions();
  delete sessions[mode];
  saveSessionsAtomic(sessions);
}

// Trạng thái hội thoại theo user (bộ nhớ): IDLE | AWAIT_INPUT | RUNNING.
export function createConvoStore({ idleTtlMs = 30 * 60 * 1000, nowFn = () => Date.now() } = {}) {
  const map = new Map(); // userId -> { status, mode, lastActive }
  function get(userId) {
    const s = map.get(userId);
    if (!s) return { lastActive: 0, mode: null, status: 'IDLE' };
    if (s.status === 'AWAIT_INPUT' && nowFn() - s.lastActive > idleTtlMs) {
      map.set(userId, { lastActive: s.lastActive, mode: null, status: 'IDLE' });
      return { lastActive: s.lastActive, mode: null, status: 'IDLE' };
    }
    return s;
  }
  function set(userId, status, mode = null) {
    map.set(userId, { lastActive: nowFn(), mode, status });
  }
  function touch(userId) {
    const s = map.get(userId);
    if (s) s.lastActive = nowFn();
  }
  return { get, set, touch };
}
