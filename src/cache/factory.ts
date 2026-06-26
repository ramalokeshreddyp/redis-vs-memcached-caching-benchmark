import { ICacheBackend } from './base';
import { RedisCacheBackend } from './redis';
import { MemcachedCacheBackend } from './memcached';
import { config } from '../config';

const redisBackend = new RedisCacheBackend();
const memcachedBackend = new MemcachedCacheBackend();

export function getCacheBackend(backendHeader?: string | string[]): ICacheBackend {
  const headerVal = Array.isArray(backendHeader) ? backendHeader[0] : backendHeader;
  const backendName = (headerVal || config.defaultCacheBackend).trim().toLowerCase();

  if (backendName === 'memcached') {
    return memcachedBackend;
  }
  // Default to Redis
  return redisBackend;
}
