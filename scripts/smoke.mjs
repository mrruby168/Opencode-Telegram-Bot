// Smoke test CÓ KIỂM SOÁT — chạy tay, KHÔNG nằm trong npm test.
// Cổng 4097, cwd thư mục tạm, mật khẩu smoke cố định (không phải secret thật),
// tự dọn tiến trình + thư mục khi xong. Không dùng cổng 4096, không đụng tiến trình khác.
// Env tay: SMOKE_OPENCODE_BIN, SMOKE_PORT, SMOKE_MODEL="provider/model".
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, listProviders, pickModel, promptAsync, sessionAbort, sessionCreate, sessionMessages, sessionStatus } from '../src/opencode-exec.js';
import { maskSecrets } from '../src/common.js';
import { healthCheck } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');

const PORT = Number(process.env.SMOKE_PORT || 4097);
const BIN = process.env.SMOKE_OPENCODE_BIN || process.env.OPENCODE_BIN || 'opencode';
const SMOKE_PW = 'tele-smoke-pw';

function say(s) {
  console.log(s);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Dọn serve do chính smoke spawn. Windows + shell:true: kill shell không tới
// opencode.exe cháu → liệt kê con trực tiếp của shell (read-only) rồi kill đúng
// các pid đó, không đụng tiến trình khác. Cuối cùng verify health DOWN.
async function cleanupServe(child, authed, directory) {
  let kids = [];
  if (child?.pid && process.platform === 'win32') {
    try {
      const q = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { timeout: 15000 }).toString();
      kids = out.split(/[\r\n\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    } catch { /* bỏ qua: chỉ kill shell */ }
  }
  try {
    child?.kill();
  } catch { /* bỏ qua */ }
  for (const pid of kids) {
    try {
      process.kill(pid);
    } catch { /* đã thoát trước */ }
  }
  for (let i = 0; i < 5; i++) {
    await sleep(1000);
    const h = await healthCheck({ statusFn: (ms) => sessionStatus(authed, { directory }, ms) });
    if (h !== 'OK') {
      say(`serve stopped (health=${h})`);
      return;
    }
  }
  say('WARN: serve smoke vẫn OK sau cleanup (kiểm tra tay tiến trình serve --port 4097 của lượt này, KHÔNG kill bừa)');
}

function extractAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : messages?.messages ?? [];
  const texts = [];
  for (const m of list) {
    if (!m || m.role === 'user') continue;
    for (const part of m.parts ?? []) {
      if (part?.type === 'text' && part.text) texts.push(part.text);
    }
  }
  return texts.join('\n');
}

// real-run.json: synthetic:false khi có lượt model hoàn tất (test P0-1 dùng);
// synthetic:true + reason khi không model nào chạy được (giữ nhãn, UNVERIFIED).
function writeRealRun(data) {
  try {
    const dir = path.join(PROJECT, 'test', 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    const payload = { collectedAt: new Date().toISOString(), ...(data || { synthetic: true, reason: 'skipped' }) };
    fs.writeFileSync(path.join(dir, 'real-run.json'), JSON.stringify(payload, null, 2));
    say(`real-run saved (synthetic=${payload.synthetic === true})`);
  } catch (e) {
    say(`real-run save ERR ${String(e?.message ?? e).slice(0, 120)}`);
  }
}

async function collectEvents(authed, directory, ms) {
  const events = [];
  try {
    const sub = await authed.event.subscribe({ directory }, {});
    const stream = sub?.stream;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      return { events, stream: 'NO-UNVERIFIED' };
    }
    const deadline = Date.now() + ms;
    for await (const value of stream) {
      events.push(value);
      if (events.length >= 500 || Date.now() > deadline) break;
    }
  } catch (e) {
    events.push({ type: 'smoke.collect-error', properties: { message: String(e?.message ?? e).slice(0, 120) } });
  }
  return { events, stream: 'asyncIterator' };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tele-smoke-'));
  say(`tmp=${tmp}`);
  // opencode.json trong thư mục TẠM để ép permission ask (kích hoạt event xin quyền).
  fs.writeFileSync(
    path.join(tmp, 'opencode.json'),
    JSON.stringify({ permission: { bash: 'ask', edit: 'ask' } }, null, 2)
  );
  let child = null;
  const authed = createClient({ baseUrl: `http://127.0.0.1:${PORT}`, password: SMOKE_PW, username: 'opencode' });
  const report = { collectedAt: new Date().toISOString(), prompts: [] };
  try {
    try {
      child = spawn(BIN, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
        cwd: tmp,
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: SMOKE_PW },
        // Windows: BIN là .ps1/.cmd nên phải qua shell (giống src/server.js); không nối input.
        shell: process.platform === 'win32',
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (e) {
      say(`SKIP: cannot spawn ${BIN}: ${e?.message ?? e}`);
      return;
    }
    child.once('error', () => {});

    let health = 'DOWN';
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      health = await healthCheck({ statusFn: (ms) => sessionStatus(authed, { directory: tmp }, ms) });
      if (health === 'OK') break;
    }
    say(`health=${health}`);
    if (health !== 'OK') {
      say('SKIP: server not OK (ghi lý do cụ thể: xem health + log serve nếu có)');
      return;
    }

    // 1. providers/models (KHÔNG in key, chỉ in có/không).
    let providers = [];
    try {
      const res = await listProviders(authed, { directory: tmp }, 15000);
      providers = res.providers || [];
      report.defaults = res.defaults || {};
    } catch (e) {
      say(`providers=ERR ${maskSecrets(String(e?.message ?? e)).slice(0, 200)}`);
    }
    const summary = providers.map((p) => ({
      connected: !!p?.key,
      id: p?.id,
      models: Object.keys(p?.models || {}).length,
      name: p?.name,
      source: p?.source
    }));
    say(`providers=${JSON.stringify(summary)}`);
    report.providers = summary;

    const picked = pickModel(providers, process.env.SMOKE_MODEL || null);
    say(`picked=${picked ? `${picked.providerID}/${picked.modelID} (${picked.reason})` : 'NONE'}`);
    report.picked = picked ? { modelID: picked.modelID, providerID: picked.providerID, reason: picked.reason } : null;
    // Ứng viên tối đa 3 model: env > connected-free-active > connected > còn lại.
    const cands = [];
    const seen = new Set();
    const consider = (m) => {
      if (!m) return;
      const k = `${m.providerID}/${m.modelID}`;
      if (!seen.has(k) && cands.length < 3) {
        seen.add(k);
        cands.push(m);
      }
    };
    consider(picked);
    for (const p of providers) {
      for (const [mid, m] of Object.entries(p?.models || {})) {
        const free = (m?.cost?.input || 0) === 0 && (m?.cost?.output || 0) === 0;
        if (p?.key && free && m?.status === 'active') consider({ connected: true, modelID: mid, providerID: p.id, reason: 'connected-free-active' });
      }
    }
    for (const p of providers) {
      for (const [mid] of Object.entries(p?.models || {})) {
        if (p?.key) consider({ connected: true, modelID: mid, providerID: p.id, reason: 'connected-first' });
      }
    }
    for (const p of providers) {
      for (const [mid] of Object.entries(p?.models || {})) {
        consider({ connected: !!p?.key, modelID: mid, providerID: p.id, reason: 'first-available' });
      }
    }
    say(`candidates=${cands.map((c) => `${c.providerID}/${c.modelID}`).join('|') || 'NONE'}`);
    report.candidates = cands.map((c) => ({ modelID: c.modelID, providerID: c.providerID, reason: c.reason }));
    if (cands.length === 0) {
      say('SKIP: không có model nào (ghi lý do cụ thể: providers rỗng hoặc không model)');
      writeRealRun(null);
      return;
    }

    // 2. Thử từng ứng viên (mỗi model ≤60s): prompt "một chữ OK", đọc messages.
    // Lượt hoàn tất đầu tiên → real-run.json (synthetic:false) để test P0-1 dùng.
    let model = { modelID: cands[0].modelID, providerID: cands[0].providerID };
    let okRun = null;
    const modelErrors = [];
    for (const cand of cands) {
      const m = { modelID: cand.modelID, providerID: cand.providerID };
      const s = await sessionCreate(authed, { directory: tmp, title: 'smoke-ok' }, 15000);
      say(`try=${cand.providerID}/${cand.modelID} s=${s?.id || 'MISSING'}`);
      if (!s?.id) {
        modelErrors.push({ error: 'session.create missing id', model: `${cand.providerID}/${cand.modelID}` });
        continue;
      }
      const collecting = collectEvents(authed, tmp, 40000);
      try {
        await promptAsync(authed, { directory: tmp, model: m, sessionId: s.id, text: 'trả lời đúng một chữ OK' }, 15000);
        say(`try-accepted=${cand.providerID}/${cand.modelID}`);
      } catch (e) {
        say(`try-ERR=${cand.providerID}/${cand.modelID} ${maskSecrets(String(e?.message ?? e)).slice(0, 200)}`);
      }
      const r = await collecting;
      const types = [...new Set(r.events.map((e) => e?.type))];
      say(`try-events=${r.events.length} types=${types.join(',')}`);
      report.prompts.push({ events: r.events, kind: `harmless:${cand.providerID}/${cand.modelID}` });
      let answerText = '';
      try {
        const msgs = await sessionMessages(authed, { directory: tmp, sessionId: s.id }, 15000);
        answerText = extractAssistantText(msgs);
        say(`try-answer=${JSON.stringify(answerText.slice(0, 80))}`);
      } catch (e) {
        say(`try-messages=ERR ${maskSecrets(String(e?.message ?? e)).slice(0, 120)}`);
      }
      try {
        await sessionAbort(authed, { directory: tmp, sessionId: s.id }, 10000);
      } catch { /* bỏ qua */ }
      if (answerText.trim() === 'OK') {
        okRun = { answerText, eventTypes: types, modelID: m.modelID, providerID: m.providerID };
        model = m;
        break;
      }
      modelErrors.push({ error: answerText ? `answer=${JSON.stringify(answerText.slice(0, 80))}` : 'no-OK-answer', model: `${cand.providerID}/${cand.modelID}` });
    }
    if (okRun) {
      say(`OK-RUN=${okRun.providerID}/${okRun.modelID}`);
      writeRealRun({ ...okRun, synthetic: false });
    } else {
      say(`NO-MODEL-OK errors=${JSON.stringify(modelErrors).slice(0, 400)}`);
      report.modelErrors = modelErrors;
      writeRealRun({ reason: 'no-model-completed', candidates: report.candidates, errors: modelErrors, synthetic: true });
    }

    // 3. Việc cần permission (tạo file trong thư mục tạm, permission ask).
    const s2 = await sessionCreate(authed, { directory: tmp, title: 'smoke-permission' }, 15000);
    say(`s2=${s2?.id || 'MISSING'}`);
    if (s2?.id) {
      const collecting = collectEvents(authed, tmp, 60000);
      try {
        await promptAsync(
          authed,
          { directory: tmp, model, sessionId: s2.id, text: 'tạo file hello-smoke.txt trong thư mục hiện tại với nội dung OK' },
          15000
        );
        say('prompt2=accepted');
      } catch (e) {
        say(`prompt2=ERR ${maskSecrets(String(e?.message ?? e)).slice(0, 200)}`);
      }
      const r2 = await collecting;
      say(`prompt2.events=${r2.events.length} types=${[...new Set(r2.events.map((e) => e?.type))].join(',')}`);
      report.prompts.push({ events: r2.events, kind: 'permission' });
      try {
        await sessionAbort(authed, { directory: tmp, sessionId: s2.id }, 10000);
      } catch { /* bỏ qua */ }
    }

    const dir = path.join(PROJECT, 'test', 'fixtures');
    fs.mkdirSync(dir, { recursive: true });
    report.aiContent = !!okRun; // true: có lượt model hoàn tất; false: chỉ event hệ thống (UNVERIFIED AI)
    fs.writeFileSync(path.join(dir, 'events-smoke.json'), JSON.stringify(report, null, 2));
    say('fixture saved test/fixtures/events-smoke.json');
  } finally {
    try {
      await cleanupServe(child, authed, tmp);
    } catch { /* bỏ qua */ }
    try {
      fs.rmSync(tmp, { force: true, recursive: true });
    } catch { /* bỏ qua */ }
    say('cleanup done');
  }
}

await main();
