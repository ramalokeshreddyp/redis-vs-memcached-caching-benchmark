import app from './app';
import { config } from './config';
import { createClient } from 'redis';

const PORT = config.apiPort;

const server = app.listen(PORT, () => {
  console.log(`Product Catalog API proxy running on port ${PORT}`);
  console.log(`Database target: ${config.databaseUrl}`);
  console.log(`Default cache provider: ${config.defaultCacheBackend}`);
});

// Setup a subscriber client to showcase the Redis invalidation Pub/Sub pattern
(async () => {
  try {
    const subscriber = createClient({ url: config.redisUrl });
    subscriber.on('error', (err) => {
      // Keep quiet if connection fails initially during setup or build phases
    });
    await subscriber.connect();
    console.log('Redis Subscriber connected to handle invalidations.');
    await subscriber.subscribe('product:invalidations', (productId) => {
      console.log(`[Cache Invalidation Broadcast] Redis notified instance: Product ID ${productId} has been invalidated.`);
    });
  } catch (err) {
    console.log('Redis Invalidation Subscriber not listening (will connect once container starts).');
  }
})();
