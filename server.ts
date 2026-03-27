/**
 * resource-proxy server
 *
 * Auth gateway for browser/vm/terminal resources.
 * - HTTP API: create/list/get/delete sessions (auth required)
 * - WebSocket: CDP relay with per-minute billing
 *
 * Routes:
 *   POST   /browser/sessions          Create browser session
 *   GET    /browser/sessions          List my sessions
 *   GET    /browser/sessions/:id      Get session details
 *   DELETE /browser/sessions/:id      Close session
 *   DELETE /browser/sessions          Close all my sessions
 *   WS     /browser/:sessionId        CDP relay (with billing)
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

// Service key for backend → resource-proxy (trusted, userId in body)
const SERVICE_KEY = process.env.RESOURCE_PROXY_SERVICE_KEY || 'dev-service-key';

// ── Auth Helper ───────────────────────────────────────────────────────────────

function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return null;
}

function extractServiceKey(req: IncomingMessage): string | null {
  const key = req.headers['x-service-key'];
  return key ? (Array.isArray(key) ? key[0] : key) : null;
}

interface AuthResult {
  userId: string;
  isServiceAuth: boolean;
}

async function authenticate(req: IncomingMessage, res: ServerResponse, body?: any): Promise<AuthResult | null> {
  // 1. Service key auth (backend → proxy, userId in body)
  const serviceKey = extractServiceKey(req);
  if (serviceKey) {
    if (serviceKey !== SERVICE_KEY) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid service key' }));
      return null;
    }
    const userId = body?.userId;
    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId required with service key' }));
      return null;
    }
    return { userId, isServiceAuth: true };
  }

  // 2. API key auth (direct client access)
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing API key' }));
    return null;
  }
  const userId = await getUserIdFromApiKey(apiKey);
  if (!userId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid API key' }));
    return null;
  }
  return { userId, isServiceAuth: false };
}

// ── HTTP API ──────────────────────────────────────────────────────────────────

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const method = req.method ?? 'GET';

  // Health check (no auth)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Browser session APIs
  if (url.pathname.startsWith('/browser/sessions')) {
    const body = method !== 'GET' ? await readBody(req) : undefined;
    const auth = await authenticate(req, res, body);
    if (!auth) return;

    const { userId } = auth;
    const sessionId = url.pathname.split('/')[3]; // /browser/sessions/:id

    // POST /browser/sessions — create
    if (method === 'POST' && !sessionId) {
      const upstream = await fetch(`${BROWSER_HTTP}/api/cdp-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, viewport: body.viewport }),
      });
      const session = await upstream.json();
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
      return;
    }

    // GET /browser/sessions — list my sessions
    if (method === 'GET' && !sessionId) {
      const upstream = await fetch(`${BROWSER_HTTP}/api/cdp-sessions?userId=${userId}`);
      const sessions = await upstream.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
      return;
    }

    // GET /browser/sessions/:id — get session
    if (method === 'GET' && sessionId) {
      const upstream = await fetch(`${BROWSER_HTTP}/api/cdp-sessions/${sessionId}`);
      if (!upstream.ok) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      const session = await upstream.json() as any;
      // Only return if user owns this session
      if (session.userId !== userId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
      return;
    }

    // DELETE /browser/sessions/:id — close session
    if (method === 'DELETE' && sessionId) {
      // Verify ownership first
      const check = await fetch(`${BROWSER_HTTP}/api/cdp-sessions/${sessionId}`);
      if (check.ok) {
        const session = await check.json() as any;
        if (session.userId !== userId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
      }
      await fetch(`${BROWSER_HTTP}/api/cdp-sessions/${sessionId}`, { method: 'DELETE' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // DELETE /browser/sessions — close all my sessions
    if (method === 'DELETE' && !sessionId) {
      const upstream = await fetch(`${BROWSER_HTTP}/api/cdp-sessions?userId=${userId}`, { method: 'DELETE' });
      const result = await upstream.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
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

// ── WebSocket Proxy ───────────────────────────────────────────────────────────

const browserProxy = new ResourceProxy({
  name: 'browser',
  upstreamUrl: (id) => `${BROWSER_WS}/cdp/${id}`,
  costPerMinute: 0.005,
});

const server = createServer(handleHttp);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // URL pattern: /browser/:sessionId
  const match = req.url?.match(/^\/browser\/([^/?]+)/);
  if (!match || match[1] === 'sessions') {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    browserProxy.handle(ws, req, sessionId).catch((e) => {
      console.error(`[proxy] error:`, e);
      if (ws.readyState === WebSocket.OPEN) ws.close(4500, 'Internal error');
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`🔌 resource-proxy on :${PORT}`);
  console.log(`   HTTP API: /browser/sessions`);
  console.log(`   WebSocket: /browser/:sessionId`);
  console.log(`   Upstream: ${BROWSER_HTTP} (HTTP), ${BROWSER_WS} (WS)`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
