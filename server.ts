/**
 * resource-proxy server
 *
 * Auth gateway for browser resources.
 * - Validates API keys / resource tokens from shared Redis
 * - WebSocket relay with per-minute billing
 *
 * Routes:
 *   GET    /health                    Health check
 *   WS     /browser/:sessionId        CDP relay (auth + billing)
 *
 * Session management (list/get/delete) goes through backend tRPC,
 * which talks directly to browsing server (internal network).
 *
 * ENV:
 *   PORT            (default: 6000)
 *   DRAGONFLY_URL   (required) redis://...
 *   BROWSER_WS      (default: ws://localhost:8085)
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ResourceProxy } from './proxy.ts';

const PORT = parseInt(process.env.PORT ?? '6000');

const BROWSER_WS = process.env.BROWSER_WS ??
  (process.env.NODE_ENV === 'production' ? 'ws://browser:8085' : 'ws://localhost:8085');

// ── HTTP Handler ──────────────────────────────────────────────────────────────

function handleHttp(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'resource-proxy' }));
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
  if (!match) {
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
  console.log(`   WebSocket: /browser/:sessionId?api_key=xxx`);
  console.log(`   Upstream: ${BROWSER_WS}`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
