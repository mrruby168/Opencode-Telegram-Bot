// Pure config loader — không đọc process.env trực tiếp, không import dotenv.
// dotenv được nạp trong bot.js với path tính từ import.meta.url.
export const DEFAULTS = {
  mmoCodeTimeoutMs: 60 * 60 * 1000,
  mmoIdleTimeoutMs: 10 * 60 * 1000,
  mmoTaskTimeoutMs: 30 * 60 * 1000,
  opencodeBin: 'opencode',
  opencodeProjectDir: 'D:\\AI-AGENT',
  opencodeServerUrl: 'http://127.0.0.1:4096',
  opencodeServerUsername: 'opencode',
  permissionTtlMs: 5 * 60 * 1000,
  permissionWaitMaxMs: 15 * 60 * 1000,
  taskTimeoutMs: 30 * 60 * 1000
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function required(env, name) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Missing env ${name} (see .env.example)`);
  }
  return String(v);
}

function optionalInt(env, name, def) {
  const v = env[name];
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid env ${name}: must be a non-negative integer`);
  return n;
}

function parseAllowedUsers(env) {
  const raw = required(env, 'TELEGRAM_ALLOWED_USERS');
  const ids = raw.split(/[,\s]+/).filter(Boolean).map((s) => Number(s));
  for (const id of ids) {
    if (!Number.isInteger(id)) {
      throw new Error('Invalid env TELEGRAM_ALLOWED_USERS: every id must be an integer');
    }
  }
  if (ids.length === 0) throw new Error('Invalid env TELEGRAM_ALLOWED_USERS: empty');
  return new Set(ids);
}

function parseServerUrl(env) {
  const raw = String(env.OPENCODE_SERVER_URL || '').trim() || DEFAULTS.opencodeServerUrl;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid env OPENCODE_SERVER_URL: not a URL');
  }
  if (!LOCAL_HOSTS.has(u.hostname)) {
    throw new Error('Invalid env OPENCODE_SERVER_URL: host must be 127.0.0.1, localhost or [::1]');
  }
  const port = u.port ? Number(u.port) : 4096;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid env OPENCODE_SERVER_URL: bad port');
  }
  return { port, url: u.origin };
}

export function loadConfig(env = {}) {
  const { port, url } = parseServerUrl(env);
  const password = String(env.OPENCODE_SERVER_PASSWORD || '');
  const modelProvider = String(env.OPENCODE_MODEL_PROVIDER || '').trim();
  const modelId = String(env.OPENCODE_MODEL_ID || '').trim();
  if (!!modelProvider !== !!modelId) {
    throw new Error('Invalid env: OPENCODE_MODEL_PROVIDER and OPENCODE_MODEL_ID must both be set or both empty');
  }
  const projectDir = String(env.OPENCODE_PROJECT_DIR || '').trim() || DEFAULTS.opencodeProjectDir;
  return {
    allowedUsers: parseAllowedUsers(env),
    mmoCodeTimeoutMs: optionalInt(env, 'MMO_CODE_TIMEOUT_MS', DEFAULTS.mmoCodeTimeoutMs),
    mmoDir: String(env.MMO_DIR || '').trim() || `${projectDir}\\MMO\\Mmo`,
    mmoIdleTimeoutMs: optionalInt(env, 'MMO_IDLE_TIMEOUT_MS', DEFAULTS.mmoIdleTimeoutMs),
    mmoTaskTimeoutMs: optionalInt(env, 'MMO_TASK_TIMEOUT_MS', DEFAULTS.mmoTaskTimeoutMs),
    opencodeBin: String(env.OPENCODE_BIN || '').trim() || DEFAULTS.opencodeBin,
    opencodeModel: modelProvider ? { modelID: modelId, providerID: modelProvider } : null,
    opencodeProjectDir: projectDir,
    opencodeServerPassword: password,
    opencodeServerPort: port,
    opencodeServerUrl: url,
    opencodeServerUsername: String(env.OPENCODE_SERVER_USERNAME || '').trim() || DEFAULTS.opencodeServerUsername,
    permissionTtlMs: optionalInt(env, 'PERMISSION_TTL_MS', DEFAULTS.permissionTtlMs),
    permissionWaitMaxMs: optionalInt(env, 'PERMISSION_WAIT_MAX_MS', DEFAULTS.permissionWaitMaxMs),
    taskTimeoutMs: optionalInt(env, 'TASK_TIMEOUT_MS', DEFAULTS.taskTimeoutMs),
    telegramBotToken: required(env, 'TELEGRAM_BOT_TOKEN')
  };
}
