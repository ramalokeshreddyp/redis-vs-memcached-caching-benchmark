import { createClient, RedisClientType } from 'redis';
import { ICacheBackend } from './base';
import { config } from '../config';

export class RedisCacheBackend implements ICacheBackend {
  private client: RedisClientType;

  constructor() {
    this.client = createClient({ url: config.redisUrl });
    this.client.connect().catch((err) => {
      console.error('Failed to connect to Redis:', err);
    });
  }

  async get(key: string): Promise<string | null> {
    return await this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.setEx(key, ttlSeconds, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  // 1. Invalidation Pattern
  async getProduct(productId: string): Promise<string | null> {
    return await this.get(`product:${productId}`);
  }

  async cacheProduct(productId: string, productData: string, ttlSeconds: number): Promise<void> {
    await this.set(`product:${productId}`, productData, ttlSeconds);
  }

  async invalidateProduct(productId: string): Promise<void> {
    const key = `product:${productId}`;
    await this.client.del(key);
    // Publish invalidation event for multi-instance notification
    await this.client.publish('product:invalidations', productId);
  }

  // 2. Session Pattern: HGETALL/HSET
  async getSession(sessionId: string): Promise<Record<string, string> | null> {
    const data = await this.client.hGetAll(`session:${sessionId}`);
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return data;
  }

  async updateSessionField(sessionId: string, field: string, value: string): Promise<void> {
    await this.client.hSet(`session:${sessionId}`, field, value);
  }

  // 3. Leaderboard Pattern: ZSET
  async incrementProductView(productId: string): Promise<void> {
    await this.client.zIncrBy('leaderboard:views', 1, productId);
  }

  async getLeaderboard(): Promise<Array<{ id: string; views: number }>> {
    // Run raw command to bypass typed interface variation across minor versions of node-redis v4
    const raw = await this.client.sendCommand(['ZREVRANGE', 'leaderboard:views', '0', '9', 'WITHSCORES']) as string[];
    const leaderboard: Array<{ id: string; views: number }> = [];
    for (let i = 0; i < raw.length; i += 2) {
      leaderboard.push({
        id: raw[i],
        views: parseInt(raw[i + 1], 10),
      });
    }
    return leaderboard;
  }

  // 4. Rate Limiter Pattern: Lua Script
  async rateLimit(userId: string, limit: number, windowSeconds: number): Promise<{
    current: number;
    exceeded: boolean;
    ttlRemaining: number;
  }> {
    const key = `rate:limit:${userId}`;
    const luaScript = `
      local key = KEYS[1]
      local limit = tonumber(ARGV[1])
      local window = tonumber(ARGV[2])

      local current = redis.call('GET', key)
      if current and tonumber(current) >= limit then
        local ttl = redis.call('TTL', key)
        return { tonumber(current) + 1, ttl }
      end

      local val = redis.call('INCR', key)
      local ttl = redis.call('TTL', key)
      if ttl == -1 then
        redis.call('EXPIRE', key, window)
        ttl = window
      end
      return { val, ttl }
    `;

    const result = await this.client.eval(luaScript, {
      keys: [key],
      arguments: [limit.toString(), windowSeconds.toString()],
    }) as [number, number];

    const [current, ttlRemaining] = result;
    return {
      current,
      exceeded: current > limit,
      ttlRemaining: ttlRemaining < 0 ? windowSeconds : ttlRemaining,
    };
  }
}
