/**
 * resource-proxy server
 *
 * One HTTP server, multiple resource types on different URL paths.
 * Each subdomain routes here via nginx/caddy:
 *
 *   browser.todofor.ai/:sessionId  → /browser/:sessionId  → ws://browser:8085/cdp/:id
 *   vm.todofor.ai/:vmId            → /vm/:vmId            → ws://vm-service:9000/:id
 *   terminal.todofor.ai/:sessionId → /terminal/:sessionId → ws://terminal:7000/:id
 *
 * Or run one instance per subdomain with RESOURCE_TYPE env var.
 *
 * ENV:
 *   PORT            (default: 5000)
 *   DRAGONFLY_URL   (required) redis://...
 *   BROWSER_WS      (default: ws://localhost:8085)
 *   VM_WS           (default: ws://localhost:9000)      [future]
 *   TERMINAL_WS     (default: ws://localhost:7000)      [future]
 */

import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { ResourceProxy } from './proxy.ts';

const PORT = parseInt(process.env.PORT ?? '6000');

const BROWSER_WS = process.env.BROWSER_WS ??
  (process.env.NODE_ENV === 'production' ? 'ws://browser:8085' : 'ws://localhost:8085');

// ── Resource definitions ──────────────────────────────────────────────────────

const resources: Record<string, ResourceProxy> = {
  browser: new ResourceProxy({
    name: 'browser',
    upstreamUrl: (id) => `${BROWSER_WS}/cdp/${id}`,
    costPerMinute: 0.005,
  }),

  // Uncomment when services exist:
  // vm: new ResourceProxy({
  //   name: 'vm',
  //   upstreamUrl: (id) => `${process.env.VM_WS ?? 'ws://localhost:9000'}/${id}`,
  //   costPerMinute: 0.02,
  // }),
  // terminal: new ResourceProxy({
  //   name: 'terminal',
  //   upstreamUrl: (id) => `${process.env.TERMINAL_WS ?? 'ws://localhost:7000'}/${id}`,
  //   costPerMinute: 0.003,
  // }),
};

// ── Server ────────────────────────────────────────────────────────────────────

const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', resources: Object.keys(resources) }));
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // URL pattern: /:resourceType/:resourceId
  // e.g. /browser/abc-123  or  /vm/vm-456
  const match = req.url?.match(/^\/([^/]+)\/([^/?]+)/);
  if (!match) { socket.destroy(); return; }

  const [, resourceType, resourceId] = match;
  const proxy = resources[resourceType];

  if (!proxy) {
    socket.write(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nUnknown resource type: ${resourceType}`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    proxy.handle(ws, req, resourceId).catch((e) => {
      console.error(`[proxy] unhandled error:`, e);
      if (ws.readyState === WebSocket.OPEN) ws.close(4500, 'Internal error');
    });
  });
});

server.listen(PORT, () => {
  console.log(`🔌 resource-proxy listening on :${PORT}`);
  console.log(`   Resources: ${Object.keys(resources).join(', ')}`);
  console.log(`   browser → ${BROWSER_WS}/cdp/:id`);
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
