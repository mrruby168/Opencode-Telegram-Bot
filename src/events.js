// Chuẩn hóa event SSE opencode về dạng chung để runner không phụ thuộc phiên bản.
// Xác minh: .d.ts (EventMessagePartUpdated.delta, EventMessagePartRemoved,
// EventSessionError.properties.error{name,data.message}) + smoke thật
// (message.updated role, part.text, session.status busy/retry{attempt,message}).
// permission.*/question.* live chưa thấy → phòng thủ cả shape v1 lẫn v2 (UNVERIFIED).

export function normalizeEvent(event) {
  if (!event || typeof event.type !== 'string') return { kind: 'other' };
  const p = event.properties ?? {};
  const sid = p.sessionID ?? p.sessionId ?? null;

  if (event.type === 'session.idle') return { kind: 'idle', sessionId: sid };
  if (event.type === 'session.status') {
    const st = p.status;
    if (st && typeof st === 'object') {
      if (st.type === 'idle') return { kind: 'idle', sessionId: sid };
      if (st.type === 'retry') {
        return {
          attempt: st.attempt ?? null,
          kind: 'retry',
          message: typeof st.message === 'string' ? st.message : '',
          sessionId: sid
        };
      }
      return { kind: 'status', sessionId: sid, status: st.type ?? 'busy' };
    }
    const s = p.status ?? st;
    return { kind: s === 'idle' ? 'idle' : 'status', sessionId: sid, status: s };
  }
  if (event.type === 'session.error') {
    const err = p.error ?? {};
    const message = err?.data?.message || err?.message || err?.name || p.message || 'session error';
    return { kind: 'error', message: String(message).slice(0, 500), sessionId: sid };
  }
  if (event.type === 'message.updated') {
    const info = p.info ?? {};
    return { kind: 'message', messageId: info.id ?? null, role: info.role ?? 'unknown', sessionId: sid };
  }
  if (event.type === 'message.part.updated') {
    const part = p.part ?? {};
    if (part.type === 'tool') {
      const name = part.tool || part.command || '';
      const detail = part.filename || part.command || part.description || '';
      const note = `đang chạy ${name}${detail && detail !== name ? `: ${detail}` : ''}`.trim().slice(0, 120);
      return { kind: 'tool', note, sessionId: sid };
    }
    // Delta: phần text mới thêm vào (cộng dồn vào đúng part).
    if (typeof p.delta === 'string' && p.delta) {
      return {
        kind: 'delta',
        messageId: part.messageID ?? p.messageID ?? null,
        partId: part.id ?? null,
        sessionId: sid,
        text: p.delta
      };
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      // part.synthetic/part.ignored: bỏ qua, không gom vào đáp án.
      if (part.synthetic || part.ignored) {
        return { kind: 'ignored', messageId: part.messageID ?? null, partId: part.id ?? null, sessionId: sid };
      }
      // part.text là TOÀN BỘ text hiện tại của part → thay thế, không cộng dồn.
      return {
        kind: 'text',
        messageId: part.messageID ?? p.messageID ?? null,
        partId: part.id ?? null,
        sessionId: sid,
        text: part.text
      };
    }
    return { kind: 'other', sessionId: sid };
  }
  if (event.type === 'message.part.removed') {
    return { kind: 'removed', partId: p.partID ?? null, sessionId: sid };
  }
  if (event.type === 'permission.updated' || event.type === 'permission.asked') {
    return { kind: 'permission', permission: p, sessionId: p.sessionID ?? sid };
  }
  if (event.type === 'question.asked') {
    return { kind: 'question', question: p, sessionId: p.sessionID ?? sid };
  }
  return { kind: 'other', sessionId: sid };
}
