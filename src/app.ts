import express, { Request, Response } from 'express';
import { dbPool } from './db';
import { getCacheBackend } from './cache/factory';
import { rateLimiterMiddleware } from './middleware/rate-limiter';

const app = express();
app.use(express.json());

// Application level rate limiting middleware applied to all routes
app.use(rateLimiterMiddleware);

// 1. GET /products/:id - Retrieve product metadata
app.get('/products/:id', async (req: Request, res: Response) => {
  const productId = req.params.id;
  const cache = getCacheBackend(req.headers['x-cache-backend']);

  try {
    // Try to retrieve from cache first
    const cachedData = await cache.getProduct(productId);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      res.json(JSON.parse(cachedData));
      return;
    }

    // Cache miss - query PostgreSQL database
    const dbResult = await dbPool.query(
      'SELECT id, name, description, price, sku FROM products WHERE id = $1',
      [productId]
    );

    if (dbResult.rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const product = dbResult.rows[0];
    const productStr = JSON.stringify(product);

    // Cache the retrieved product with 300s TTL
    await cache.cacheProduct(productId, productStr, 300);

    res.setHeader('X-Cache', 'MISS');
    res.json(product);
  } catch (err) {
    console.error(`Error fetching product ${productId}:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 2. POST /products/:id - Update product and invalidate cache
app.post('/products/:id', async (req: Request, res: Response) => {
  const productId = req.params.id;
  const { name, description, price, sku } = req.body;
  const cache = getCacheBackend(req.headers['x-cache-backend']);

  try {
    // Update product in Postgres database
    const dbResult = await dbPool.query(
      `UPDATE products 
       SET name = COALESCE($1, name), 
           description = COALESCE($2, description), 
           price = COALESCE($3, price), 
           sku = COALESCE($4, sku) 
       WHERE id = $5 
       RETURNING id, name, description, price, sku`,
      [name, description, price, sku, productId]
    );

    if (dbResult.rows.length === 0) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const updatedProduct = dbResult.rows[0];

    // Invalidate the cache for this product
    await cache.invalidateProduct(productId);

    res.json({
      message: 'Product updated successfully',
      product: updatedProduct,
    });
  } catch (err) {
    console.error(`Error updating product ${productId}:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 3. POST /products/:id/view - Increment view count for the leaderboard
app.post('/products/:id/view', async (req: Request, res: Response) => {
  const productId = req.params.id;
  const cache = getCacheBackend(req.headers['x-cache-backend']);
  const noLock = req.query.no_lock === 'true';

  try {
    await cache.incrementProductView(productId, noLock);
    res.json({ success: true, message: 'View count incremented' });
  } catch (err) {
    console.error(`Error incrementing view count for product ${productId}:`, err);
    res.status(500).json({ error: 'Internal Server Error', message: (err as Error).message });
  }
});

// 4. GET /leaderboard - Retrieve top 10 most viewed product IDs
app.get('/leaderboard', async (req: Request, res: Response) => {
  const cache = getCacheBackend(req.headers['x-cache-backend']);

  try {
    const leaderboard = await cache.getLeaderboard();
    res.json(leaderboard);
  } catch (err) {
    console.error('Error fetching leaderboard:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 5. GET /session/:id - Retrieve user session details
app.get('/session/:id', async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const cache = getCacheBackend(req.headers['x-cache-backend']);

  try {
    const session = await cache.getSession(sessionId);
    if (!session) {
      res.json({});
      return;
    }
    res.json(session);
  } catch (err) {
    console.error(`Error fetching session ${sessionId}:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// 6. POST /session/:id - Update field in user session
app.post('/session/:id', async (req: Request, res: Response) => {
  const sessionId = req.params.id;
  const { field, value } = req.body;
  const cache = getCacheBackend(req.headers['x-cache-backend']);

  if (!field || value === undefined) {
    res.status(400).json({ error: 'Field name and value are required' });
    return;
  }

  try {
    await cache.updateSessionField(sessionId, field, value);
    const updatedSession = await cache.getSession(sessionId);
    res.json({
      message: 'Session updated successfully',
      session: updatedSession,
    });
  } catch (err) {
    console.error(`Error updating session ${sessionId}:`, err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default app;
