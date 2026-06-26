import { Client } from 'memjs';
import { ICacheBackend } from './base';
import { config } from '../config';

export class MemcachedCacheBackend implements ICacheBackend {
  private client: Client;

  constructor() {
    this.client = Client.create(config.memcachedUrl);
  }

  async get(key: string): Promise<string | null> {
    try {
      const res = await this.client.get(key);
      return res && res.value ? res.value.toString() : null;
    } catch (err) {
      console.error(`Memcached get error for key ${key}:`, err);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, value, { expires: ttlSeconds });
    } catch (err) {
      console.error(`Memcached set error for key ${key}:`, err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.delete(key);
    } catch (err) {
      console.error(`Memcached delete error for key ${key}:`, err);
    }
  }

  // Helper to acquire a distributed lock using ADD
  private async acquireLock(lockKey: string, ttlSeconds = 5, maxRetries = 100, initialDelayMs = 5): Promise<boolean> {
    let delay = initialDelayMs;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const success = await this.client.add(lockKey, 'locked', { expires: ttlSeconds });
        if (success) {
          return true;
        }
      } catch (err) {
        // If error (or key exists), retry
      }
      const jitter = Math.random() * 5;
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      delay = Math.min(delay * 1.5, 150); // backoff capped at 150ms
    }
    return false;
  }

  // Helper for cache versioning
  private async getGlobalVersion(): Promise<string> {
    const versionKey = 'product:global_version';
    let version = await this.get(versionKey);
    if (!version) {
      version = '1';
      try {
        await this.client.add(versionKey, '1', { expires: 0 });
      } catch (err) {
        // In case of parallel write, fetch again
        version = (await this.get(versionKey)) || '1';
      }
    }
    return version;
  }

  // 1. Invalidation Pattern (Cache Versioning)
  async getProduct(productId: string): Promise<string | null> {
    const version = await this.getGlobalVersion();
    return await this.get(`product:v${version}:${productId}`);
  }

  async cacheProduct(productId: string, productData: string, ttlSeconds: number): Promise<void> {
    const version = await this.getGlobalVersion();
    await this.set(`product:v${version}:${productId}`, productData, ttlSeconds);
  }

  async invalidateProduct(productId: string): Promise<void> {
    const versionKey = 'product:global_version';
    try {
      // Increment global version key
      const res = await this.client.increment(versionKey, 1);
      if (!res || !res.value) {
        // If not initialized, initialize to 2 (1 incremented)
        await this.client.set(versionKey, '2', {});
      }
    } catch (err) {
      await this.client.set(versionKey, '2', {});
    }
  }

  // 2. Session Pattern: JSON serialization of entire object
  async getSession(sessionId: string): Promise<Record<string, string> | null> {
    const raw = await this.get(`session:${sessionId}`);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      return null;
    }
  }

  async updateSessionField(sessionId: string, field: string, value: string): Promise<void> {
    // Get entire session, update in app, and write back
    let session: Record<string, string> = {};
    const raw = await this.get(`session:${sessionId}`);
    if (raw) {
      try {
        session = JSON.parse(raw);
      } catch (err) {
        session = {};
      }
    }
    session[field] = value;
    await this.set(`session:${sessionId}`, JSON.stringify(session), 3600); // 1 hour TTL
  }

  // 3. Leaderboard Pattern
  async incrementProductView(productId: string, noLock = false): Promise<void> {
    const lockKey = 'lock:leaderboard';
    const leaderboardKey = 'leaderboard:views';

    if (noLock) {
      // Lock-free / unsafe get-modify-set (to demonstrate race conditions)
      const raw = await this.get(leaderboardKey);
      let list: Array<{ id: string; views: number }> = [];
      if (raw) {
        try {
          list = JSON.parse(raw);
        } catch (err) {
          list = [];
        }
      }
      const item = list.find((x) => x.id === productId);
      if (item) {
        item.views += 1;
      } else {
        list.push({ id: productId, views: 1 });
      }
      list.sort((a, b) => b.views - a.views);
      await this.set(leaderboardKey, JSON.stringify(list), 0);
      return;
    }

    // Lock-protected get-modify-set
    const locked = await this.acquireLock(lockKey);
    if (!locked) {
      throw new Error('Lock acquisition timeout for Memcached leaderboard update');
    }

    try {
      const raw = await this.get(leaderboardKey);
      let list: Array<{ id: string; views: number }> = [];
      if (raw) {
        try {
          list = JSON.parse(raw);
        } catch (err) {
          list = [];
        }
      }
      const item = list.find((x) => x.id === productId);
      if (item) {
        item.views += 1;
      } else {
        list.push({ id: productId, views: 1 });
      }
      list.sort((a, b) => b.views - a.views);
      await this.set(leaderboardKey, JSON.stringify(list), 0);
    } finally {
      await this.del(lockKey);
    }
  }

  async getLeaderboard(): Promise<Array<{ id: string; views: number }>> {
    const raw = await this.get('leaderboard:views');
    if (!raw) {
      return [];
    }
    try {
      const list: Array<{ id: string; views: number }> = JSON.parse(raw);
      // Return top 10
      return list.slice(0, 10);
    } catch (err) {
      return [];
    }
  }

  // 4. Rate Limiter Pattern
  async rateLimit(userId: string, limit: number, windowSeconds: number): Promise<{
    current: number;
    exceeded: boolean;
    ttlRemaining: number;
  }> {
    const key = `rate:limit:${userId}`;
    
    // Attempt standard increment
    try {
      const res = await this.client.increment(key, 1, { initial: 1, expires: windowSeconds });
      // In memjs, client.increment resolves to { value: number }
      if (res && typeof res.value === 'number' && !isNaN(res.value)) {
        const val = res.value;
        return {
          current: val,
          exceeded: val > limit,
          ttlRemaining: windowSeconds,
        };
      }
    } catch (err) {
      // Key does not exist, initialize it safely
    }

    // Try initializing key to "1" with add
    try {
      const success = await this.client.add(key, '1', { expires: windowSeconds });
      if (success) {
        return {
          current: 1,
          exceeded: false,
          ttlRemaining: windowSeconds,
        };
      }
    } catch (err) {
      // Key was added in a parallel request
    }

    // If add failed because the key was just added by another process, run increment again
    try {
      const res = await this.client.increment(key, 1, { initial: 1, expires: windowSeconds });
      if (res && typeof res.value === 'number' && !isNaN(res.value)) {
        const val = res.value;
        return {
          current: val,
          exceeded: val > limit,
          ttlRemaining: windowSeconds,
        };
      }
    } catch (err) {
      // Fallback
    }

    return {
      current: 1,
      exceeded: false,
      ttlRemaining: windowSeconds,
    };
  }
}
