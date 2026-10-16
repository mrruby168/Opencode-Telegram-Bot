// pack: đóng gói phát hành tele-commander.
// Chạy tay: node scripts/pack.mjs. KHÔNG nằm trong npm test.
// Bao gồm đúng danh sách (mã nguồn, test, scripts, tài liệu, package.json,
// package-lock.json, .env.example, start-commander.cmd, opencode.proposed.json);
// loại trừ .env/.env.* (trừ .example), node_modules, logs, _backup, dist, *.session.
// Nén bằng tar -a (fallback copy sang dist/release/). FAIL nếu quét thấy mẫu bí mật
// trong src/scripts/tài liệu/config (test/ chứa token GIẢ cố ý nên bỏ qua khi quét).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');

const INCLUDE_DIRS = ['src', 'test', 'scripts'];
const INCLUDE_FILES = [
  'ARCHITECTURE.md',
  'DECISIONS.md',
  'DONE_REPORT.md',
  'PROGRESS.md',
  'RELEASE_NOTES.md',
  'PROJECT_MAP.json',
  'UI_SPEC.json',
  'PROJECT_BLUEPRINT.svg',
  'UI_PREVIEW.svg',
  'UI_PREVIEW.png',
  'package.json',
  'package-lock.json',
  '.env.example',
  'start-commander.cmd',
  'opencode.proposed.json'
];

const SECRET_PATTERNS = [
  [/\b\d{8,}:[A-Za-z0-9_-]{30,}\b/, 'bot-token'],
  [/\bsk-[A-Za-z0-9]{10,}\b/, 'sk-key'],
  [/\bghp_[A-Za-z0-9]{10,}\b/, 'ghp-key']
];

export function isExcluded(rel) {
  const p = String(rel).replace(/\\/g, '/');
  if (p === '.env.example') return false;
  const base = p.split('/').pop();
  if (base.startsWith('.env')) return true;
  if (base.endsWith('.session')) return true;
  if (base.startsWith('_diag') || base.startsWith('_redcheck') || base.startsWith('dbg-')) return true;
  for (const seg of p.split('/')) {
    if (['node_modules', 'logs', '_backup', 'dist'].includes(seg)) return true;
  }
  return false;
}

export function listReleaseFiles(root = PROJECT) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      const rel = path.relative(root, full);
      if (isExcluded(rel)) continue;
      if (name.isDirectory()) walk(full);
      else out.push(rel.replace(/\\/g, '/'));
    }
  };
  for (const d of INCLUDE_DIRS) {
    const full = path.join(root, d);
    if (fs.existsSync(full)) walk(full);
  }
  for (const f of INCLUDE_FILES) {
    if (fs.existsSync(path.join(root, f)) && !isExcluded(f)) out.push(f);
  }
  return [...new Set(out)].sort();
}

// Quét mẫu bí mật. Bỏ qua test/ + fixtures (token GIẢ cố ý cho kiểm thử mask/chunk).
// Trả [{file, kind}].
export function scanSecrets(root = PROJECT, files = null) {
  const hits = [];
  const list = files || listReleaseFiles(root);
  for (const rel of list) {
    const p = String(rel).replace(/\\/g, '/');
    if (p.startsWith('test/')) continue;
    const full = path.join(root, rel);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const [re, kind] of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ file: rel, kind });
    }
    if (p === '.env.example') {
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const key = t.slice(0, eq).trim();
        const val = t.slice(eq + 1).trim();
        if (/password|secret|api[_-]?key/i.test(key) && val && !/^(put-your|example|changeme|x+|fake)/i.test(val)) {
          hits.push({ file: rel, kind: `secret-value:${key}` });
        }
      }
    }
  }
  return hits;
}

async function main() {
  const files = listReleaseFiles(PROJECT);
  console.log(`files=${files.length}`);
  for (const f of files) console.log(' + ' + f);
  const hits = scanSecrets(PROJECT, files);
  if (hits.length > 0) {
    for (const h of hits) console.error(`SECRET-HIT ${h.file} (${h.kind})`);
    console.error('pack FAIL: phát hiện mẫu bí mật trong gói phát hành');
    process.exit(1);
  }
  const dist = path.join(PROJECT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const zip = path.join(dist, 'tele-commander-release.zip');
  try {
    if (fs.existsSync(zip)) fs.unlinkSync(zip);
  } catch { /* bỏ qua */ }
  try {
    execFileSync('tar', ['-a', '-c', '-f', zip, ...files], { cwd: PROJECT, timeout: 120000 });
    console.log(`zip OK: ${zip} (${fs.statSync(zip).size} bytes)`);
  } catch (e) {
    console.log(`tar lỗi (${String(e?.message ?? e).slice(0, 120)}): fallback copy sang dist/release/`);
    const out = path.join(dist, 'release');
    fs.rmSync(out, { force: true, recursive: true });
    for (const f of files) {
      const from = path.join(PROJECT, f);
      const to = path.join(out, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    console.log(`fallback OK: ${out} (${files.length} files)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
