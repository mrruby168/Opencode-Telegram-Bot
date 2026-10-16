import { createTaskQueue, recordTask } from './common.js';
import { normalizeEvent } from './events.js';
import {
  promptAsync,
  replyPermission,
  replyQuestionText,
  sessionAbort,
  sessionCreate,
  sessionMessages,
  sessionStatus
} from './opencode-exec.js';

export const STREAM_THROTTLE_MS = 1500;
export const WATCHDOG_SILENCE_MS = 2 * 60 * 1000;

function isNotFound(e) {
  return /\b404\b|NotFound|not found/i.test(String(e?.message ?? e));
}

function extractFinalText(messages) {
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

export function createRunner({
  client,
  config,
  hooks = {},
  sessionStore = null,
  subscribeFn = null,
  nowFn = () => Date.now(),
  watchdogMs = WATCHDOG_SILENCE_MS,
  firstProgressMs = 30000,
  resyncIntervalMs = 30000
}) {
  const directory = config.opencodeProjectDir;
  const timeoutMs = config.taskTimeoutMs;
  // Idle: không event tiến triển quá lâu → TIMEOUT để user Tiếp tục (v2).
  const idleMs = Number(config.mmoIdleTimeoutMs) > 0 ? Number(config.mmoIdleTimeoutMs) : 10 * 60 * 1000;
  // Trần chờ duyệt permission/question: quá lâu → dừng an toàn thay vì kẹt queue.
  const permMaxMs = Number(config.permissionWaitMaxMs) > 0 ? Number(config.permissionWaitMaxMs) : 15 * 60 * 1000;
  const queues = new Map(); // userId -> queue
  const active = new Map(); // sessionId -> run record
  let watcherStarted = false;
  let watcherClosed = false;

  const onText = hooks.onText || (async () => {});
  const onPermission = hooks.onPermission || (async () => 'reject');
  const onSilent = hooks.onSilent || (async () => {});
  const onRetry = hooks.onRetry || (async () => {});
  // Event đến trước khi run đăng ký (race subscribe/prompt): giữ tạm để replay.
  const earlyBuffer = [];
  const EARLY_CAP = 200;

  function queueFor(userId) {
    let q = queues.get(userId);
    if (!q) {
      q = createTaskQueue();
      queues.set(userId, q);
    }
    return q;
  }

  // Watcher SSE: SDK tự retry vô hạn khi fetch lỗi (sleep 3s rồi thử lại,
  // serverSentEvents.gen.js) nên close() phải abort signal + return stream,
  // nếu không `npm test` treo sau khi e2e đã xanh (14/14) vì timer retry còn giữ loop.
  let watcherAbort = null; // AbortController cho subscribe thật (SDK nhận signal, dừng retry)
  let activeStream = null; // AsyncGenerator đang for-await (cả subscribeFn inject)
  let reconnectTimer = null;

  async function defaultSubscribe() {
    watcherAbort = new AbortController();
    const sub = await client.event.subscribe({ directory, signal: watcherAbort.signal });
    const stream = sub?.stream;
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('event.subscribe: stream không phải async iterator (UNVERIFIED shape)');
    }
    return stream;
  }

  async function resyncOne(run) {
    try {
      const st = await sessionStatus(client, { directory }, 10000);
      const map = st && typeof st === 'object' ? st : {};
      const mine = map[run.sessionId];
      if (mine && mine.type === 'idle') {
        // P0-4 cho resync: idle khi run chưa có dấu hiệu sống (vd sessionId
        // tái dùng sau abort — server vẫn báo idle cũ) thì BỎ QUA, không đánh
        // DONE nhầm. Run đã có activity mà mất event thì nhánh dưới vẫn chốt.
        if (!run.armed) return;
        if (!run.text) {
          try {
            const messages = await sessionMessages(client, { directory, sessionId: run.sessionId }, 15000);
            run.text = extractFinalText(messages);
            emitText(run, true);
          } catch { /* giữ rỗng */ }
        }
        run.finish('DONE');
      } else if (mine) {
        run.lastProgressAt = nowFn();
      }
    } catch { /* poll lỗi: giữ nguyên, chờ event/timeout */ }
  }

  // Đồng bộ định kỳ: SDK có thể tự nối lại SSE bên trong mà runner không thấy,
  // event mất trong lúc đứt sẽ không bao giờ tới. Poll nhẹ để bắt kịp idle.
  async function periodicResync(run) {
    if (nowFn() - (run.lastResyncAt || 0) < resyncIntervalMs) return;
    run.lastResyncAt = nowFn();
    await resyncOne(run);
  }

  // Đồng bộ lại các run đang chạy sau mỗi lần (nối lại) subscribe (P0-6).
  async function resyncRuns() {
    for (const run of active.values()) {
      await resyncOne(run);
    }
  }

  async function watchLoop() {
    while (!watcherClosed) {
      let stream = null;
      try {
        stream = subscribeFn ? await subscribeFn() : await defaultSubscribe();
        activeStream = stream;
        await resyncRuns();
        for await (const event of stream) {
          if (watcherClosed) break;
          routeEvent(event);
        }
      } catch {
        /* đứt stream: nối lại */
      } finally {
        if (activeStream === stream) activeStream = null;
      }
      if (watcherClosed) break;
      await new Promise((r) => {
        reconnectTimer = setTimeout(r, 2000);
        if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
      });
      reconnectTimer = null;
    }
  }

  function ensureWatcher() {
    if (!watcherStarted) {
      watcherStarted = true;
      watchLoop().catch(() => {});
    }
  }

  // Tính lại đáp án từ các part theo thứ tự xuất hiện, chỉ part của assistant.
  function refreshAnswer(run) {
    const texts = [];
    for (const e of run.parts.values()) {
      if (e.text && run.roles[e.messageId] === 'assistant') texts.push(e.text);
    }
    run.text = texts.join('\n\n');
  }

  function markProgress(run) {
    run.lastProgressAt = nowFn();
    run.retryCount = 0;
    run.retryStart = null;
  }

  function markActivity(run) {
    // Có dấu hiệu sống sau prompt (busy/message) → idle sau đó mới được nhận (P0-4).
    run.seenActivity = true;
    run.armed = true;
  }

  function markMessage(run) {
    // Nội dung thật từ assistant/tool/permission/question (P0-3 dùng để loại trừ "chưa chọn model").
    markActivity(run);
    run.seenMessage = true;
  }

  function routeEvent(event) {
    const n = normalizeEvent(event);
    const run = n.sessionId ? active.get(n.sessionId) : null;
    if (!run) {
      // Chưa có run (event đến sớm hoặc session lạ): giữ tạm event có sessionID để replay.
      if (n.sessionId && n.kind !== 'other') {
        earlyBuffer.push({ at: nowFn(), event });
        if (earlyBuffer.length > EARLY_CAP) earlyBuffer.shift();
      }
      return;
    }
    if (n.kind === 'permission') {
      markProgress(run);
      markMessage(run);
      queuePermission(run, n.permission ?? {});
      return;
    }
    if (n.kind === 'question') {
      markProgress(run);
      markMessage(run);
      void handleQuestionEvent(run, n.question ?? {});
      return;
    }
    if (n.kind === 'idle') {
      if (!run.armed) return; // idle cũ của lượt trước → bỏ qua (P0-4)
      run.finish('DONE');
      return;
    }
    if (n.kind === 'error') {
      run.finish('ERROR', n.message);
      return;
    }
    if (n.kind === 'retry') {
      handleRetryEvent(run, n);
      return;
    }
    if (n.kind === 'status') {
      if (n.status === 'busy') markActivity(run);
      return;
    }
    if (n.kind === 'message') {
      if (n.messageId) {
        run.roles[n.messageId] = n.role;
        if (n.role === 'assistant') markMessage(run);
        else markActivity(run);
        // Role đến sau part: phân loại lại phần đã giữ tạm (P0-1), không mất nội dung.
        refreshAnswer(run);
        emitText(run);
      }
      return;
    }
    if (n.kind === 'tool') {
      markProgress(run);
      markMessage(run);
      run.toolNote = n.note;
      emitText(run);
      return;
    }
    if (n.kind === 'text' || n.kind === 'delta') {
      const key = n.partId || `__m__${n.messageId || '?'}`;
      const prev = run.parts.get(key) || { messageId: n.messageId, text: '' };
      prev.messageId = n.messageId || prev.messageId;
      prev.text = n.kind === 'delta' ? prev.text + n.text : n.text;
      run.parts.set(key, prev);
      const role = n.messageId ? run.roles[n.messageId] || 'unknown' : 'unknown';
      if (role === 'assistant') {
        markProgress(run);
        markMessage(run);
      }
      refreshAnswer(run);
      emitText(run);
      return;
    }
    if (n.kind === 'removed') {
      if (n.partId) run.parts.delete(n.partId);
      refreshAnswer(run);
      emitText(run);
      return;
    }
  }

  // Phát lại event đến sớm cho run vừa đăng ký. Mỗi event chỉ replay 1 lần
  // (xóa khỏi buffer) để event cũ không lẫn sang run sau; idle cũ vẫn bị chặn
  // bởi P0-4 (chỉ nhận idle sau busy/message).
  function replayEarly(run) {
    const now = nowFn();
    for (let i = earlyBuffer.length - 1; i >= 0; i--) {
      if (now - earlyBuffer[i].at > 60000) {
        earlyBuffer.splice(i, 1);
        continue;
      }
      const sid = earlyBuffer[i].event?.properties?.sessionID ?? earlyBuffer[i].event?.properties?.sessionId ?? null;
      if (sid === run.sessionId) {
        const [{ event }] = earlyBuffer.splice(i, 1);
        routeEvent(event);
      }
    }
  }

  function emitText(run, force = false) {
    const now = nowFn();
    if (!force && now - run.lastEmit < STREAM_THROTTLE_MS) {
      run.pendingEmit = true;
      return;
    }
    run.lastEmit = now;
    run.pendingEmit = false;
    void onText({ sessionId: run.sessionId, text: run.text, toolNote: run.toolNote, userId: run.userId }).catch(
      () => {}
    );
  }

  function handleRetryEvent(run, n) {
    // Retry KHÔNG làm mới tiến triển (P0-2): watchdog vẫn chạy khi chỉ có retry/heartbeat.
    run.retryCount = (run.retryCount || 0) + 1;
    if (!run.retryStart) run.retryStart = nowFn();
    if (n.message) run.retryReason = n.message;
    void onRetry({ attempt: n.attempt, message: n.message, sessionId: run.sessionId, userId: run.userId }).catch(
      () => {}
    );
  }

  // Permission xếp hàng FIFO theo run (P1-1): yêu cầu sau không bị bỏ.
  function queuePermission(run, props) {
    run.permQueue.push(props);
    void pumpPermissions(run);
  }

  async function pumpPermissions(run) {
    if (run.permBusy) return;
    const props = run.permQueue.shift();
    if (!props) return;
    run.permBusy = true;
    run.waitingPermission = true;
    const pauseStart = nowFn();
    try {
      const response = await onPermission({ permission: props, sessionId: run.sessionId, userId: run.userId });
      const action = ['once', 'always', 'reject'].includes(response) ? response : 'reject';
      try {
        await replyPermission(
          client,
          { directory, permissionId: props.id || props.permissionID, response: action, sessionId: run.sessionId },
          10000
        );
      } catch {
        /* reply lỗi: task sẽ tự timeout/error, không crash */
      }
    } finally {
      // Tạm dừng timeout trong lúc chờ duyệt
      run.deadline += nowFn() - pauseStart;
      run.permBusy = false;
      run.waitingPermission = run.permQueue.length > 0;
      if (run.permQueue.length > 0) void pumpPermissions(run);
    }
  }

  async function handleQuestionEvent(run, props) {
    // Bản gọn 2-loại: đáp án là label nút đã chọn, forward thành prompt cùng session.
    run.question = props;
    run.waitingPermission = true;
    const pauseStart = nowFn();
    try {
      const answer = await onPermission({ permission: null, question: props, sessionId: run.sessionId, userId: run.userId });
      const text = typeof answer === 'string' ? answer : answer?.text ?? '';
      if (text && String(text).trim()) {
        try {
          await replyQuestionText(client, { directory: run.dir, sessionId: run.sessionId, text: String(text) }, 15000);
        } catch { /* reply lỗi: task tự timeout/error, không crash */ }
      }
    } catch { /* bỏ qua */ }
    finally {
      run.deadline += nowFn() - pauseStart;
      run.waitingPermission = run.permQueue.length > 0;
      run.question = null;
    }
  }

  async function ensureSession(mode, dir = directory, ephemeral = false) {
    if (!ephemeral) {
      const sid = sessionStore?.get(mode) || null;
      if (sid) return sid;
    }
    const s = await sessionCreate(client, { directory: dir, title: `tele ${String(mode).slice(0, 60)}` }, 15000);
    if (!ephemeral) sessionStore?.set(mode, s.id);
    return s.id;
  }

  async function runOnce({ userId, mode, promptText, api, buildPrompt = null, directory: dirOver = null, sessionId: sidOver = null, timeoutMs: timeoutOver = null, ephemeral = false }) {
    const dir = dirOver || directory;
    const limitMs = Number.isInteger(timeoutOver) && timeoutOver > 0 ? timeoutOver : timeoutMs;
    let sid = sidOver || await ensureSession(mode, dir, ephemeral || sidOver !== null || String(mode).startsWith('WF:'));
    const text = buildPrompt ? await buildPrompt() : promptText;
    const t0 = nowFn();
    const run = {
      armed: false,
      createdAt: t0,
      deadline: t0 + limitMs,
      dir,
      finish: null,
      lastEmit: 0,
      lastProgressAt: t0,
      mode,
      modelChecked: false,
      parts: new Map(),
      pendingEmit: false,
      permBusy: false,
      permWaitStart: null,
      permQueue: [],
      permissionWait: false,
      promptAt: t0,
      question: null,
      retryCount: 0,
      retryStart: null,
      roles: {},
      seenActivity: false,
      seenMessage: false,
      sessionId: sid,
      silenced: false,
      text: '',
      toolNote: '',
      userId,
      waitingPermission: false
    };
    const done = new Promise((resolve) => {
      run.finish = (status, error) => resolve({ error, status });
    });

    const timer = setInterval(() => {
      if (run.waitingPermission) {
        // Trần chờ duyệt: quá lâu thì dừng an toàn, user chạy lại khi rảnh.
        if (!run.permWaitStart) run.permWaitStart = nowFn();
        else if (nowFn() - run.permWaitStart > permMaxMs) {
          sessionAbort(client, { directory: run.dir, sessionId: run.sessionId }, 10000).catch(() => {});
          run.finish('TIMEOUT', `Hết ${Math.round(permMaxMs / 60000)} phút chờ duyệt, tự dừng an toàn.`);
          return;
        }
        return;
      }
      run.permWaitStart = null;
      if (nowFn() > run.deadline) {
        // P0-5: TIMEOUT phải abort session thật.
        sessionAbort(client, { directory: run.dir, sessionId: run.sessionId }, 10000).catch(() => {});
        run.finish('TIMEOUT');
        return;
      }
      // Idle: có dấu hiệu sống rồi nhưng quá lâu không tiến triển → TIMEOUT (resume được).
      if (run.armed && nowFn() - run.lastProgressAt > idleMs) {
        sessionAbort(client, { directory: run.dir, sessionId: run.sessionId }, 10000).catch(() => {});
        run.finish('TIMEOUT', `Hết ${Math.round(idleMs / 60000)} phút không có tiến triển (idle), tự dừng.`);
        return;
      }
      // P0-3: prompt được nhận nhưng 30s không có NỘI DUNG nào → kiểm tra 1 lần rồi lỗi rõ.
      if (!run.seenMessage && !run.modelChecked && nowFn() - run.promptAt > firstProgressMs) {
        run.modelChecked = true;
        void checkModelProgress(run);
        return;
      }
      // Watchdog: không tiến triển quá lâu → poll status, báo user + nút Dừng (1 lần/task).
      if (!run.silenced && nowFn() - run.lastProgressAt > watchdogMs) {
        run.silenced = true;
        void (async () => {
          try {
            const st = await sessionStatus(client, { directory }, 10000);
            const map = st && typeof st === 'object' ? st : {};
            const mine = map[run.sessionId] || map[sid];
            if (mine && mine.type === 'idle') {
              run.finish('DONE');
              return;
            }
          } catch { /* poll lỗi: vẫn báo im lặng */ }
          try {
            await onSilent({ sessionId: run.sessionId, userId: run.userId });
          } catch { /* bỏ qua */ }
        })();
        return;
      }
      // P0-2: retry liên tục quá 5 lần hoặc quá 90s → abort + ERROR rõ.
      if (
        run.retryCount >= 5 ||
        (run.retryStart && nowFn() - run.retryStart > 90000)
      ) {
        const reason = (run.retryReason || 'model không phản hồi').slice(0, 200);
        sessionAbort(client, { directory: run.dir, sessionId: run.sessionId }, 10000).catch(() => {});
        recordTask({ cmd: `/${String(run.mode).toLowerCase()}`, kind: run.mode, note: `retry-abort: ${reason}`, status: 'ERROR' });
        run.finish(
          'ERROR',
          `Nhà cung cấp model lỗi liên tục (${reason}). Kiểm tra OPENCODE_MODEL_PROVIDER/ID hoặc thử lại sau.`
        );
        return;
      }
      // Đồng bộ định kỳ để bắt kịp idle khi event mất mà stream không đứt hẳn.
      void periodicResync(run);
    }, 500);

  // P0-3: kiểm tra 1 lần khi prompt xong mà không có dấu hiệu sống.
  // Dấu hiệu sống = message/text/tool/permission/question hoặc nội dung assistant
  // đọc được từ session.messages. Status "busy" đơn thuần KHÔNG đủ (server có thể
  // treo busy khi chưa chọn model mà không sinh event nào).
  async function checkModelProgress(run) {
    try {
      const st = await sessionStatus(client, { directory: run.dir }, 10000);
      const map = st && typeof st === 'object' ? st : {};
      const mine = map[run.sessionId];
      if (mine && mine.type === 'idle') {
        try {
          const messages = await sessionMessages(client, { directory: run.dir, sessionId: run.sessionId }, 15000);
          const text = extractFinalText(messages);
          if (text && text.trim()) {
            run.text = text;
            emitText(run, true);
            run.finish('DONE');
            return;
          }
        } catch { /* tiếp tục báo lỗi model */ }
      } else {
        try {
          const messages = await sessionMessages(client, { directory: run.dir, sessionId: run.sessionId }, 15000);
          if (extractFinalText(messages).trim()) {
            run.seenMessage = true;
            run.seenActivity = true;
            run.armed = true;
            run.lastProgressAt = nowFn();
            return;
          }
        } catch { /* tiếp tục báo lỗi model */ }
      }
    } catch { /* tiếp tục báo lỗi model */ }
    run.finish(
      'ERROR',
      'opencode không xử lý yêu cầu (thường do chưa chọn model). ' +
        'Đặt OPENCODE_MODEL_PROVIDER và OPENCODE_MODEL_ID trong .env rồi chạy `npm run doctor`.'
    );
  }

    api.setAbort(() => {
      sessionAbort(client, { directory: run.dir, sessionId: run.sessionId }, 10000).catch(() => {});
      run.finish('ABORTED');
    });

    active.set(sid, run);
    replayEarly(run);
    const model = config.opencodeModel || null;
    try {
      try {
        await promptAsync(client, { directory: dir, model, sessionId: sid, text }, 15000);
      } catch (e) {
        if (isNotFound(e)) {
          // Session cũ không còn trên server (404) → tạo mới, thử lại 1 lần.
          const s = await sessionCreate(client, { directory: dir, title: `tele ${mode}` }, 15000);
          active.delete(sid);
          sid = s.id;
          run.sessionId = sid;
          active.set(sid, run);
          replayEarly(run);
          if (!String(mode).startsWith('WF:') && !sidOver) sessionStore?.set(mode, sid);
          await promptAsync(client, { directory: dir, model, sessionId: sid, text }, 15000);
        } else {
          throw e;
        }
      }
      const result = await done;
      emitText(run, true);
      if (result.status === 'DONE' && !run.text) {
        // Fallback: lấy lại message sau khi idle.
        try {
          const messages = await sessionMessages(client, { directory: dir, sessionId: sid }, 15000);
          run.text = extractFinalText(messages);
          emitText(run, true);
        } catch { /* giữ text rỗng, caller báo rõ */ }
      }
      return { sessionId: sid, status: result.status, text: run.text, toolNote: run.toolNote, error: result.error };
    } finally {
      clearInterval(timer);
      active.delete(run.sessionId);
    }
  }

  // Hàng đợi tuần tự theo user. Không await ở handler grammY: trả {position, promise}.
  // buildPrompt (tùy chọn): hàm dựng prompt, chạy BÊN TRONG queue lúc task thực sự bắt đầu.
  // directory/sessionId/timeoutMs/ephemeral: phục vụ Chat (dir riêng) + Multitask (session theo runId, không persist).
  function submit({ userId, mode, promptText, buildPrompt = null, directory: dirOver = null, sessionId: sidOver = null, timeoutMs: timeoutOver = null, ephemeral = false }) {
    ensureWatcher();
    return queueFor(userId).enqueue((api) => runOnce({ api, buildPrompt, directory: dirOver, ephemeral, mode, promptText, sessionId: sidOver, timeoutMs: timeoutOver, userId }));
  }

  function stop(userId) {
    const q = queues.get(userId);
    if (!q) return { aborted: false, cleared: 0 };
    return q.stop();
  }

  function pause(userId) {
    const q = queues.get(userId);
    if (!q) return { aborted: false };
    return q.pause();
  }

  function queueSize(userId) {
    return queues.get(userId)?.size ?? 0;
  }

  function close() {
    watcherClosed = true;
    // Ngắt for-await đang treo + dừng retry nội bộ của SDK (signal).
    try {
      watcherAbort?.abort();
    } catch { /* bỏ qua */ }
    try {
      activeStream?.return?.();
    } catch { /* bỏ qua */ }
    if (reconnectTimer) {
      try {
        clearTimeout(reconnectTimer);
      } catch { /* bỏ qua */ }
      reconnectTimer = null;
    }
  }

  return { close, pause, queueSize, resyncNow: () => resyncRuns(), routeEventForTest: routeEvent, stop, submit };
}
