import { Pool } from 'pg';
import { config } from './config';

export const dbPool = new Pool({
  connectionString: config.databaseUrl,
});

dbPool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});
