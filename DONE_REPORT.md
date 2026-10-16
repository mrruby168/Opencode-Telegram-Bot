# DONE_REPORT — tele-commander v2 chat-relay (T1–T9 + FIX 1–8 + BƯỚC 1–4)

`npm test` cuối: **131 tests / 26 suites, pass 131 fail 0, tự thoát ~20s**
(xem `D:\CODE\Runtime\Python\Temp\npmtest6.log`; các lần chạy `npmtest1–6.log` đều xanh).
Chạy không `.env`, không mạng. E2E offline **14/14**.

## Bảng từng lỗi mới (BƯỚC 1–4): file sửa, tên test, bằng chứng đỏ-trước-xanh-sau

| # | File sửa | Tên test | Đỏ (code cũ `_backup/20260929-1618`) | Xanh (code mới) |
|---|----------|----------|--------------------------------------|-----------------|
| B1 | `src/runner.js` (close abort+return, subscribe signal, unref reconnect), `test/helpers/fake-opencode.js` (clear fallback timer) | `test/watcher-close.test.js`: "close() gọi stream.return()" + "subscribe thật truyền AbortSignal" | ĐỎ: test 1 `false !== true` (`wc-old1.log`); test 2 fail 574ms rồi **treo** (minh họa đúng bug, `wc-old2.log`, tool timeout 45s) | XANH 2/2, tự thoát (`wc-new.log`) |
| B2a | `scripts/smoke.mjs` (spawn thiếu `shell` win32 → ENOENT) | Smoke chạy tay 4097 | Trước: `health=DOWN`, SKIP (`smoke.log` cũ) | Sau: `health=OK`, 3 model thử xong |
| B2b | `scripts/smoke.mjs` (cleanup chỉ kill shell, sót `opencode.exe` cháu giữ cổng 4097) | Verify tay `_diag3.mjs` cổng 4099 | Trước: sót PID 6496 (`serve --port 4097`, phải dọn tay đúng pid này) | Sau: `CLEANUP-OK`, `after=DOWN` (`diag3.log`) |
| B2c | `test/runner.test.js` P0-2 (phụ thuộc fixture có retry storm; fixture mới không còn) | P0-2 + `test/realrun.test.js` | P0-2 ĐỎ sau smoke mới (`npmtest3` lần đầu) | XANH (fallback đúng shape đã đo; realrun nhánh synthetic) |
| B3 | `scripts/doctor.mjs`, `scripts/pack.mjs` (mới) | `test/doctor.test.js` (7), `test/pack.test.js` (4) | ĐỎ trên code cũ (pass 0 fail 1 mỗi file, `red-new.log` — thiếu module mới) | XANH 7/7 + 4/4 |
| B4 | Xóa `dbg-e2e.mjs`, `dbg-perm.mjs`; `.gitignore`; sync docs | `npm test` + kiểm tra JSON/SVG/ENV | — | 131/131, JSON hợp lệ, SVG hợp lệ, `.env.example` đủ biến/không secret |

`test/realrun.test.js` XANH cả trên code cũ (test bảo vệ artifact `real-run.json`,
không phụ thuộc src cũ/mới — chấp nhận, đã ghi PROGRESS).

## Output `npm test` cuối (trích số liệu; full log `npmtest6.log`)

```
syntax OK (13 src + 5 scripts)
ℹ tests 131 | ℹ suites 26 | ℹ pass 131 | ℹ fail 0
ℹ cancelled 0 | ℹ skipped 0 | ℹ todo 0 | ℹ duration_ms ~20700
```

Gồm: unit (config/common/queue/state/model/permission/power/convo/status-log/encoding),
`runner` (P0/P1), e2e offline 14/14, `watcher-close` 2/2, `doctor` 7/7, `pack` 4/4, `realrun` 1/1.

## Kết quả smoke 4097 (`smoke.log`, opencode 1.18.33, server thật)

- `health=OK` (password smoke). Providers: test/openai_api/custom (connected, free)
  + opencode/Zen 8 models (không key).
- 3/3 model prompt accepted (70/22/28 events) + prompt permission accepted (23 events).
  Đáp án đều **echo lại prompt** (không lượt nào ra đúng một chữ `OK`).
- `session.error` thật: `APIError` "tt-web key chỉ dùng trong website TokenTable"
  (đã che secret). Quan sát thêm event thật: `message.part.delta`, `session.diff`,
  `session.idle`, `server.heartbeat`.
- `permission.*`/`question.*` = **0 event** dù đã ép ask → permission live vẫn UNVERIFIED.
- `test/fixtures/real-run.json`: `synthetic:true` (lý do + lỗi từng model, đã che secret).
  `events-smoke.json`: `aiContent:false`, 4 prompts.

## UNVERIFIED còn lại

1. Event permission live (`permission.updated`/`permission.asked`): model thật chưa đụng tool
   nên chưa thấy → code phòng thủ cả 2 shape (e2e phủ bằng fake).
2. Submit đáp án question tới opencode (SDK v1 không có API question) → UI ghi nhận + TTL.
3. Exit code shutdown 1191/1116 (cấm chạy thật) → phân loại thận trọng, luôn hiện mã số.
4. opencode có tự nạp `D:\AI-AGENT\AGENTS.md` ở project root không → tiền tố prompt vẫn giữ.
5. Server 4096 có cần auth không — CẤM chạm cổng 4096 để kiểm tra (chưa xác minh).
6. `real-run.json` synthetic (không model nào ra `OK`): P0-1 chỉ mới khẳng định bằng fixture
   tổng hợp + e2e; cần lượt model thật khi có key khả dụng.
   → 2026-09-30 ĐÃ CÓ lượt thật do user chạy: `opencode/muse-spark-1.3-contributor-free`
   trả lời `1+1=2` qua full chain (bằng chứng do user dán, không phải smoke).

## BLOCKED

Không có. Mọi mục hoàn thành, không vi phạm ràng buộc cứng. Một tiến trình serve smoke
sót (PID 6496, `serve --port 4097` do chính smoke spawn, shell kill không tới) đã dọn
bằng node đúng pid đó + vá cleanup trong smoke (verify CLEANUP-OK); không đụng tiến trình khác.

## Gói phát hành

- `D:\AI-AGENT\CODE\APP\tele-commander\dist\tele-commander-release.zip`
  (123282 bytes, 54 files, quét secret sạch — `packrun.log`).
- Nội dung: src/test/scripts/tài liệu/package.json/package-lock.json/`.env.example`/
  `start-commander.cmd`/`opencode.proposed.json`; loại trừ `.env`, `node_modules`,
  `logs`, `_backup`, `dist`, `*.session`.

## Checklist 7 mục (thử tay, máy thật)

1. Tắt opencode serve → `/start` → bấm Có → thấy "opencode CLI đã bật" + menu.
2. Chọn CODE → nhập 1 câu hỏi → nhận kết quả + nút [Tiếp tục][Về menu].
3. Giao việc dài → `/stop` → báo abort + xóa hàng đợi.
4. Việc cần permission → bấm Cho phép 1 lần / Từ chối (kiểm tra cả hết hạn).
5. Nhắn text khi chưa chọn mục → hiện lại menu + "Chọn 1 mục trước."
6. Tắt máy: bấm "Tắt sau 5 phút" → YES → rồi "Hủy lệnh tắt máy" (chuẩn bị sẵn).
7. Báo cáo: bấm "5. Báo cáo" → "Hôm nay" → số liệu + tóm tắt.

## Kiểm chứng server thật vs đồ giả (trả lời rõ)

- **Server thật** (smoke 4097, opencode 1.18.33): health/auth-shape, `session.create`,
  `promptAsync` accepted, `abort`, `messages`, SSE shapes (`message.updated` role,
  `part.text` tích lũy, `delta`, `session.status` busy/retry/idle, `session.diff`,
  `session.error`), providers qua `config.providers`. Fixture `events-smoke.json`,
  `real-run.json`.
- **Đồ giả** (offline, trong `npm test`): toàn bộ logic runner/permission/power/router
  qua `test/helpers/fake-opencode.js` (SSE + routes khớp SDK v1) và stream lập trình;
  e2e grammy dùng Bot giả (không mạng). Permission/question event thật chưa từng thấy live.

## opencode.proposed.json — cách áp dụng (KHÔNG tự ghi)

1. Mở file `D:\AI-AGENT\CODE\APP\tele-commander\opencode.proposed.json` xem nội dung
   (bash/edit = ask; deny đọc `**/.env*`, `*.env`, `*.env.*`; allow `*.env.example`).
2. Gộp tay các khóa `permission` vào file opencode.json thật của bạn
   (project `D:\AI-AGENT\opencode.json` hoặc global) rồi duyệt lại.
3. Kiểm tra: `opencode debug config` (xem docs opencode.ai/docs/config).

## Hướng dẫn khởi động lại (TÔI KHÔNG TỰ THỰC HIỆN)

1. Thu hồi 2 token cũ trong BotFather, tạo token mới.
2. Điền token mới vào `D:\AI-AGENT\CODE\APP\tele-commander\.env` (không commit).
   `OPENCODE_SERVER_PASSWORD`: **để trống** nếu server đang chạy không mật khẩu
   (VD bridge bật serve không password); **chỉ đặt** khi bot tự bật server
   (lúc đó bot truyền password này sang tiến trình serve).
   Nếu điền sai: health báo UNAUTHORIZED (sai pass) — sửa lại rồi `/opencode`.
3. Tắt bot cũ: kiểm tra PID thật rồi tắt đúng tiến trình đó.
4. `cd D:\AI-AGENT\CODE\APP\tele-commander` rồi `npm start`
   (hoặc double-click `start-commander.cmd`).
   Hai bot cùng poll một token gây lỗi 409 — đảm bảo bot cũ đã tắt.
5. (Tùy chọn) Đặt model: `OPENCODE_MODEL_PROVIDER` + `OPENCODE_MODEL_ID` nếu server
   không có model mặc định (task sẽ báo rõ nếu thiếu). Chạy `npm run doctor` để kiểm tra.
