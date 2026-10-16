import { InlineKeyboard } from 'grammy';

export const MENU_TITLE = 'Chọn tác vụ:';

// Menu chính: đúng 2 nút, mỗi nút 1 hàng, chỉ tên tác vụ.
export function mainKeyboard() {
  return new InlineKeyboard()
    .text('TASK', 'menu:task')
    .row()
    .text('ON/OFF PC', 'menu:pc');
}

export async function sendMainMenu(ctx) {
  await ctx.reply(MENU_TITLE, { reply_markup: mainKeyboard() });
}

export function pcMenuKeyboard() {
  return new InlineKeyboard()
    .text('Chụp màn hình', 'go:pc:shot')
    .row()
    .text('Tắt PC sau 30s', 'go:pc:now')
    .row()
    .text('Hẹn giờ tắt PC', 'go:pc:at')
    .row()
    .text('Tắt PC sau 60s', 'go:pc:shutdown')
    .row()
    .text('Về menu', 'go:menu');
}

export async function sendPcMenu(ctx) {
  await ctx.reply('ON/OFF PC:', { reply_markup: pcMenuKeyboard() });
}

export function backMenuKeyboard() {
  return new InlineKeyboard().text('Về menu', 'go:menu');
}

// Chuyển buttons {text,data} thuần (từ permissions.js) sang InlineKeyboard.
export function toInlineKeyboard(rows) {
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    if (i > 0) kb.row();
    row.forEach((b) => kb.text(b.text, b.data));
  });
  return kb;
}
