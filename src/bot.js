import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '..', '.env') });

import { Bot } from 'grammy';
import { loadConfig } from './config.js';
import { logLine, maskSecrets, senderId } from './common.js';
import { createClient } from './opencode-exec.js';
import { createConvoStore, clearModeSession, getModeSession, setModeSession } from './state.js';
import { createRunner } from './runner.js';
import { createServerManager } from './server.js';
import { createBotHandlers } from './router.js';

const config = loadConfig(process.env);
const client = createClient(config);
const convo = createConvoStore({ idleTtlMs: 30 * 60 * 1000 });
const sessionStore = { clear: clearModeSession, get: getModeSession, set: setModeSession };
const serverManager = createServerManager({ client, config });

let handlers = null;
const runner = createRunner({
  client,
  config,
  hooks: {
    onPermission: (e) => handlers.runnerOnPermission(e),
    onRetry: (e) => handlers.runnerOnRetry(e),
    onSilent: (e) => handlers.runnerOnSilent(e),
    onText: (e) => handlers.runnerOnText(e)
  }
});
handlers = createBotHandlers({ client, config, convo, runner, serverManager, sessionStore });

const bot = new Bot(config.telegramBotToken);

// Whitelist cho cả message và callback_query. Người lạ: im lặng, chỉ log ID.
bot.use(async (ctx, next) => {
  const id = senderId(ctx);
  if (!config.allowedUsers.has(id)) {
    logLine('WARN', `stranger blocked id=${String(id)}`);
    return;
  }
  await next();
});

handlers.register(bot);

const COMMANDS = [
  { command: 'start', description: 'Mở menu bot' },
  { command: 'status', description: 'Trạng thái bot + opencode' },
  { command: 'new', description: 'Phiên opencode mới' },
  { command: 'stop', description: 'Dừng task đang chạy' }
];

try {
  await bot.api.setMyCommands(COMMANDS);
} catch (e) {
  logLine('WARN', `setMyCommands failed: ${maskSecrets(e?.message ?? e)}`);
}
try {
  await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
} catch (e) {
  logLine('WARN', `setChatMenuButton failed: ${maskSecrets(e?.message ?? e)}`);
}

bot.catch((err) => {
  logLine('ERROR', `bot.catch ${maskSecrets(err?.message ?? err).slice(0, 300)}`);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logLine('INFO', `received ${signal}, stopping bot`);
  try {
    await bot.stop();
  } catch { /* bỏ qua */ }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => {
  logLine('ERROR', `unhandledRejection ${maskSecrets(e?.message ?? e).slice(0, 300)}`);
});
process.on('uncaughtException', (e) => {
  logLine('ERROR', `uncaughtException ${maskSecrets(e?.message ?? e).slice(0, 300)}`);
  process.exit(1);
});

await bot.start({
  drop_pending_updates: true,
  onStart: (info) => logLine('INFO', `tele-commander started @${info.username}`)
});
