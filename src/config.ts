import dotenv from 'dotenv';
import path from 'path';

// Load env variables
dotenv.config();

export const config = {
  apiPort: parseInt(process.env.API_PORT || '3000', 10),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  memcachedUrl: process.env.MEMCACHED_URL || 'localhost:11211',
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/catalog',
  defaultCacheBackend: process.env.DEFAULT_CACHE_BACKEND || 'redis',
};
