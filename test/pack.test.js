import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExcluded, listReleaseFiles, scanSecrets } from '../scripts/pack.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-pack-'));
});
afterEach(() => {
  fs.rmSync(tmp, { force: true, recursive: true });
});

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

describe('pack', () => {
  it('loại trừ .env/node_modules/logs/_backup/dist/session/debug', () => {
    writeTree(tmp, {
      '.env': 'TELEGRAM_BOT_TOKEN=1:abc',
      '.env.example': 'TELEGRAM_BOT_TOKEN=put-your-token-here\n',
      'dist/old.zip': 'x',
      'logs/bot.log': 'x',
      'node_modules/a/index.js': 'x',
      'package.json': '{}',
      'src/a.js': 'ok',
      'x.session': 'x'
    });
    assert.equal(isExcluded('.env'), true);
    assert.equal(isExcluded('.env.example'), false);
    assert.equal(isExcluded('node_modules/a/index.js'), true);
    assert.equal(isExcluded('src/a.js'), false);
    const list = listReleaseFiles(tmp);
    assert.ok(list.includes('src/a.js'));
    assert.ok(list.includes('.env.example'));
    assert.ok(!list.some((f) => f.startsWith('node_modules') || f.startsWith('logs') || f.startsWith('dist')));
    assert.ok(!list.includes('.env') && !list.includes('x.session'));
  });

  it('quét bí mật: FAIL khi có token, PASS khi sạch (bỏ qua test/)', () => {
    writeTree(tmp, {
      'src/a.js': 'const t = "12345678:AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw9Q";',
      'src/b.js': 'ok',
      'test/fake.test.js': 'const t = "12345678:AAECwbqbt2xD4T8EWqmRLqeC3DRk_XRiAZw9Q";'
    });
    const hits = scanSecrets(tmp, ['src/a.js', 'src/b.js', 'test/fake.test.js']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].file, 'src/a.js');
    assert.equal(scanSecrets(tmp, ['src/b.js', 'test/fake.test.js']).length, 0);
  });

  it('.env.example có password thật → FAIL; placeholder → PASS', () => {
    writeTree(tmp, { '.env.example': 'OPENCODE_SERVER_PASSWORD=hunter2unter\n' });
    assert.ok(scanSecrets(tmp, ['.env.example']).length >= 1);
    writeTree(tmp, { '.env.example': 'OPENCODE_SERVER_PASSWORD=\nTELEGRAM_BOT_TOKEN=put-your-token-here\n' });
    assert.equal(scanSecrets(tmp, ['.env.example']).length, 0);
  });

  it('danh sách thật: đủ file mới, không mẫu bí mật', () => {
    const list = listReleaseFiles(PROJECT);
    for (const f of ['package.json', 'src/bot.js', 'scripts/doctor.mjs', 'scripts/pack.mjs', 'test/doctor.test.js', 'start-commander.cmd', 'opencode.proposed.json', 'src/screenshot.js', 'src/modes.js', 'test/modes.test.js']) {
      assert.ok(list.includes(f), `thiếu ${f}`);
    }
    for (const f of ['src/multitask.js', 'src/workflows.js', 'src/reporter.js', 'workflows/report.json']) {
      assert.ok(!list.includes(f), `phải gỡ ${f}`);
    }
    assert.ok(!list.includes('.env'));
    assert.ok(!list.some((f) => f.startsWith('node_modules/') || f.startsWith('_backup/') || f.startsWith('dist/') || f.startsWith('logs/')));
    assert.equal(scanSecrets(PROJECT, list).length, 0);
  });
});
