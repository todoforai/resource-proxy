/**
 * resource-proxy server
 *
 * Auth gateway + session management for browser resources.
 *
 * HTTP API:
 *   POST   /browser/sessions          Create session
 *   GET    /browser/sessions          List my sessions  
 *   GET    /browser/sessions/:id      Get session details
 *   DELETE /browser/sessions/:id      Close session
 *   DELETE /browser/sessions          Close all my sessions
 *
 * WebSocket:
 *   /browser/:sessionId?api_key=xxx   CDP relay with billing
 *
 * Auth: x-api-key header or ?api_key= query param
 * Both validate against shared Redis (apikey:* or resource:token:*)
 *
 * ENV:
 *   PORT            (default: 6000)
 *   DRAGONFLY_URL   (required) redis://...
 *   BROWSER_HTTP    (default: http://localhost:8086)
 *   BROWSER_WS      (default: ws://localhost:8085)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ResourceProxy } from './proxy.ts';
import { getUserIdFromApiKey } from './redis.ts';

const PORT = parseInt(process.env.PORT ?? '6000');

const BROWSER_HTTP = process.env.BROWSER_HTTP ??
  (process.env.NODE_ENV === 'production' ? 'http://browser:8086' : 'http://localhost:8086');

const BROWSER_WS = process.env.BROWSER_WS ??
  (process.env.NODE_ENV === 'production' ? 'ws://browser:8085' : 'ws://localhost:8085');

// ── Auth ──────────────────────────────────────────────────────────────────────

function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return Array.isArray(apiKey) ? apiKey[0] : apiKey;
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  return url.searchParams.get('api_key');
}

async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.writeHead(401, jsonHeaders());
    res.end(JSON.stringify({ error: 'Missing API key' }));
    return null;
  }
  const userId = await getUserIdFromApiKey(apiKey);
  if (!userId) {
    res.writeHead(403, jsonHeaders());
    res.end(JSON.stringify({ error: 'Invalid API key' }));
    return null;
  }
  return userId;
}

// ── HTTP Helpers ──────────────────────────────────────────────────────────────

function jsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
  };
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
  });
}

async function browsingFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BROWSER_HTTP}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

// ── HTTP Handler ──────────────────────────────────────────────────────────────

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, jsonHeaders());
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // ── Browser Session API ─────────────────────────────────────────────────────

  if (url.pathname.startsWith('/browser/sessions')) {
    const userId = await authenticate(req, res);
    if (!userId) return;

    const pathParts = url.pathname.split('/');
    const sessionId = pathParts[3]; // /browser/sessions/:id

    // POST /browser/sessions — create
    if (method === 'POST' && !sessionId) {
      const body = await readBody(req);
      const { ok, data } = await browsingFetch('/api/cdp-sessions', {
        method: 'POST',
        body: JSON.stringify({ userId, viewport: body.viewport }),
      });
      if (!ok) {
        res.writeHead(500, jsonHeaders());
        res.end(JSON.stringify({ error: 'Failed to create session' }));
        return;
      }
      // Return session info with CDP URL
      res.writeHead(201, jsonHeaders());
      res.end(JSON.stringify({
        ...data,
        cdpUrl: `${req.headers.host?.includes('localhost') ? 'ws' : 'wss'}://${req.headers.host}/browser/${data.sessionId}`,
      }));
      return;
    }

    // GET /browser/sessions — list
    if (method === 'GET' && !sessionId) {
      const { data } = await browsingFetch(`/api/cdp-sessions?userId=${userId}`);
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify(data ?? []));
      return;
    }

    // GET /browser/sessions/:id — get
    if (method === 'GET' && sessionId) {
      const { ok, data } = await browsingFetch(`/api/cdp-sessions/${sessionId}`);
      if (!ok || data?.userId !== userId) {
        res.writeHead(404, jsonHeaders());
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify(data));
      return;
    }

    // DELETE /browser/sessions/:id — delete one
    if (method === 'DELETE' && sessionId) {
      // Verify ownership
      const { ok, data } = await browsingFetch(`/api/cdp-sessions/${sessionId}`);
      if (!ok || data?.userId !== userId) {
        res.writeHead(404, jsonHeaders());
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      await browsingFetch(`/api/cdp-sessions/${sessionId}`, { method: 'DELETE' });
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // DELETE /browser/sessions — delete all
    if (method === 'DELETE' && !sessionId) {
      const { data } = await browsingFetch(`/api/cdp-sessions?userId=${userId}`, { method: 'DELETE' });
      res.writeHead(200, jsonHeaders());
      res.end(JSON.stringify(data ?? { deleted: 0 }));
      return;
    }
  }

  // 404
  res.writeHead(404, jsonHeaders());
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ── WebSocket Proxy ───────────────────────────────────────────────────────────

const browserProxy = new ResourceProxy({
  name: 'browser',
  upstreamUrl: (id) => `${BROWSER_WS}/cdp/${id}`,
  costPerMinute: 0.005,
});

const server = createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // /browser/:sessionId (not /browser/sessions)
  const match = req.url?.match(/^\/browser\/([^/?]+)/);
  if (!match || match[1] === 'sessions') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    browserProxy.handle(ws, req, match[1]).catch((e) => {
      console.error(`[proxy] error:`, e);
      if (ws.readyState === WebSocket.OPEN) ws.close(4500, 'Internal error');
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🔌 resource-proxy on :${PORT}`);
  console.log(`   HTTP:      /browser/sessions`);
  console.log(`   WebSocket: /browser/:sessionId`);
  console.log(`   Upstream:  ${BROWSER_HTTP} (HTTP), ${BROWSER_WS} (WS)`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
