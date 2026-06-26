export interface ICacheBackend {
  // Generic key-value operations
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  
  // Specific pattern implementations
  
  // 1. Invalidation Pattern
  getProduct(productId: string): Promise<string | null>;
  cacheProduct(productId: string, productData: string, ttlSeconds: number): Promise<void>;
  invalidateProduct(productId: string): Promise<void>;
  
  // 2. Session Pattern
  getSession(sessionId: string): Promise<Record<string, string> | null>;
  updateSessionField(sessionId: string, field: string, value: string): Promise<void>;
  
  // 3. Leaderboard Pattern
  incrementProductView(productId: string, noLock?: boolean): Promise<void>;
  getLeaderboard(): Promise<Array<{ id: string; views: number }>>;
  
  // 4. Rate Limiter Pattern
  rateLimit(userId: string, limit: number, windowSeconds: number): Promise<{
    current: number;
    exceeded: boolean;
    ttlRemaining: number;
  }>;
}
