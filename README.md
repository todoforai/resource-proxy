# resource-proxy

Minimal WebSocket proxy for `browser.todofor.ai`, `vm.todofor.ai`, etc.

**~150 lines total. No framework. No shared backend code.**

## What it does

1. Accepts WebSocket connection on `/:resourceType/:resourceId`
2. Verifies API key against Redis (`apikey:{key}` → `userId`)
3. Checks balance (`appuser:{userId}.balance > 0`)
4. Proxies to the internal upstream service
5. Deducts `costPerMinute` every 60s, closes if balance hits 0

## Files

```
server.ts   — HTTP server + URL routing (add new resources here)
proxy.ts    — ResourceProxy class (auth + relay + meter)
redis.ts    — Two Redis ops: key lookup + atomic balance deduct
nginx.conf  — Subdomain → proxy routing
```

## Run

```bash
DRAGONFLY_URL=redis://:password@localhost:41337 bun server.ts
```

## Client usage

```typescript
// Playwright
const browser = await chromium.connectOverCDP(
  'wss://browser.todofor.ai/abc-session-id',
  { headers: { Authorization: 'Bearer todo_xxx' } }
);

// Puppeteer
const browser = await puppeteer.connect({
  browserWSEndpoint: 'wss://browser.todofor.ai/abc-session-id',
  headers: { Authorization: 'Bearer todo_xxx' },
});

// Raw CDP
const ws = new WebSocket('wss://browser.todofor.ai/abc-session-id', {
  headers: { Authorization: 'Bearer todo_xxx' }
});
```

## Adding a new resource type

1. Start your service (e.g. `vm-service` on port 9000)
2. Uncomment the `vm` entry in `server.ts`
3. Add `vm.todofor.ai` to `nginx.conf`
4. Done — auth + metering is inherited automatically

## Architecture

```
browser.todofor.ai/:sessionId
        │
        │  nginx rewrite → /browser/:sessionId
        ▼
  resource-proxy :5000
        │
        │  1. HGETALL apikey:{token}     → userId
        │  2. HGET appuser:{userId} balance > 0?
        │  3. ws://browser:8085/cdp/:sessionId
        │  4. relay CDP JSON-RPC
        │  5. every 60s: EVAL deduct $0.005
        ▼
  browsing server :8085
        │
        ▼
  Chrome (CDP)
```
