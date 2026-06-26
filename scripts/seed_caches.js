const { Pool } = require('pg');
const { createClient } = require('redis');
const { Client: MemcachedClient } = require('memjs');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/catalog';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const memcachedUrl = process.env.MEMCACHED_URL || 'localhost:11211';

async function main() {
  console.log("Starting cache seeding for 100,000 products...");
  
  // 1. Initialize DB pool
  const pool = new Pool({ connectionString: databaseUrl });
  
  // 2. Initialize Redis client
  const redisClient = createClient({ url: redisUrl });
  await redisClient.connect();
  
  // 3. Initialize Memcached client
  const memcachedClient = MemcachedClient.create(memcachedUrl);

  try {
    // Fetch products in chunks to prevent memory issues in node
    console.log("Fetching products from Postgres...");
    const { rows: products } = await pool.query("SELECT id, name, description, price, sku FROM products");
    console.log(`Fetched ${products.length} products. Starting insertions...`);

    const chunkSize = 2000;
    const total = products.length;

    for (let i = 0; i < total; i += chunkSize) {
      const chunk = products.slice(i, i + chunkSize);
      
      const redisPromises = chunk.map(p => 
        redisClient.setEx(`product:${p.id}`, 3600, JSON.stringify(p))
      );
      
      const memcachedPromises = chunk.map(p => 
        memcachedClient.set(`product:v1:${p.id}`, JSON.stringify(p), { expires: 3600 })
      );

      await Promise.all([...redisPromises, ...memcachedPromises]);
      
      if ((i + chunkSize) % 10000 === 0 || i + chunkSize >= total) {
        console.log(`Seeded ${Math.min(i + chunkSize, total)} / ${total} products...`);
      }
    }

    console.log("Caching completed successfully!");
  } catch (err) {
    console.error("Error during cache seeding:", err);
  } finally {
    await pool.end();
    await redisClient.disconnect();
  }
}

main();
