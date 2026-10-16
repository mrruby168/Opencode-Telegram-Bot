// Red-check: chạy test HIỆN TẠI trên src CŨ (backup) để chứng minh test bắt đúng lỗi.
// Dùng: node scripts/redcheck.mjs [testfile...]  (mặc định: runner power server permission convo status-log model)
// Không nằm trong npm test. Dọn thư mục tạm sau khi xong.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BACKUP = path.join(ROOT, '_backup', '20260929-1618');
const WORK = path.join(ROOT, '_redcheck', 'old');

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['runner.test.js', 'power.test.js', 'server.test.js', 'permission.test.js', 'convo.test.js', 'status-log.test.js', 'model.test.js'];

fs.rmSync(path.join(ROOT, '_redcheck'), { force: true, recursive: true });
fs.mkdirSync(path.join(WORK, 'src'), { recursive: true });
fs.mkdirSync(path.join(WORK, 'test'), { recursive: true });
for (const f of fs.readdirSync(path.join(BACKUP, 'src'))) {
  fs.copyFileSync(path.join(BACKUP, 'src', f), path.join(WORK, 'src', f));
}
for (const d of ['fixtures', 'helpers']) {
  const from = path.join(ROOT, 'test', d);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(WORK, 'test', d), { recursive: true });
}
for (const f of files) {
  fs.copyFileSync(path.join(ROOT, 'test', f), path.join(WORK, 'test', f));
}
fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ type: 'module' }));

console.log(`red-check src=${BACKUP}`);
for (const f of files) {
  try {
    const out = execFileSync(process.execPath, ['--test', `test/${f}`], { cwd: WORK, timeout: 120000 });
    console.log(`--- ${f}: XANH (không bắt được lỗi cũ?!) ---`);
    console.log(String(out).split('\n').filter((l) => l.includes('pass') || l.includes('fail')).join(' | ').slice(0, 200));
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    const pass = (out.match(/pass (\d+)/) || [])[1];
    const fail = (out.match(/fail (\d+)/) || [])[1];
    console.log(`--- ${f}: ĐỎ pass=${pass} fail=${fail} (đúng kỳ vọng) ---`);
  }
}
fs.rmSync(path.join(ROOT, '_redcheck'), { force: true, recursive: true });
console.log('redcheck cleanup done');
