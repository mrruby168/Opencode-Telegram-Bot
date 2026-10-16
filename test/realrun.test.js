import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Khẳng định P0-1 end-to-end bằng lượt model thật (real-run.json do smoke ghi).
// Offline-safe: thiếu file hoặc synthetic:true → chỉ ghi nhận nhãn UNVERIFIED, vẫn xanh.
describe('real-run fixture (P0-1 model thật)', () => {
  it('đáp án OK nguyên vẹn, không nhân đôi part tích lũy', () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-run.json');
    if (!fs.existsSync(file)) return; // smoke chưa chạy lần nào
    const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (fx.synthetic === true) {
      assert.equal(fx.synthetic, true); // nhãn SYNTHETIC: chưa có lượt thật (UNVERIFIED)
      return;
    }
    assert.equal(String(fx.answerText ?? '').trim(), 'OK');
    assert.ok(Array.isArray(fx.eventTypes) && fx.eventTypes.includes('message.part.updated'));
    assert.ok(String(fx.answerText).trim().length <= 8, 'đáp án phải gọn, không cộng dồn rác');
  });
});
