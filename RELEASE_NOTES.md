# tele-commander — Hướng dẫn phát hành (cho người không rành kỹ thuật)

Bot Telegram chuyển tin nhắn của bạn vào opencode chạy trên máy này rồi gửi kết quả về.

## 6 bước khởi động

1. **Cài NodeJS từ 22.14 trở lên.** Kiểm tra: mở terminal (cmd hoặc PowerShell),
   gõ `node --version` (đã kiểm tra bằng `--version`: hiện `v24.20.0` ở máy phát triển).
2. **Cài opencode CLI.** Kiểm tra: gõ `opencode --version`
   (đã kiểm tra: hiện `1.18.33`). Cần lệnh `serve` (đã kiểm tra `opencode serve --help`).
3. **Tạo file `.env`.** Copy file `.env.example` thành `.env` (cùng thư mục này),
   rồi điền 2 giá trị lấy từ BotFather: `TELEGRAM_BOT_TOKEN` và `TELEGRAM_ALLOWED_USERS`
   (là số ID Telegram của bạn). Các biến còn lại có giá trị mặc định dùng được ngay.
4. **Khám sức khỏe:** gõ `npm run doctor` (đã kiểm tra `doctor --help`).
   Sửa theo từng dòng `[FAIL]` hiện ra. Thêm `-- --offline` ở cuối lệnh nếu máy không có mạng
   (ví dụ `npm run doctor -- --offline`) để bỏ qua bước gọi Telegram.
5. **Chạy bot:** double-click file `start-commander.cmd`, hoặc gõ `npm start`.
   Cửa sổ phải hiện bot đã khởi động; đừng tắt cửa sổ này khi đang dùng bot.
6. **Mở Telegram:** gõ `/start` cho bot, bấm Có nếu bot hỏi bật opencode,
   chọn 1 trong 2 mục: `TASK` (chọn task MMO để chạy), `ON/OFF PC`.

## Có gì mới (4.3 — single task + ON/OFF PC)

- **Menu 2 nút tên trần:** `TASK` / `ON/OFF PC` (không đánh số).
- **MODE 1 TASK:** bấm `TASK` để xem danh sách, mỗi task 1 nút. Bấm nút 1 task
  rồi xác minh `OK` / `Cancel` (`Cancel` quay lại danh sách). `OK` chạy đúng
  1 task đó. Gõ text khi đang chọn task thì bot nhắc bấm nút.
- **MODE 2 ON/OFF PC:** giữ nguyên 4 chức năng (chụp màn hình, tắt PC sau
  30s/60s, hẹn giờ tắt), chỉ đổi tên.

## Có gì mới (4.0 — TASK theo folder + 3 lệnh PC)

- **MODE 1 TASK:** bấm 1. TASK (hoặc `/tasks`) để xem danh sách task MMO
  đánh số (mỗi task là 1 folder trong `MMO\Mmo`), nhập STT (`1` | `1 2 3` | `all`),
  xác minh OK 1 lần rồi chạy. AI đọc rule MMO + task/skill/plan/progress của
  đúng folder rồi chạy tuần tự. Nhập sai báo lỗi và nhập lại.
  Hết giờ (code 60p, task khác 30p) thì bot tự chạy lại cùng phiên (tối đa
  3 lượt). Thông báo gọn: `⏳` bắt đầu, `✅` xong, `❌`+`⛔` khi lỗi (multi tự
  bỏ task lỗi, chạy tiếp task sau), `🎯` tổng kết. Không stream suy nghĩ AI.
- **Menu lệnh gọn 4:** `/start` (mở menu), `/status`, `/new`, `/stop`.
  Task chạy bằng nút `1. TASK` → nhập STT → OK; PC bằng nút `2. THAO TÁC TRÊN PC`.
  Xong task tự về menu chính. Đã bỏ mọi lệnh `/` còn lại.
- **MODE 2 THAO TÁC TRÊN PC:** Chụp màn hình, Tắt PC sau 30s (`/shutdown_now`),
  Hẹn giờ tắt (`/shutdown_at <phút>`), Tắt PC sau 60s (`/shutdown`),
  `/cancel_shutdown` để hủy.

## Có gì mới (3.1 — gọn 2 mode)

- **MODE 1 AIRDROP:** bấm là AI đọc rule-checknews-remind và check news ngay,
  không hỏi thêm. Xong báo `Check news DONE`.
- **MODE 2 THAO TÁC TRÊN PC:** Tắt PC sau 60s (confirm YES/NO, `/cancel_shutdown`
  để hủy), Chụp màn hình.
- **Form trả lời:** ngắn gọn, chỉ text thuần, không ký hiệu. Bài dài: AI tự ghi
  file report trong `MMO\Airdrop\report` (tên `YYYY-MM-DD-ten.md`), reply tóm tắt
  + dòng cuối `Chi tiết tại: <đường dẫn file>`.

## Sự cố thường gặp

- **Lỗi 409 (conflict):** có 2 bot cùng chạy 1 token (bot cũ chưa tắt). Tắt bot cũ:
  tìm tiến trình bot cũ của chính bạn rồi tắt, chỉ giữ 1 cửa sổ bot.
- **401 / "Sai mật khẩu server":** `OPENCODE_SERVER_PASSWORD` trong `.env` không khớp
  với server đang chạy. Nếu server đang chạy không mật khẩu thì để trống biến này;
  nếu bot tự bật server thì đặt mật khẩu tùy ý (bot dùng chung cho client và server).
- **Bot không phản hồi tin nhắn:** bạn nhắn khi chưa chọn mục (bot hiện lại menu —
  hãy chọn 1 mục trước), hoặc bạn không nằm trong `TELEGRAM_ALLOWED_USERS`
  (bot im lặng với người lạ, chỉ ghi log ID).
- **"Chưa chọn model" / thiếu model:** server không có model mặc định. Đặt
  `OPENCODE_MODEL_PROVIDER` + `OPENCODE_MODEL_ID` trong `.env` (xem gợi ý của
  `npm run doctor`), rồi chạy lại.
- **Cổng bị chiếm:** nếu `npm run doctor` báo cổng đã dùng và đó là opencode bạn đang
  chạy thì kiểm tra lại mật khẩu; nếu không, đổi `OPENCODE_SERVER_URL` sang cổng khác
  (chỉ dùng địa chỉ nội bộ 127.0.0.1, không mở ra mạng ngoài).

## Lệnh hữu ích

- `npm test` — tự kiểm tra toàn bộ (không cần mạng, không cần `.env`).
- `npm run doctor [-- --offline]` — kiểm tra môi trường (không bao giờ in secret).
- `node scripts/pack.mjs` — đóng gói `dist/tele-commander-release.zip` để phát hành.
