declare module 'memjs' {
  export interface ClientOptions {
    expires?: number;
    failover?: boolean;
    timeout?: number;
    keepAlive?: boolean;
  }

  export class Client {
    static create(servers?: string, options?: ClientOptions): Client;
    get(key: string): Promise<{ value: Buffer | null; flags: Buffer | null }>;
    set(key: string, value: string | Buffer, options?: { expires?: number }): Promise<boolean>;
    add(key: string, value: string | Buffer, options?: { expires?: number }): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    increment(key: string, amount: number, options?: { initial?: number; expires?: number }): Promise<{ value: number }>;
  }
}
