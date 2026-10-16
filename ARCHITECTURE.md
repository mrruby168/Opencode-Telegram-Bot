# ARCHITECTURE - Tele Commander v4.3-single (2 mode: TASK / ON/OFF PC)

Bot Telegram relay sang opencode local. Chỉ còn 2 MODE.
User bấm TASK là chọn 1 task MMO theo folder rồi AI thực thi.

## 1. Luồng chính

`/start` → health check (OK / UNAUTHORIZED / DOWN) → MENU 2 nút (1-1):
1. TASK → liệt kê mọi folder có `task/task.md` trong `MMO\Mmo` (trừ `Rule`), mỗi task 1 nút →
   bấm nút 1 task, xác minh OK 1 lần → chạy task đó →
   báo `✅ <folder> DONE:`. Cancel ở màn xác minh quay lại danh sách task.
2. ON/OFF PC → Chụp màn hình / Tắt PC sau 30s / Hẹn giờ tắt / Tắt PC sau 60s

Task xong → `AWAIT_INPUT` → text thường tiếp theo = yêu cầu thêm cho task đó →
queue tuần tự → `promptAsync` + SSE → streaming edit 1.5s → kết quả plain text.

- Timeout mỗi lượt: code 60p, task khác 30p (`task/bot.json` đè được), idle 10p không
  tiến triển → TIMEOUT. TIMEOUT tự chạy lại cùng session (tối đa 3 lượt, không hỏi).
- Notify gọn, ẩn suy nghĩ AI (không stream text dở): `⏳ do task X` → `✅ X Done` |
   `❌ ...` + `⛔ X stop` → `🎯` tổng kết.
  Nút `[Tiếp tục]/[Bỏ qua]/[Dừng]` chỉ còn ở tin ⏸ khi `/pause`.
- Chọn task: bấm nút theo snapshot lúc mở list (không rescan),
  xác minh OK/Cancel 1 lần (`cf:<nonce>:ok|cancel`), claim đồng bộ chống double-tap,
  nút cũ báo rõ thay vì im lặng, callback ≤64B, TTL 30 phút.
- Hàng multi-task persist `logs/mmo-queue.json` (atomic); restart bot → INTERRUPTED.
- Chờ duyệt permission/question quá 15p → tự dừng an toàn (không kẹt queue).
- Tắt PC: submenu PC → confirm YES/NO 60s (user+message+nonce) → `shutdown.exe /s /t <giây>`
  (60s mặc định, 30s tối thiểu cho tắt nhanh — giữ cửa `/cancel_shutdown`).
  Đang có task AI chạy thì tin confirm có CẢNH BÁO mất tiến độ.
- Chụp màn hình: submenu PC hoặc `/screenshot`, độc lập opencode (chạy khi DOWN/RUNNING, không vào queue, không đổi convo).
- Output: ngắn gọn plain text, không ký hiệu. Prompt mỗi task bắt đọc
  `<projectDir>\AGENTS.md` + `MMO\Mmo\Rule\rule-mmo.md` + `task/skill/plan/progress`
  của đúng folder đã chọn (bỏ qua B0), cập nhật plan/progress sau mỗi phần lớn.
- Permission/question: DELAY, hỏi user bằng nút, hết hạn 5 phút tự Từ chối.
  Permission bấm -> reply API; question bấm nút -> forward label thành prompt cùng session (SDK v1 không có question.reply).
- `/stop`: `session.abort` thật + xóa hàng đợi + đóng mọi lượt MMO. Không cờ toàn cục.

## 2. State machine (theo user)

`IDLE` → (bấm TASK → bấm nút task → OK) → `RUNNING` →
xong → `AWAIT_INPUT(MMO:<folder>)`. `AWAIT_INPUT` hết hạn sau 30 phút → `IDLE`.
Text khi `IDLE` → hiện lại menu ("Chọn 1 mục trước"). Text khi `RUNNING` → xếp hàng + báo vị trí.

## 3. Opencode server

- Client `@opencode-ai/sdk` + header `Basic base64(user:pass)` khi có `OPENCODE_SERVER_PASSWORD`.
  Mật khẩu này VỪA là pass client VỪA là pass server khi bot tự spawn (serve đọc `OPENCODE_SERVER_PASSWORD`
  từ env — đã đo thực tế). Server không auth header → 401 toàn endpoint.
- Health: `session.status` + timeout 3s → `OK` / `UNAUTHORIZED` / `DOWN`.
- Tự bật: spawn `OPENCODE_BIN serve --port <port> --hostname 127.0.0.1`, cwd = project dir,
  detached + stdio ignore + unref, argv cố định (Windows `.cmd` → `shell:true`, không nối input).
  Poll 1s × 30. Lock chống spawn kép. Bind duy nhất 127.0.0.1.

## 4. Ghi chú AGENTS.md và rule MMO

Mọi prompt task gửi đi yêu cầu đọc `<projectDir>\AGENTS.md` và
`MMO\Mmo\Rule\rule-mmo.md` trước, rồi đọc `task/skill/plan/progress` của đúng
folder đã chọn (bỏ qua B0), thực thi đúng MMO-EXECUTION-CORE.
Nếu event xin đọc file ngoài project → rẽ sang luồng permission (E).

## 5. Modules

- `config.js` — `loadConfig(env)` thuần; dotenv nạp ở `bot.js` theo `import.meta.url`.
  Thêm `MMO_DIR`, `MMO_CODE_TIMEOUT_MS` (60p), `MMO_TASK_TIMEOUT_MS` (30p),
  `MMO_IDLE_TIMEOUT_MS` (10p), `PERMISSION_WAIT_MAX_MS` (15p).
- `common.js` — paths theo file (`TELE_LOG_DIR` override cho test), chunk 4000, `maskSecrets`,
  log xoay vòng, tasks atomic (corrupt → `.corrupt-<ts>`, tối đa 5000), `countTasks` 4 trạng thái,
  `createTaskQueue` (vị trí, abort, stop).
- `mmo-tasks.js` — quét task folder + `task/bot.json` + prompt B0-skip +
  registry chọn/chạy (TTL, snapshot, idempotent) + queue persist/INTERRUPTED.
- `state.js` — session bền vững/mode (`state.json` atomic) + convo store (TTL 30 phút).
- `server.js` — health 3 lớp + `ensureServer` (spawn/poll/lock).
- `opencode-exec.js` — bọc SDK có timeout: create/promptAsync/abort/status/messages/permission-reply.
- `runner.js` — queue/user, 1 SSE subscribe dùng chung (tự nối lại), idle đúng sessionId,
  streaming throttle 1.5s, timeout tạm dừng khi chờ duyệt (trần 15p), idle 10p → TIMEOUT,
  404 → tạo session mới, fallback đọc messages.
  Watcher đóng sạch: `close()` abort signal (dừng retry vô hạn nội bộ của SDK) +
  `stream.return()` (ngắt `for-await` treo) + clear/unref timer nối lại 2s;
  `subscribe` luôn truyền `signal`. Nếu không, `npm test` treo sau khi test đã xanh.
- `events.js` — lớp chuẩn hóa event (đã đo bằng smoke thật trên server 1.18.32):
  `session.idle` → xong; `session.status` busy/idle → theo dõi + phát hiện xong;
  `message.updated` → map role theo messageID (chỉ gom text assistant, text user không lẫn đáp án);
  `message.part.updated` text/tool → streaming + tool-note; `session.error` → lỗi;
  `permission.updated` (v1) + `permission.asked` (v2) → luồng duyệt; `question.asked` → luồng hỏi;
  `server.*`/khác → bỏ qua. `permission.*`/`question.*` live chưa thấy (thiếu provider lúc smoke) → UNVERIFIED.
- Watchdog: session bận mà không event nào quá 2 phút → poll `session.status`;
  idle → xong; busy → báo "opencode đang im lặng" + nút [Dừng] (1 lần/task).
- `permissions.js` — registry nonce ngắn (callback ≤64B), TTL 5 phút, `canAlways` chỉ edit trong project,
  question chỉ nút có sẵn (text tự do lúc chờ -> nhắc bấm nút).
- `power.js` — factory `execFn` inject; chỉ `yes` chạy (`/s /t <giây>`: 60s mặc định,
  30s tối thiểu cho tắt nhanh, hẹn giờ 1–480 phút); claim/delete đồng bộ; xóa nút; exit-code
  (0 OK; 1191/1116 UNVERIFIED benign + hiện mã); CANCELLED/EXPIRED đúng nghĩa; log userId+nonce.
- `menu.js` — menu chính 2 nút TASK/PC (1-1) + submenu PC 4 nút.
- `modes.js` — TOP_MODES TASK/PC, mode `MMO:<folder>`, `toPlainText` (bỏ **, __, `, # đầu dòng).
- `screenshot.js` — `createScreenshotService({captureFn})`: PowerShell VirtualScreen + DPI awareness, argv cố định, rate-limit 3s, temp dưới logs/, sendPhoto→fallback sendDocument, nút file gốc, xóa temp, kind SCREENSHOT.
- `router.js` — state machine TASK/PC, chọn task single + OK/Cancel,
  callback an toàn (whitelist/TTL/idempotent/snapshot), permission/question UI, `/stop` abort thật.
- `bot.js` — whitelist im lặng, drop_pending_updates, signals, setMyCommands (4: start/status/new/stop) + menu button.
  Task chạy bằng nút menu (TASK → bấm nút task → OK); thao tác PC bằng nút submenu.
- Xong task (DONE hoặc hết hàng lỗi) → tự gửi lại menu chính + về IDLE.
- `/stop` abort + xóa hết. Không còn `/pause`, `/edit_task`, `/tasklist` gõ tay.

## 6. Scripts vận hành (chạy tay, không nằm trong `npm test`)

- `scripts/smoke.mjs` — smoke cổng 4097, thư mục tạm, mật khẩu smoke cố định:
  liệt kê providers, thử tối đa 3 model (mỗi ≤60s) với prompt "một chữ OK",
  hỗ trợ `SMOKE_MODEL=provider/model`; lượt hoàn tất → `test/fixtures/real-run.json`
  (`synthetic:false`), không lượt nào xong → `synthetic:true` + lỗi từng model (che secret).
  Windows cần `shell:true` khi spawn `opencode`; cleanup kill đúng cây tiến trình
  (con của shell) rồi verify health DOWN. Fixture `events-smoke.json` gắn nhãn `aiContent`.
- `scripts/doctor.mjs` — 8 nhóm (node, env, token, opencode-bin, powershell, server, model + gợi ý 5,
  Telegram getMe trừ khi `--offline`); `DOCTOR_ENV_FILE` + inject `fetchFn` cho test;
  exit 0 khi không lỗi nặng; không bao giờ in secret.
- `scripts/pack.mjs` — gói `dist/tele-commander-release.zip` đúng allowlist
  (loại `.env`/node_modules/logs/_backup/dist/session); `tar -a` (fallback copy
  `dist/release/`); FAIL khi quét thấy mẫu secret (bỏ qua `test/` vì token GIẢ cố ý).
- `start-commander.cmd` — khởi động Windows: kiểm tra node + `.env`, chạy bot,
  thoát bất thường in mã + pause, không loop, chữ không dấu.

## 6. Bảo mật

Token/password chỉ trong `.env` (không commit). Mọi text ra Telegram/log qua `maskSecrets`.
Whitelist cả message + callback. Không đoán ý user khi IDLE.
Ảnh màn hình có thể chứa dữ liệu nhạy cảm — chỉ whitelist mới dùng `/screenshot`, log chỉ userId + kích thước, không log nội dung ảnh.

## 7. File runtime

`logs/bot.log`, `logs/tasks.json`, `logs/state.json`. Không DB.
