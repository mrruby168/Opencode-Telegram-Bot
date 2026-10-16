// 2 MODE duy nhất: TASK (chạy task MMO theo folder, single task) / PC.
// Task MMO dùng mode `MMO:<folder>` (xem mmo-tasks.js). AIRDROP_NEWS đã bỏ ở v4.
export const TOP_MODES = ['TASK', 'PC'];

// Giữ export rỗng để state.js (MODES = SUB_KEYS) và code cũ không vỡ import.
export const SUBS = {};
export const SUB_KEYS = [];

export { folderOfMode, mmoModeFor, MMO_MODE_PREFIX } from './mmo-tasks.js';
import { folderOfMode as _folderOfMode } from './mmo-tasks.js';

export function isSubMode(mode) {
  return _folderOfMode(mode) !== null;
}

// Đầu ra chỉ text thuần: bỏ dấu markdown còn sót (Telegram plain text không render).
export function toPlainText(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s{0,3}#{1,6}\s/, '').replace(/^\s{0,3}>\s?/, ''))
    .join('\n');
}
