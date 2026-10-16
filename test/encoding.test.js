import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FILES = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

describe('encoding', () => {
  it('mọi file src/ không BOM', () => {
    assert.ok(FILES.length > 0);
    for (const f of FILES) {
      const buf = fs.readFileSync(path.join(SRC, f));
      const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      assert.equal(bom, false, f);
    }
  });

  it('không ký tự CJK', () => {
    const cjk = /[㐀-䶿一-鿿]/;
    for (const f of FILES) {
      const t = fs.readFileSync(path.join(SRC, f), 'utf8');
      assert.equal(cjk.test(t), false, f);
    }
  });

  it('có mẫu tiếng Việt có dấu', () => {
    const all = FILES.map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
    assert.ok(
      /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(all)
    );
  });
});
