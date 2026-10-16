// Fake opencode HTTP server cho e2e offline. Không mạng ngoài, cổng ngẫu nhiên.
// Endpoint khớp SDK v1 đã xác minh (.d.ts): status/create/prompt_async/event/abort/
// messages/permissions/providers. SSE frames dạng `data: <json>\n\n` (khớp parser SDK).
import http from 'node:http';

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export async function startFakeOpencode() {
  const state = {
    aborts: [],
    created: 0,
    deleted: [],
    messagesMap: {},
    permissions: [],
    prompts: [],
    providersPayload: { default: {}, providers: [] },
    sseClients: new Set(),
    statusMap: {}
  };

  function emit(obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of [...state.sseClients]) {
      try {
        res.write(frame);
      } catch {
        state.sseClients.delete(res);
      }
    }
  }

  function emitSession(sid, events) {
    for (const e of events) {
      emit({ properties: { ...(e.properties || {}), sessionID: sid }, type: e.type });
    }
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let json = {};
      try {
        json = body ? JSON.parse(body) : {};
      } catch {
        json = {};
      }
      if (req.method === 'GET' && path === '/session/status') return send(res, 200, state.statusMap);
      if (req.method === 'GET' && path === '/config/providers') return send(res, 200, state.providersPayload);
      if (req.method === 'GET' && path === '/event') {
        res.writeHead(200, {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream'
        });
        res.write(':connected\n\n');
        state.sseClients.add(res);
        res.on('close', () => state.sseClients.delete(res));
        return;
      }
      if (req.method === 'POST' && path === '/session') {
        state.created += 1;
        const id = `ses-e2e-${state.created}`;
        state.statusMap[id] = { type: 'busy' };
        return send(res, 200, { id });
      }
      let m = path.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (req.method === 'POST' && m) {
        state.prompts.push({ body: json, id: m[1] });
        if (state.onPrompt) void state.onPrompt(m[1], json);
        res.writeHead(204);
        return res.end();
      }
      m = path.match(/^\/session\/([^/]+)\/abort$/);
      if (req.method === 'POST' && m) {
        state.aborts.push(m[1]);
        state.statusMap[m[1]] = { type: 'idle' };
        return send(res, 200, true);
      }
      m = path.match(/^\/session\/([^/]+)\/message$/);
      if (req.method === 'GET' && m) {
        return send(res, 200, state.messagesMap[m[1]] || []);
      }
      m = path.match(/^\/session\/([^/]+)\/permissions\/([^/]+)$/);
      if (req.method === 'POST' && m) {
        state.permissions.push({ permissionID: m[2], response: json.response, sessionId: m[1] });
        return send(res, 200, true);
      }
      m = path.match(/^\/session\/([^/]+)$/);
      if (req.method === 'DELETE' && m) {
        state.deleted.push(m[1]);
        return send(res, 200, {});
      }
      send(res, 404, { error: 'fake: unknown route' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    close: () =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try {
            clearTimeout(fallback);
          } catch { /* bỏ qua */ }
          resolve();
        };
        for (const res of [...state.sseClients]) {
          try {
            res.destroy();
          } catch {
            /* bỏ qua */
          }
        }
        state.sseClients.clear();
        // Đóng cả keep-alive connections để server.close() không treo.
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch { /* bỏ qua */ }
        server.close(() => finish());
        const fallback = setTimeout(finish, 3000);
        if (typeof fallback.unref === 'function') fallback.unref();
      }),
    emit,
    emitSession,
    killSse: () => {
      for (const res of [...state.sseClients]) {
        try {
          res.destroy();
        } catch {
          /* bỏ qua */
        }
        state.sseClients.delete(res);
      }
    },
    state,
    url: `http://127.0.0.1:${port}`
  };
}
