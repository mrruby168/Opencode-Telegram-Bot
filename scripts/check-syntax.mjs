import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dirs = [path.join(root, 'src'), path.join(root, 'scripts')];

let failed = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, name.name);
    if (name.isDirectory()) { walk(file); continue; }
    if (!/\.(m?js)$/.test(name.name)) continue;
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      console.log(`OK ${path.relative(root, file)}`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL ${path.relative(root, file)}`);
      console.error(String(e.stderr || e.message || e));
    }
  }
}
for (const dir of dirs) walk(dir);
if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log('syntax OK');
