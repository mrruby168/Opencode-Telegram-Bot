# DECISIONS

| T1 | `node --test test/` báo MODULE_NOT_FOUND | Dùng glob `node --test "test/*.test.js"` | Dạng thư mục không chạy được trên môi trường này, glob chạy xanh |
| T3 | Serve 401 toàn bộ endpoint khi không auth, không in password | Client gửi `Basic base64(user:pass)`; `OPENCODE_SERVER_PASSWORD` vừa là mật khẩu khi spawn server vừa là client (đã verify 200 với env pw) | Đo thực tế: không auth → 401; đoán user/pass → 401; env pw + Basic → 200. User tự copy password từ `.env` bridge |
| T3 | `headers` truyền string bị server từ chối ngầm | Sửa thành object `{Authorization}` đúng mẫu bridge | Đo: string → health DOWN; object → OK |
| T3 | `sub.stream` không có `getReader` | Dùng `for await` (AsyncGenerator), event đầu `server.connected` | Đo trực tiếp trên server thật |
| T3 | Prompt không sinh session events (thiếu provider AI) | `message.*`/`permission.*`/`question.*` ghi UNVERIFIED; code phòng thủ + fixture từ `.d.ts` | Không ép model chạy trong smoke |
| T6 | Mã exit shutdown.exe chưa verify (cấm chạy thật) | 0=OK; 1191→đã-có-lệnh, 1116→không-có-gì-hủy (ghi UNVERIFIED, luôn hiện mã số); mã khác → ERROR | Phân loại thận trọng: chỉ 2 mã benign, còn lại ERROR |
| T7 | `createBotHandlers` tự tạo power thật, test chạm exec thật | Inject `power` qua deps (mặc định tạo real) | Test không bao giờ chạy shutdown thật; từng suýt chạy `/a` thật ở test cancel |
| T7 | Replace regex `power.` ăn luôn `import ... from './power.js'` | Sửa tay import + kiểm tra từng dòng match | Bài học: không replace regex mù, luôn liệt kê match trước |
| T8 | Smoke báo health OK giả (SDK resolve `{error:{}}` không throw) | Health/test luôn đi qua wrapper `throwIfError` | Không gọi SDK trần để kết luận |
| T9 | PNG preview chữ Việt có dấu khó render qua System.Drawing | PNG dùng chữ không dấu; SVG giữ tiếng Việt chuẩn | Mockup hình ảnh, không ảnh hưởng bot (bot gửi text Unicode thật) |
| FIX-2 | Serve tươi 401 toàn endpoint; pass từ đâu? | `OPENCODE_SERVER_PASSWORD` env vừa đặt pass serve vừa dùng cho client (đo 200) | Không đoán; user tự điền pass, health phân loại UNAUTHORIZED rõ |
| FIX-2 | Prompt accepted nhưng 0 event session | Thêm model vào prompt (Zen free vẫn chạy); thu được message/status/diff thật | Nguyên nhân "thiếu provider" cũ: thiếu model trong prompt |
| FIX-3 | user text lẫn vào đáp án nếu gom text mù | Chỉ gom text role=assistant (map qua message.updated) | Đo fixture thật: part không mang role |
| FIX-8 | Reviewer nghi `opencode debug config` không tồn tại | Lệnh TỒN TẠI (`debug --help` liệt kê) | Verify bằng --help thay vì tin docs |
| BƯỚC-1 | `npm test` treo sau khi e2e đã xanh: SDK SSE tự retry vô hạn (sleep 3s, `serverSentEvents.gen.js:111`) + `for-await` không bị ngắt khi `close()` | `runner.close()` abort signal + `stream.return()` + unref reconnect 2s; `subscribe` truyền `signal`; fake `close()` clear fallback timer | Đo: 1 Timeout refed từ SDK retry; sau sửa `npm test` 119/119 tự thoát x2 (~20s), test `watcher-close` ĐỎ-cũ/XANH-mới |
| BƯỚC-2 | Smoke DOWN do `spawn opencode` thiếu shell trên Windows (ENOENT); kill shell để sót `opencode.exe` cháu (port 4097) | Smoke `shell: win32` (giống server.js) + cleanup kill đúng con của shell rồi verify DOWN | Đo: health OK; 3 model echo prompt (không lượt OK nào); `session.error` APIError tt-web key website-only; permission/question 0 event → vẫn UNVERIFIED; `real-run.json` synthetic:true |
| BƯỚC-3 | Đóng gói sợ lọt secret: test/ chứa token GIẢ cố ý (mask/chunk) gây báo động giả | Quét secret trừ test/+fixtures (ghi rõ lý do); `.env.example` kiểm tra giá trị password thật | Đo: zip 54 files 123282 bytes, scan sạch; doctor/pack test ĐỎ-cũ/XANH-mới |
| BƯỚC-4 | Spec ghi syntax "13+2" nhưng scripts/ đã có 5 file (thêm doctor/pack) | `check-syntax.mjs` quét tự động mọi scripts nên vẫn đúng; không sửa spec cũ, ghi nhận tại đây | Đo: syntax OK 13 src + 5 scripts |
| FIX-doctor | Doctor thật báo opencode-bin WARN dù binary có sẵn: `execFile` thiếu shell (ENOENT với .ps1) | `shell: win32` + export `defaultExecFn` + test exec thật `--version` | Đo: test ĐỎ-cũ/XANH-mới; `npm test` 132/132 |
| NO-REFACTOR | Prompt yêu cầu FIX 1/2 TRÊN cấu trúc hiện tại, router ~580/runner ~556 dòng còn nguyên | Chỉ thêm file mới + mở rộng tối thiểu (param tùy chọn), không tách thư mục | Giữ 132 test cũ xanh |
| SHOT-1 | Chụp màn hình máy Windows đang chạy bot, chỉ whitelist | PowerShell System.Windows.Forms+Drawing, VirtualScreen đa màn hình, DPI awareness, execFile argv cố định + windowsHide + timeout, không shell:true, không input user | Mặc định an toàn nhất, không native dep |
| SHOT-2 | Nút Gửi bản gốc sau khi xóa temp thì không còn file | Giữ file 5 phút theo nonce để phục vụ nút, xóa sau khi gửi/lỗi/hết hạn (finally cho nhánh lỗi) | Vẫn đảm bảo xóa, không đầy đĩa |
| CHAT-1 | opencode có thể tự nạp AGENTS.md dù chat gửi nguyên văn | Ghi UNVERIFIED, thêm OPENCODE_CHAT_DIR tùy chọn (mặc định = project dir) | Không đoán hành vi server |
| WF-1 | Workflow JSON lỗi không được crash bot | Bỏ qua file lỗi, liệt kê lý do trong /log + doctor | An toàn khi user tự viết workflow |
| GIT-1 | `git` treo không phản hồi (shim C:\Windows\system32\git) | Bỏ qua commit giữa chừng, vẫn thực thi đủ FIX, ghi nhận BLOCKED | Không dùng git push/reset/clean |
| STATUS-1 | Text `/...` thiếu entity bot_command lọt vào handleText thành nội dung chat/task | Guard `startsWith('/')` → hiện lại menu, không submit (mọi mode; input workflow bắt đầu `/` cực hiếm, chấp nhận) | Đo: test ĐỎ-cũ/XANH-mới trong status-log.test.js |
| STATUS-2 | `/status` khi DOWN chỉ in chữ, không đề xuất bật như `/start` | Thêm nút Có/Không dùng chung serverPending/handleServerCallback (option a, không tự bật im lặng) | Đo: test DOWN có sv:yes, OK không hỏi |
| QUEUE-1 | `position = waiting.length+1` khiến task đầu lúc rảnh cũng báo "vị trí 1" (xác minh live qua ảnh user) | `waiting.length + (running?1:0)`; test cũ b.position=1 vẫn đúng | Đo: test rảnh=0 ĐỎ-cũ/XANH-mới |
| STOP-1 | Task dừng bởi /stop vẫn giao tin settle gây nhầm (rỗng/partial cũ) | stopped→"Đã hủy trước khi chạy"; ABORTED→"Đã dừng, bỏ kết quả dở dang"; vẫn recordTask | Đo: 3 test settle trong convo.test.js |
| SEND-1 | Telegram API treo giữ task vô hạn (timeout pause khi chờ duyệt) | Sender timeout 20s (inject được); askApproval gửi lỗi thì reject/expired an toàn | Đo: test treo 50ms reject nhanh |
| DUP-1 | Kết quả lặp 2 lần: tin streaming giữ nguyên + tin sendFinal mới | sendFinal xóa tin tiến trình trước khi đăng (best-effort, lỗi thì log) | Đo: test deleteMessage ĐỎ-cũ/XANH-mới |
| CHAT-2 | Chat hiện thinking + tool-note gây nhiễu | runnerOnText bỏ qua khi mode CHAT (mode khác giữ streaming) | Đo: test edits=0 |
| CHAT-3 | Chat cần plain text, không **** | toPlainChatText strip ** ở settle chat (không sửa prompt nguyên văn) | Đo: test strip ** |
| 3MODE-1 | Yêu cầu chỉ còn 3 mode MMO/AIRDROP/PC | Gỡ CODE/CHAT/multitask/report cũ (src + test + workflows/); modes.js là nguồn duy nhất; engine giữ nguyên | Đo: npm test xanh, không còn ref cũ (grep) |
| 3MODE-2 | MMO báo cáo task/doanh thu thiếu rule file riêng | Prompt chỉ AI đọc Trade/Library/RULE-AI + dữ liệu MMO, AI tự thích ứng | Không đoán cấu trúc dữ liệu |
| 3MODE-3 | Report dài lưu ở đâu | MMO→MMO\report, AIRDROP→MMO\Airdrop\report, tên YYYY-MM-DD-slug.md, reply tóm tắt + Chi tiết tại | Theo đúng yêu cầu user |
| 3MODE-4 | Output ngắn gọn không ký hiệu | Hợp đồng trong prompt + toPlainText strip **,__,`,# đầu dòng ở bot | Không cắt nội dung AI |
| 2MODE-1 | Chỉ còn 2 mode: AIRDROP chạy ngay + PC (tắt 60s, chụp màn hình) | Gỡ MMO/check-telegram/quản lý dự án; menu:airdrop submit defaultText ngay; power /t 60, lệnh /shutdown | Đo: npm test xanh |
