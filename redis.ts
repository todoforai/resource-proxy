/**
 * Minimal Redis client — only the two operations the proxy needs:
 *   - look up an API key → userId
 *   - check + deduct balance atomically
 *
 * Mirrors the exact key schema from backend/src/redis/BaseRepository.ts
 * so no shared code import is needed.
 */

import { createClient, type RedisClientType } from 'redis';

let client: RedisClientType | null = null;

export async function getRedis(): Promise<RedisClientType> {
  if (client?.isOpen) return client;
  const url = process.env.DRAGONFLY_URL;
  if (!url) throw new Error('DRAGONFLY_URL is required');
  client = createClient({ url }) as RedisClientType;
  client.on('error', (e) => console.error('[redis]', e.message));
  await client.connect();
  return client;
}

/** Look up userId from an API key. Returns null if not found. */
export async function getUserIdFromApiKey(key: string): Promise<string | null> {
  const redis = await getRedis();
  const data = await redis.hGetAll(`apikey:${key}`);
  return data?.userId ?? null;
}

/** Check if user has enough balance to cover at least `minimum` (default: > 0). */
export async function hasBalance(userId: string, minimum = 0): Promise<boolean> {
  const redis = await getRedis();
  const balance = await redis.hGet(`appuser:${userId}`, 'balance');
  return parseFloat(balance ?? '0') > minimum;
}

const DEDUCT_SCRIPT = `
  local key = KEYS[1]
  local amount = tonumber(ARGV[1])
  local subBal = tonumber(redis.call('HGET', key, 'subscriptionBalance') or '0')
  local manBal = tonumber(redis.call('HGET', key, 'manualBalance') or '0')
  if subBal >= amount then
    redis.call('HINCRBYFLOAT', key, 'subscriptionBalance', -amount)
    subBal = subBal - amount
  else
    local overflow = amount - subBal
    if subBal > 0 then redis.call('HSET', key, 'subscriptionBalance', '0') end
    redis.call('HINCRBYFLOAT', key, 'manualBalance', -overflow)
    subBal = 0
    manBal = manBal - overflow
  end
  local newBalance = redis.call('HINCRBYFLOAT', key, 'balance', -amount)
  redis.call('HINCRBYFLOAT', key, 'subscriptionUsageThisMonth', amount)
  return {tostring(newBalance), tostring(subBal), tostring(manBal)}
`;

/** Atomically deduct amount from user balance. Returns new total balance. */
export async function deductBalance(userId: string, amount: number): Promise<number> {
  const redis = await getRedis();
  const result = await redis.eval(DEDUCT_SCRIPT, {
    keys: [`appuser:${userId}`],
    arguments: [amount.toString()],
  }) as string[];
  return parseFloat(result[0]);
}
