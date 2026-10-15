// Lazily builds the live XRPL merchant when a shared PostgreSQL database is configured.
// Without DATABASE_URL/POSTGRES_URL the endpoint stays in its fail-closed, non-live mode.
import pg from 'pg';
import { PgXrplStore } from '../dist/integrations/xrpl-pg-store.js';
import { XrplMerchant } from '../dist/integrations/xrpl-merchant.js';
import { T54Facilitator } from '../dist/integrations/t54-facilitator.js';

let ready;
export function getXrplMerchant(env = process.env) {
  const url = env.XRPL_DATABASE_URL || env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) return Promise.resolve(null);
  ready ??= (async () => {
    const pool = new pg.Pool({ connectionString: url, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
    const store = new PgXrplStore(pool);
    await store.migrate();
    return new XrplMerchant({ store, facilitator: new T54Facilitator('xrpl:1') });
  })().catch(error => { ready = undefined; console.error('xrpl store init failed', error instanceof Error ? error.message : 'unknown'); return null; });
  return ready;
}
