// Lazily builds the live XRPL merchant when a shared PostgreSQL database is configured.
// Without a database URL the endpoint stays in its fail-closed, non-live mode.
// Network: production defaults to XRPL mainnet (xrpl:0), previews to testnet (xrpl:1); XRPL_NETWORK overrides.
import pg from 'pg';
import { PgXrplStore, XrplMerchant, T54Facilitator, merchantConfigFromEnv } from '../dist/xrpl-runtime.bundle.mjs';

let ready;
export function getXrplMerchant(env = process.env) {
  const url = env.XRPL_DATABASE_URL || env.DATABASE_URL || env.POSTGRES_URL;
  if (!url) return Promise.resolve(null);
  ready ??= (async () => {
    const config = merchantConfigFromEnv(env);
    const pool = new pg.Pool({ connectionString: url, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 });
    const store = new PgXrplStore(pool);
    await store.migrate();
    const facilitator = new T54Facilitator(config.network, fetch, { allowMainnetSettle: config.network === 'xrpl:0' });
    return new XrplMerchant({ store, facilitator, config, activationSale: env.XRPL_ACTIVATION_SALE !== '0' });
  })().catch(error => { ready = undefined; console.error('xrpl store init failed', error instanceof Error ? error.message : 'unknown'); return null; });
  return ready;
}
