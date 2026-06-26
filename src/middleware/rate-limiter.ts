import { Request, Response, NextFunction } from 'express';
import { getCacheBackend } from '../cache/factory';

export async function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction) {
  // Extract user identifier
  const userId = (req.headers['x-user-id'] as string) || (req.query.userId as string) || req.ip || 'anonymous';
  
  // Get selected cache backend
  const backendHeader = req.headers['x-cache-backend'];
  const cache = getCacheBackend(backendHeader);

  try {
    const limit = 100;
    const windowSeconds = 60;
    const result = await cache.rateLimit(userId, limit, windowSeconds);

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - result.current));
    res.setHeader('X-RateLimit-Reset', result.ttlRemaining);

    if (result.exceeded) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Please try again in ${result.ttlRemaining} seconds.`,
      });
      return;
    }

    next();
  } catch (err) {
    console.error('Rate limiter middleware error:', err);
    // Fail-open for safety in production, but let's log it
    next();
  }
}
