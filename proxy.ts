/**
 * ResourceProxy — auth + relay + per-minute metering.
 * One instance per resource type (browser, vm, terminal, ...).
 */

import { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import { getUserIdFromApiKey, hasBalance, deductBalance } from './redis.ts';

const METER_INTERVAL_MS = 60_000;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

export interface ResourceConfig {
  name: string;
  upstreamUrl: (resourceId: string, userId: string) => string | Promise<string>;
  costPerMinute: number;
}

export class ResourceProxy {
  constructor(private config: ResourceConfig) {}

  async handle(client: WebSocket, req: IncomingMessage, resourceId: string): Promise<void> {
    // 1. Auth
    const token = extractToken(req);
    if (!token) { client.close(4401, 'Missing API key'); return; }

    const userId = await getUserIdFromApiKey(token);
    if (!userId) { client.close(4403, 'Invalid API key'); return; }

    // 2. Balance check — must cover at least one minute
    if (!(await hasBalance(userId, this.config.costPerMinute))) {
      client.close(4402, 'Insufficient balance');
      return;
    }

    // 3. Connect upstream
    const upstreamUrl = await this.config.upstreamUrl(resourceId, userId);
    const upstream = new WebSocket(upstreamUrl);

    // Attach client cleanup immediately — before upstream opens
    let meter: ReturnType<typeof setInterval> | null = null;
    const cleanup = () => {
      if (meter) clearInterval(meter);
      if (upstream.readyState < WebSocket.CLOSING) upstream.close();
    };
    client.on('close', cleanup);
    client.on('error', cleanup);

    // Upstream connect timeout
    const connectTimeout = setTimeout(() => {
      console.error(`[${this.config.name}] upstream timeout ${resourceId}`);
      upstream.terminate();
      if (client.readyState === WebSocket.OPEN) client.close(4500, 'Upstream timeout');
    }, UPSTREAM_CONNECT_TIMEOUT_MS);

    upstream.on('error', (e) => {
      clearTimeout(connectTimeout);
      console.error(`[${this.config.name}] upstream error ${resourceId}:`, e.message);
      if (client.readyState === WebSocket.OPEN) client.close(4500, 'Upstream error');
    });

    upstream.on('close', (code, reason) => {
      clearTimeout(connectTimeout);
      if (meter) clearInterval(meter);
      if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    });

    upstream.on('open', () => {
      clearTimeout(connectTimeout);
      console.log(`[${this.config.name}] ${userId} → ${resourceId}`);

      // 4. Relay (binary-safe)
      upstream.on('message', (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });

      // 5. Meter — charge first minute immediately, then every 60s
      const charge = async () => {
        try {
          const remaining = await deductBalance(userId, this.config.costPerMinute);
          if (remaining <= 0) {
            if (meter) clearInterval(meter);
            if (client.readyState === WebSocket.OPEN) client.close(4402, 'Balance depleted');
          }
        } catch (e) {
          console.error(`[${this.config.name}] billing error ${userId}:`, e);
          if (meter) clearInterval(meter);
          if (client.readyState === WebSocket.OPEN) client.close(4500, 'Billing error');
        }
      };
      charge(); // charge upfront for first minute
      meter = setInterval(charge, METER_INTERVAL_MS);
    });
  }
}

function extractToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  // x-api-key header
  const apiKey = req.headers['x-api-key'];
  if (apiKey) return Array.isArray(apiKey) ? apiKey[0] : apiKey;
  return null;
}
