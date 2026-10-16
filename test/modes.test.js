import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBS,
  SUB_KEYS,
  TOP_MODES,
  folderOfMode,
  isSubMode,
  mmoModeFor,
  toPlainText
} from '../src/modes.js';
import { buildTaskPrompt } from '../src/mmo-tasks.js';

describe('modes TASK/PC (v4)', () => {
  it('đúng 2 top mode TASK/PC, không còn AIRDROP_NEWS', () => {
    assert.deepEqual(TOP_MODES, ['TASK', 'PC']);
    assert.deepEqual(SUB_KEYS, []);
    assert.deepEqual(SUBS, {});
    assert.ok(!isSubMode('AIRDROP_NEWS'));
  });

  it('mode MMO:<folder> nhận diện đúng, không suy từ tên', () => {
    assert.ok(isSubMode('MMO:task_01-build-pc'));
    assert.equal(folderOfMode('MMO:task_01-build-pc'), 'task_01-build-pc');
    assert.equal(mmoModeFor('task-x'), 'MMO:task-x');
    assert.ok(!isSubMode('TASK') && !isSubMode(null) && !isSubMode('MMO:'));
  });

  it('prompt task dùng projectDir từ config, bỏ qua B0, có rule-mmo', () => {
    const p = buildTaskPrompt({
      folder: 'task-a',
      leg: 1,
      mmoDir: 'X:\\Proj\\MMO\\Mmo',
      projectDir: 'X:\\Proj',
      userText: 'làm đi'
    });
    assert.ok(p.includes('X:\\Proj\\AGENTS.md'));
    assert.ok(p.includes('X:\\Proj\\MMO\\Mmo\\Rule\\rule-mmo.md'));
    assert.ok(p.includes('Bỏ qua bước liệt kê'));
    assert.ok(p.includes('task-a\\task\\task.md'));
    assert.ok(!p.includes('D:\\'));
  });

  it('prompt lượt tiếp theo dặn đọc progress, không bịa', () => {
    const p = buildTaskPrompt({
      folder: 'task-a',
      leg: 2,
      mmoDir: 'X:\\M',
      projectDir: 'X:\\P',
      userText: 'x'
    });
    assert.ok(p.includes('lượt 2/3'));
    assert.ok(p.includes('không bịa tiến độ'));
  });

  it('toPlainText bỏ **, __, `, # đầu dòng', () => {
    const out = toPlainText('Dự án **L1**, cost **0**\n# Tiêu đề\n> trích\n`code` và __nhấn mạnh__');
    assert.ok(!out.includes('**') && !out.includes('__') && !out.includes('`'), out);
    assert.ok(out.includes('Dự án L1, cost 0'));
    assert.ok(out.includes('Tiêu đề') && !out.includes('# Tiêu đề'));
  });
});
