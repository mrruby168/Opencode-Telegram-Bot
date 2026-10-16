// Screenshot máy Windows đang chạy bot, gửi về Telegram (chỉ whitelist).
// Thiết kế độc lập opencode: chạy được khi server DOWN và khi đang RUNNING.
// Không shell:true, không nối input người dùng, không native dependency.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { InputFile } from 'grammy';
import { isAllowed, logDir, logLine, maskSecrets, recordTask, senderId } from './common.js';

export const SCREENSHOT_RATE_LIMIT_MS = 3000;
export const SCREENSHOT_TIMEOUT_MS = 15000;
export const SCREENSHOT_KEEP_MS = 5 * 60 * 1000;
// Ngưỡng heuristic: ảnh quá lớn cho sendPhoto thì chuyển sendDocument.
export const SCREENSHOT_PHOTO_MAX_BYTES = 9 * 1024 * 1024;

// Script PowerShell cố định: DPI awareness + chụp toàn bộ VirtualScreen (đa màn hình).
// Đường ra lấy từ $env:SCREENSHOT_OUT nên argv không chứa input người dùng.
export const PS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  "Add-Type -Namespace Dpi -Name Aware -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'",
  'try { [Dpi.Aware]::SetProcessDPIAware() | Out-Null } catch {}',
  '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
  '$bmp = New-Object System.Drawing.Bitmap([int]$b.Width, [int]$b.Height)',
  '$g = [System.Drawing.Graphics]::FromImage($bmp)',
  '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
  '$g.Dispose()',
  '$bmp.Save($env:SCREENSHOT_OUT, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$bmp.Dispose()'
].join('; ');

export function screenshotArgs() {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT];
}

function defaultCaptureFn(outPath) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', screenshotArgs(), {
      env: { ...process.env, SCREENSHOT_OUT: outPath },
      timeout: SCREENSHOT_TIMEOUT_MS,
      windowsHide: true
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`screenshot failed: ${String(err?.message ?? err).slice(0, 200)} ${String(stdout ?? '') + String(stderr ?? '')}`.slice(0, 300)));
        return;
      }
      resolve(outPath);
    });
  });
}

export function screenshotTempPath(dir = null) {
  const d = dir || logDir();
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `screenshot-${Date.now()}-${randomBytes(6).toString('hex')}.png`);
}

export function createScreenshotService({
  captureFn = defaultCaptureFn,
  tempDir = null,
  nowFn = () => Date.now(),
  keepMs = SCREENSHOT_KEEP_MS
} = {}) {
  const lastByUser = new Map(); // userId -> ts
  const filesByNonce = new Map(); // nonce -> { path, timer }

  function rememberFile(filePath) {
    const nonce = randomBytes(6).toString('hex');
    const timer = setTimeout(() => {
      filesByNonce.delete(nonce);
      try { fs.unlinkSync(filePath); } catch { /* bỏ qua */ }
    }, keepMs);
    if (typeof timer.unref === 'function') timer.unref();
    filesByNonce.set(nonce, { path: filePath, timer });
    return nonce;
  }

  function takeFile(nonce) {
    const rec = filesByNonce.get(nonce);
    if (!rec) return null;
    filesByNonce.delete(nonce);
    try { clearTimeout(rec.timer); } catch { /* bỏ qua */ }
    return rec.path;
  }

  function checkRate(userId) {
    const last = lastByUser.get(userId) || 0;
    if (nowFn() - last < SCREENSHOT_RATE_LIMIT_MS) return false;
    lastByUser.set(userId, nowFn());
    return true;
  }

  async function sendImage(ctx, filePath, nonce) {
    const stat = fs.statSync(filePath);
    const kb = { inline_keyboard: [[{ callback_data: `shot:file:${nonce}`, text: 'Gửi bản gốc (file)' }]] };
    try {
      if (stat.size > SCREENSHOT_PHOTO_MAX_BYTES) throw new Error('photo-too-large');
      await ctx.replyWithPhoto(new InputFile(filePath), { caption: 'Ảnh màn hình', reply_markup: kb });
      return 'photo';
    } catch (e) {
      const msg = String(e?.message ?? e);
      // Fallback khi ảnh quá lớn hoặc sendPhoto lỗi: gửi file gốc.
      if (/too large|photo-too-large|PHOTO_|FILE_TOO_BIG|Bad Request/i.test(msg)) {
        await ctx.replyWithDocument(new InputFile(filePath), { caption: 'Ảnh màn hình (bản gốc)' });
        return 'document-fallback';
      }
      throw e;
    }
  }

  async function handleScreenshot(ctx, allowedUsers) {
    const userId = senderId(ctx);
    if (!isAllowed(ctx, allowedUsers)) return false; // im lặng
    try { await ctx.answerCallbackQuery?.(); } catch { /* bỏ qua */ }
    if (!checkRate(userId)) {
      await ctx.reply('Chụp quá nhanh, thử lại sau 3 giây.');
      return true;
    }
    const outPath = screenshotTempPath(tempDir);
    let ok = false;
    try {
      await captureFn(outPath);
      const stat = fs.statSync(outPath);
      logLine('INFO', `screenshot user=${userId} bytes=${stat.size}`);
      recordTask({ cmd: '/screenshot', kind: 'SCREENSHOT', note: `bytes=${stat.size}`, status: 'DONE' });
      const nonce = rememberFile(outPath);
      ok = true;
      await sendImage(ctx, outPath, nonce);
      return true;
    } catch (e) {
      try { fs.unlinkSync(outPath); } catch { /* bỏ qua */ }
      logLine('ERROR', `screenshot fail user=${maskSecrets(String(userId))} err=${maskSecrets(e?.message ?? e).slice(0, 150)}`);
      try { recordTask({ cmd: '/screenshot', kind: 'SCREENSHOT', note: String(e?.message ?? e).slice(0, 120), status: 'ERROR' }); } catch { /* bỏ qua */ }
      await ctx.reply('Chụp màn hình lỗi, thử lại sau.');
      return true;
    } finally {
      if (!ok) { /* temp đã xóa ở catch */ }
    }
  }

  // Nút [Gửi bản gốc (file)]: gửi lại file đang giữ, rồi xóa.
  async function handleFileCallback(ctx, allowedUsers) {
    const data = ctx.callbackQuery?.data ?? '';
    if (!data.startsWith('shot:file:')) return false;
    try { await ctx.answerCallbackQuery?.(); } catch { /* bỏ qua */ }
    const userId = senderId(ctx);
    if (!isAllowed(ctx, allowedUsers)) return true;
    const nonce = data.slice('shot:file:'.length);
    const filePath = takeFile(nonce);
    if (!filePath || !fs.existsSync(filePath)) {
      await ctx.reply('File ảnh đã hết hạn, chụp lại giúp.');
      return true;
    }
    try {
      await ctx.replyWithDocument(new InputFile(filePath), { caption: 'Ảnh màn hình (bản gốc)' });
    } finally {
      try { fs.unlinkSync(filePath); } catch { /* bỏ qua */ }
    }
    return true;
  }

  return {
    handleFileCallback,
    handleScreenshot,
    // expose cho test
    _checkRate: checkRate,
    _rememberFileForTest: rememberFile,
    captureToFile: async () => {
      const outPath = screenshotTempPath(tempDir);
      await captureFn(outPath);
      return outPath;
    },
    screenshotArgs
  };
}
