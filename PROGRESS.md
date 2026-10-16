# PROGRESS — tele-commander chat-relay rewrite

- 2026-09-29: backup `src/`, `package.json`, `.env.example`, `*.md/json/svg` → `_backup/20260929-1039/` (không gồm `.env`, `node_modules`, `logs`).
- 2026-09-29: T1 xong. `npm test` xanh (syntax 9 file + 7 test config).
- 2026-09-29: T2 xong. `npm test` xanh (20 tests: chunk/mask/tasks/queue/config).
- 2026-09-29: T3 xong. `npm test` xanh (35 tests). Smoke 4097: health OK (có password), create/promptAsync/abort/messages OK, stream=AsyncGenerator, fixture `test/fixtures/events-smoke.json` (chỉ connected+heartbeat — thiếu provider AI).
- 2026-09-29: T4 xong. `npm test` xanh (43 tests). Runner: queue/user, SSE share, idle/timeout/abort/404-recreate, throttle 1.5s.
- 2026-09-29: T5 xong. `npm test` xanh (51 tests). Permission registry + `opencode.proposed.json` (keys verify từ docs opencode.ai).
- 2026-09-29: T6 xong. `npm test` xanh (58 tests). Power factory + exit-code (1116/1191 UNVERIFIED), xóa nút, CANCELLED/EXPIRED.
- 2026-09-29: T7 xong. `npm test` xanh (66 tests). Menu 2-2-1, state machine, prompt AGENTS.md từ config, report đếm trong queue, xóa /code/argsOf/WORKSPACE.
- 2026-09-29: T8 xong. `npm test` xanh (73 tests). bot.js wiring (whitelist im lặng, drop_pending_updates/onStart đã verify, signals, setMyCommands 11 lệnh).
- 2026-09-29: T9 xong. `npm test` xanh (76 tests). Docs sync + DONE_REPORT.md. KHÔNG kill process, KHÔNG chạy bot/serve thật.
- 2026-09-29: FIX 1–8 xong. `npm test` xanh (85 tests / 19 suites). Backup `_backup/20260929-1125/`.
- 2026-09-29: FIX-1 xong. `npm test` xanh (80 tests). Config OPENCODE_MODEL_PROVIDER/ID + promptAsync model + lỗi rõ khi thiếu model.
- 2026-09-29: BƯỚC 1 xong. Backup `_backup/20260929-2324/`. Sửa treo `npm test`: `npm test` thuần tự thoát, xanh 119/119 (23 suites) 2 lần liên tiếp (~20s/lần, log `D:\CODE\Runtime\Python\Temp\npmtest1.log`, `npmtest2.log`). Test mới `test/watcher-close.test.js` (2 tests, ĐỎ trên `_backup/20260929-1618` qua redcheck, XANH trên code mới).
- 2026-09-30: BƯỚC 2 xong. Backup `_backup/20260930-0119/`. Smoke multi-model 4097 (`scripts/smoke.mjs`: shell win32 + tối đa 3 model × ≤60s + `real-run.json` + cleanup kill đúng cây tiến trình, đã verify CLEANUP-OK cổng 4099): health OK, 3/3 prompt accepted (70/22/28 events) + permission 23 events, 0 event permission/question. `npm test` xanh 120/120 (24 suites) 2 lần (`npmtest3.log`, `npmtest4.log`). Test mới `test/realrun.test.js` (P0-1, nhánh synthetic). Sửa kèm `test/runner.test.js` P0-2 (fallback retry khi fixture không còn retry storm).
- 2026-09-30: BƯỚC 3 xong. Backup `_backup/20260930-0136/`. Công cụ phát hành: `scripts/doctor.mjs` + `test/doctor.test.js` (7/7 xanh, ĐỎ trên code cũ) + script `doctor` trong package.json; `start-commander.cmd`; `scripts/pack.mjs` + `test/pack.test.js` (4/4 xanh, ĐỎ trên code cũ) → `dist/tele-commander-release.zip` (54 files, 123282 bytes, quét secret sạch); `RELEASE_NOTES.md` (6 bước + 5 sự cố, lệnh đã kiểm tra --help). `npm test` xanh 131/131 (26 suites), tự thoát (`npmtest5.log`). `realrun.test.js` XANH trên code cũ (test bảo vệ artifact, không bắt lỗi cũ — chấp nhận).
- 2026-09-30: BƯỚC 4 xong. Xóa `dbg-e2e.mjs`, `dbg-perm.mjs` (node fs); `_redcheck` không còn. `.gitignore` thêm `dist/`, `_backup/`. Sync: ARCHITECTURE (watcher close + scripts vận hành), PROJECT_MAP (14 entries mới, JSON hợp lệ), SVG (scripts/tests mới, XML hợp lệ), UI_SPEC khớp (không đổi), `.env.example` đủ biến/không secret. Syntax 13 src + 5 scripts OK. `npm test` xanh 131/131 (26 suites), tự thoát (`npmtest6.log`).
- 2026-09-30: BƯỚC 5 xong. Viết lại `DONE_REPORT.md` (bảng lỗi + số liệu + smoke + UNVERIFIED + zip + checklist 7 + thật-vs-giả). `npm test` cuối xanh 131/131 (26 suites), tự thoát (`npmtest7.log`). Không BLOCKED.
- 2026-09-30: Fix sau doctor thật của user: `defaultExecFn` thiếu shell win32 (WARN giả). Export + test exec thật `opencode --version` (ĐỎ trên code cũ, XANH mới). `npm test` xanh 132/132 (26 suites), tự thoát (`npmtest8.log`).
- 2026-09-30: LƯỢT THẬT đầu tiên do user chạy: `opencode/muse-spark-1.3-contributor-free` (Zen, sau `auth login`) trả lời `1+1=2` qua full chain Telegram→bot→server→model. P0-1 khẳng định live (đáp án ráp đúng, không nhân đôi). Server 4096 không password → chấp nhận no-auth (xác minh gián tiếp qua bot chạy OK).

## PLAN v3-no-refactor (FIX 1 + FIX 2, 2026-09-30)
- Giữ nguyên cấu trúc src/*.js (không refactor router/runner thành thư mục).
- FIX 1: thêm src/screenshot.js (createScreenshotService, captureFn inject, argv PowerShell cố định, rate-limit 3s, temp dưới logs/, sendPhoto→fallback sendDocument, xóa temp finally, kind SCREENSHOT). Menu 2-2-2 + /screenshot. Doctor kiểm tra PowerShell.
- FIX 2: mode 5 thành Chat box/Multitask. Chat: nguyên văn, session CHAT, OPENCODE_CHAT_DIR, chỉ nút Về menu. Multitask: workflows/*.json + validator/engine chạy tuần tự, step prompt|screenshot|report|notify, template {{...}}, abort/restart an toàn, kind MULTITASK, /report tương thích.
- Mỗi bước: test ĐỎ trước/XANH sau, npm test xanh mới tiếp.
- 2026-09-30: FIX 1 xong. `src/screenshot.js` + menu 2-2-2 + `/screenshot` + doctor powershell. `npm test` xanh 139/139 (27 suites).
- 2026-09-30: FIX 2 xong. Chat nguyên văn session CHAT + `OPENCODE_CHAT_DIR`; engine multitask tuần tự + 3 workflow mẫu. `npm test` xanh 152/152 (30 suites).
- 2026-09-30: Bước 3 xong. Docs (ARCHITECTURE/PROJECT_MAP/UI_SPEC/RELEASE_NOTES/.env.example/workflows-README), doctor 9 nhóm (powershell+workflows), pack 63 files sạch secret, check-syntax đệ quy, import vòng: no-cycle. `npm test` xanh 152/152 2 lần liên tiếp, tự thoát.
- 2026-10-01: Fix /status+/start sau chat (option a). Guard text bắt đầu `/` trong handleText (hiện lại menu, không submit task); /status khi DOWN hỏi bật Có/Không như /start (dùng chung serverPending). `npm test` xanh 155/155 (30 suites) 2 lần, tự thoát; doctor --offline không fail.
- 2026-10-01: Fix treo + tin nhầm sau /stop (P1+P2+P3). P1: position hàng đợi off-by-one (rảnh=0, bận>=1). P2: settle stopped/ABORTED chỉ một dòng, không fallback rỗng/partial cũ. P3: sender Telegram timeout 20s + askApproval lỗi gửi thì reject an toàn. `npm test` xanh 162/162 (31 suites) 2 lần, tự thoát; doctor --offline không fail.
- 2026-10-01: Fix lặp kết quả + thinking + form chat (FIX 1/2/3 theo ảnh user). FIX 1: sendFinal xóa tin tiến trình trước khi đăng kết quả. FIX 2: CHAT không streaming thinking (CODE/MMO/AIRDROP/REPORT giữ nguyên). FIX 3: chat strip **, plain text. `npm test` xanh 165/165 (31 suites) 2 lần, tự thoát; doctor --offline không fail.
- 2026-10-01: Gọn 3 MODE (MMO/AIRDROP/PC). Mới src/modes.js (SUBS + prompt rule + report file + plain text); menu 3 nút + submenu; power 3 phút (/shutdown3); gỡ CODE/CHAT/multitask/report cũ. `npm test` xanh 157/157 (28 suites) 2 lần, tự thoát; doctor --offline không fail.
- 2026-10-01: Gọn 2 MODE (AIRDROP chạy ngay + PC tắt 60s/chụp màn hình). Bỏ MMO/check-telegram/quản lý dự án; lệnh /shutdown; báo Check news DONE. `npm test` xanh 154/154 (28 suites) 2 lần, tự thoát; doctor --offline không fail.

## PLAN v3 (FIX 3 - Refactor, 2026-09-30)
- Mục tiêu: cấu trúc chuẩn, không đổi hành vi, 132 test xanh, lint sạch, không import vòng.
- Cấu trúc: src/app.js + main.js (composition root), src/config/index.js, src/core/* (paths/mask/chunk/retry/logger/task-store/queue), src/constants.js, src/features/modes, src/bot/* (setup/commands/callbacks/keyboards/messages/sender/safe-handler), src/opencode/* (client/server-manager/events/models/runner/*).
- Nguồn sự thật duy nhất: MODES (features/modes), COMMANDS (bot/commands), messages (bot/messages), status map + settle (core/task-helpers), constants (constants.js).
- Gộp handleStart/handleOpencode, safeHandler, prefix callback router, bỏ vòng let handlers=null qua hook registry.
- Tách runner thành watcher/queue/session/run-once/watchdog, giữ nguyên close() semantics (abort+return+unref).
- Thêm ESLint+Prettier + script check-circular, chạy npm test + lint xanh 2 lần.
- Shims: giữ src/*.js cũ re-export để 132 test không vỡ.

## Tasks
- [ ] T1 config + paths
- [ ] T2 common
- [ ] T3 client/health/server/state + smoke
- [ ] T4 runner
- [ ] T5 permissions + opencode.proposed.json
- [ ] T6 power
- [ ] T7 menu/router/reporter
- [ ] T8 bot wiring
- [ ] T9 docs + DONE_REPORT

## WI-v4 — TASK MMO + 3 lệnh PC — CODING (ngày hiện tại)
- Changed: src/mmo-tasks.js (mới); src/modes|menu|power|runner|router|config|state|bot.js; test/modes|convo|e2e|power|config + test/mmo-tasks.test.js (mới); PROJECT_MAP/ARCHITECTURE/UI_SPEC/RELEASE_NOTES/.env.example
- Decisions/assumed: timeout code 60p/khác 30p theo user (VERIFIED config); idle 10p + trần chờ duyệt 15p + max 3 leg theo review AI mạnh (VERIFIED code); bỏ /t 0 giữ /t 30 tối thiểu (VERIFIED power.test)
- Next: chạy npm test + doctor --offline, sửa đỏ nếu có, báo cáo VERIFIED
- Open: NOT RUN (chờ quyền chạy lệnh)
## WI-v4.1 — STT nhập tay + xác minh OK (thay toggle) — CODING (ngày hiện tại)
- Changed: src/mmo-tasks.js (parseStt + runPicked/confirmOk/confirmCancel, bỏ toggle); src/router.js (list số + PICK + cf:ok/cancel); test/mmo-tasks|convo|e2e; UI_SPEC/ARCHITECTURE/RELEASE_NOTES/PROJECT_MAP
- Decisions/assumed: toggle đúng logic nhưng chết im lặng khi bấm nhầm list (VERIFIED transcript + log); STT 1 state + báo lỗi rõ (theo chốt user)
- Next: npm test + doctor --offline
- Open: NOT RUN
## WI-v4.1 — STT nhập tay + xác minh OK — DONE (ngày hiện tại)
- Changed: như trên + tombstone confirmOk (OK lần 2 -> dup)
- Decisions/assumed: fix đỏ duy nhất đúng 1 lần, không chồng patch
- Next: user T2 tay trên Telegram (@OpenCode_cliok_bot): /tasks -> gõ 1 -> OK; gõ sai -> nhập lại
- Open: none (doctor server 401 là môi trường: serve 4096 đang chạy với password khác .env tele-commander — user tự khớp password hoặc /opencode lại)
## WI-v4.2 — Lệnh /: tasklist + pause + edit_task, bỏ menu/airdrop — CODING (ngày hiện tại)
- Changed: src/common|runner.js (queue.pause); src/router.js (handlePause/handleEditTask, PAUSED settle, text nối run cũ); src/bot.js (menu 16 lệnh); test/queue|convo.test.js; UI_SPEC/ARCHITECTURE/RELEASE_NOTES/PROJECT_MAP (4.1)
- Decisions/assumed: /pause abort leg giữ run+queue, text nối cùng session (theo chốt user)
- Next: npm test + doctor --offline
- Open: NOT RUN
## WI-v4.2 — Lệnh / — DONE (ngày hiện tại)
- Changed: như trên
- Decisions/assumed: không fix đỏ nào (xanh ngay lần đầu 185/185)
- Next: restart bot lấy bản mới; user T2: /tasklist, /pause + gõ text đổi kế hoạch, /edit_task, kiểm tra menu / không còn /menu /airdrop
- Open: none (doctor 2 WARN offline dự kiến: serve DOWN + model)
## WI-v4.3 — Notify gọn ⏳/✅/❌/⛔/🎯 + auto-skip (thay verbose) — CODING (ngày hiện tại)
- Changed: src/router.js (settle/advance gọn, tắt streaming, TIMEOUT tự retry, lỗi auto-skip); test/convo|e2e.test.js; UI_SPEC/ARCHITECTURE/RELEASE_NOTES
- Decisions/assumed: TIMEOUT auto-retry thay nút Tiếp tục (theo spec gọn của user, vẫn giữ max 3 leg + cùng session)
- Next: npm test + doctor --offline
- Open: NOT RUN
## WI-v4.3 — Notify gọn — DONE (ngày hiện tại)
- Changed: như trên + runner.js resyncOne guard !armed (fix DONE giả khi tái dùng session sau abort — root cause e2e 6+13); e2e 6+13 + test 8 fix assertion theo format gọn
- Decisions/assumed: resync idle chỉ chốt DONE khi run đã armed (mirror P0-4 routeEvent); e2e 6+13 thành regression test cho case này
- Next: restart bot lấy bản mới; user T2 tay theo spec ⏳/✅/❌/⛔/🎯
- Open: none (doctor 2 WARN offline dự kiến)
## WI-v4.4 — Menu 4 lệnh + auto-menu khi DONE — CODING (ngày hiện tại)
- Changed: src/bot.js (menu 4); src/router.js (xóa 13 commands/handlers pause|edit|tasklist|pc|opencode|shot|shutdown*|log|help|tm, settle-final + IDLE + menu); test/convo|status-log|e2e.test.js; UI_SPEC/ARCHITECTURE/RELEASE_NOTES/PROJECT_MAP (4.2)
- Decisions/assumed: nút menu/callback giữ nguyên (task + PC chạy bằng nút); text gõ lệnh lạ vẫn báo "Đây là lệnh"
- Next: npm test + doctor --offline
- Open: NOT RUN
## WI-v4.4 — Menu 4 lệnh + auto-menu — DONE (ngày hiện tại)
- Changed: như trên
- Decisions/assumed: e2e 3 chạy lại task qua runFirstTask (IDLE sau DONE); e2e 11 chuyển sang nút PC; không fix đỏ nào (xanh ngay 182/182)
- Next: restart bot; user T2: menu / chỉ 4 lệnh, xong task tự về menu
- Open: none (doctor 2 WARN offline dự kiến)
## WI-v4 — TASK MMO + 3 lệnh PC — DONE (ngày hiện tại)
- Changed: như trên + userChain khóa callback theo user + runFirstTask lấy list mới nhất + tombstone dup + mask/chunk DONE/TIMEOUT
- Decisions/assumed: giữ userChain (sửa race toggle→go, VERIFIED e2e 3b); helper test lỗi dùng lại nonce cũ (VERIFIED debug script, đã xóa .tmp-ai/dbg3b.mjs)
- Next: user T2 tay trên Telegram (/tasks multi, /shutdown_at + /cancel_shutdown)
- Open: none
## WI-QA2 — Q&A gọn 2-loại (permission + nút chọn) — DONE (2026-10-16)
- Changed: src/opencode-exec.js:178-183 replyQuestionText; src/runner.js:342-361 forward + pause deadline; src/router.js ask/callback/text chỉ nút; src/permissions.js text nút + resolve label; test/start.test.js question-button
- Decisions/assumed: prompt-fallback cùng session thay question.reply SDK v1 (VERIFIED code); text lúc chờ Q&A nhắc bấm nút, không forward (theo chốt user bỏ ý kiến riêng)
- Next: restart bot; user T2 ĐT: chạy task -> đợi AI hỏi -> bấm nút -> kiểm tra AI chạy tiếp
- Open: none
## WI-QA2-fix — Question không options nhận text — DONE (2026-10-16)
- Changed: src/permissions.js hint theo có/không nút; src/router.js hasButtons + handleText 2 nhánh; test/start.test.js thêm case không nút
- Decisions/assumed: có nút -> chỉ nút (theo chốt gọn); không nút -> nhận text kế tiếp (VERIFIED npm test 183/183)
- Next: restart bot; user T2 lại task02 (câu hỏi mở -> gõ text) + task-03 (câu hỏi 3 nút -> bấm)
- Open: none
## WI-4.3 — Menu TASK/ON-OFF PC + single task nút + OK/Cancel — DONE (2026-10-16)
- Changed: src/menu.js (nút TASK/ON-OFF PC); src/mmo-tasks.js (bỏ parseStt, pick single, taskListKeyboard, OK/Cancel); src/router.js (list nút tk:, confirm OK chạy/Cancel về list, text nhắc bấm nút); src/modes.js (comment single); test/mmo-tasks|convo|e2e.test.js; UI_SPEC 3.2-single/ARCHITECTURE v4.3-single/PROJECT_MAP 4.3-single/RELEASE_NOTES 4.3
- Decisions/assumed: Cancel quay lại list task (theo chốt user); text ở màn chọn chỉ nhắc bấm nút (VERIFIED npm test 181/181)
- Next: restart bot 1 lần; user T2 ĐT: /start -> TASK -> bấm nút task -> OK chạy / Cancel về list
- Open: none
