import { createOpencodeClient } from '@opencode-ai/sdk';

// Header Basic giống bridge: Basic base64(username:password). Không password → null.
export function basicAuthHeader(username, password) {
  if (!password) return null;
  return 'Basic ' + Buffer.from(`${username || 'opencode'}:${password}`).toString('base64');
}

export function authHeaders(username, password) {
  const h = basicAuthHeader(username, password);
  return h ? { Authorization: h } : undefined;
}

export function createClient({ baseUrl, opencodeServerUrl, username, opencodeServerUsername, password, opencodeServerPassword }) {
  const url = baseUrl || opencodeServerUrl;
  if (!url) throw new Error('createClient: missing baseUrl/opencodeServerUrl');
  const user = username || opencodeServerUsername || 'opencode';
  const pass = password ?? opencodeServerPassword ?? '';
  const headers = authHeaders(user, pass);
  return createOpencodeClient(headers ? { baseUrl: url, headers } : { baseUrl: url });
}

export function withTimeout(promise, ms, label = 'opencode') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sdkErrorText(res) {
  try {
    return JSON.stringify(res?.error ?? res).slice(0, 300);
  } catch {
    return String(res?.error ?? res).slice(0, 300);
  }
}

function throwIfError(res, label) {
  if (res && typeof res === 'object' && 'error' in res && res.error !== undefined && res.error !== null) {
    const err = new Error(`${label}: ${sdkErrorText(res)}`);
    err.sdkError = res.error;
    throw err;
  }
  return res?.data ?? res;
}

export async function sessionCreate(client, { directory, title }, timeoutMs = 15000) {
  const res = await withTimeout(
    client.session.create({ body: { title: String(title || '').slice(0, 80) }, query: { directory } }),
    timeoutMs,
    'session.create'
  );
  const session = throwIfError(res, 'session.create');
  if (!session?.id) throw new Error('session.create: missing id');
  return session;
}

export async function promptAsync(client, { directory, sessionId, text, model = null }, timeoutMs = 15000) {
  const body = { parts: [{ type: 'text', text: String(text) }] };
  if (model && model.providerID && model.modelID) {
    body.model = { modelID: model.modelID, providerID: model.providerID };
  }
  try {
    const res = await withTimeout(
      client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body
      }),
      timeoutMs,
      'session.promptAsync'
    );
    throwIfError(res, 'session.promptAsync');
  } catch (e) {
    throw clarifyModelError(e);
  }
  return true;
}

// Server không có model mặc định và config cũng không đặt → báo rõ thay vì treo.
function clarifyModelError(e) {
  const msg = String(e?.message ?? e);
  if (/no model|model.*(required|missing|default)|default.*model/i.test(msg)) {
    const err = new Error(
      `${msg} (server không có model mặc định: đặt OPENCODE_MODEL_PROVIDER + OPENCODE_MODEL_ID trong .env)`
    );
    err.sdkError = e?.sdkError;
    return err;
  }
  return e;
}

export async function sessionAbort(client, { directory, sessionId }, timeoutMs = 10000) {
  const res = await withTimeout(
    client.session.abort({ path: { id: sessionId }, query: { directory } }),
    timeoutMs,
    'session.abort'
  );
  throwIfError(res, 'session.abort');
  return true;
}

export async function sessionStatus(client, { directory }, timeoutMs = 10000) {
  const res = await withTimeout(
    client.session.status({ query: { directory } }),
    timeoutMs,
    'session.status'
  );
  return throwIfError(res, 'session.status');
}

export async function sessionMessages(client, { directory, sessionId }, timeoutMs = 15000) {
  const res = await withTimeout(
    client.session.messages({ path: { id: sessionId }, query: { directory } }),
    timeoutMs,
    'session.messages'
  );
  return throwIfError(res, 'session.messages');
}

// Liệt kê providers/models (đã xác minh: client.config.providers, .d.ts ConfigProvidersData).
export async function listProviders(client, { directory }, timeoutMs = 15000) {
  const res = await withTimeout(
    client.config.providers({ query: { directory } }),
    timeoutMs,
    'config.providers'
  );
  const data = throwIfError(res, 'config.providers');
  return { defaults: data?.default ?? {}, providers: data?.providers ?? [] };
}

// Chọn model: env chỉ định > connected(có key)+free > connected đầu tiên > model đầu tiên.
export function pickModel(providers, wanted = null) {
  const list = [];
  for (const p of providers || []) {
    const connected = !!p?.key;
    for (const [mid, m] of Object.entries(p?.models || {})) {
      list.push({ connected, free: (m?.cost?.input || 0) === 0 && (m?.cost?.output || 0) === 0, modelID: mid, providerID: p.id, status: m?.status });
    }
  }
  if (wanted) {
    const [wp, wm] = String(wanted).split('/');
    const hit = list.find((x) => x.providerID === wp && (!wm || x.modelID === wm));
    if (hit) return { ...hit, reason: 'env' };
  }
  const freeActive = list.find((x) => x.connected && x.free && x.status === 'active');
  if (freeActive) return { ...freeActive, reason: 'connected-free-active' };
  const connectedFirst = list.find((x) => x.connected);
  if (connectedFirst) return { ...connectedFirst, reason: 'connected-first' };
  const first = list[0];
  if (first) return { ...first, reason: 'first-available' };
  return null;
}

// Trả lời permission: response ∈ once|always|reject.
// Method nằm ở root OpencodeClient (sdk.gen.d.ts: class OpencodeClient),
// KHÔNG phải client.session (đã xác minh runtime: session.post... là undefined).
export async function replyPermission(client, { directory, sessionId, permissionId, response }, timeoutMs = 10000) {
  if (!['once', 'always', 'reject'].includes(response)) {
    throw new Error(`replyPermission: invalid response ${String(response)}`);
  }
  const res = await withTimeout(
    client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      query: { directory },
      body: { response }
    }),
    timeoutMs,
    'permission.reply'
  );
  throwIfError(res, 'permission.reply');
  return true;
}

// Trả lời question (bản gọn 2-loại): không có API question.reply ở SDK v1,
// gửi label của nút đã chọn thành prompt tiếp theo trong cùng session.
export async function replyQuestionText(client, { directory, sessionId, text }, timeoutMs = 15000) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('replyQuestionText: missing text');
  if (!sessionId) throw new Error('replyQuestionText: missing sessionId');
  return promptAsync(client, { directory, sessionId, text: t }, timeoutMs);
}
