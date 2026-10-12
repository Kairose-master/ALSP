// Central run log: every agent run, measurement and exported archive from the deployment in one place.
// Storage is Vercel Blob when BLOB_READ_WRITE_TOKEN or BLOB_STORE_ID is set (connect a Blob store to the project), else a
// local directory for `npm run demo`. Entries are JSON; the listing is derived from blob pathnames so it
// needs no index file. Nothing here is secret: exports never contain bearer signatures.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const KINDS = ['agent-run', 'measurement', 'session', 'mission', 'note'];
const PREFIX = 'alsp-logs/';
const MAX_BYTES = 1024 * 1024;
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';

// Blob credentials come from either a read-write token or, for stores connected through the Vercel
// dashboard, BLOB_STORE_ID plus the OIDC token Vercel injects into functions (the SDK handles that).
const hasBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
function backend() {
  if (hasBlob()) return 'blob';
  if (!process.env.VERCEL) return 'file';
  return null;
}
// A store is either public or private and the SDK rejects the wrong one, so learn it once per instance.
let blobAccess = process.env.ALSP_LOG_ACCESS === 'private' ? 'private' : 'public';
const other = a => (a === 'public' ? 'private' : 'public');
const isAccessError = err => err && (err.name === 'BlobAccessError' || /access/i.test(String(err.message)));
async function withAccess(fn) {
  try { return await fn(blobAccess); }
  catch (err) {
    if (!isAccessError(err)) throw err;
    const result = await fn(other(blobAccess)); // throws if that is wrong too
    blobAccess = other(blobAccess);
    return result;
  }
}
const localDir = () => process.env.ALSP_LOG_DIR || 'data/logs';
export function logsEnabled() { return backend() !== null; }
export function logsBackend() { return backend() ?? 'none'; }

function parsePath(pathname) {
  const m = new RegExp(`^(?:alsp-logs/)?(\\d{13})-(${KINDS.join('|')})-(.+)-([0-9a-f]{8})\\.json$`).exec(pathname);
  if (!m) return null;
  return { id: `${m[1]}-${m[2]}-${m[3]}-${m[4]}`, at: Number(m[1]), kind: m[2], title: m[3].replace(/-/g, ' ') };
}

export async function putLog(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Log entry must be an object');
  if (!KINDS.includes(entry.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const title = String(entry.title ?? '').slice(0, 120);
  const body = JSON.stringify({ kind: entry.kind, title, at: Date.now(), origin: typeof entry.origin === 'string' ? entry.origin.slice(0, 200) : null, summary: entry.summary ?? null, payload: entry.payload ?? null });
  if (body.length > MAX_BYTES) throw new Error('Log entry too large (1 MB max)');
  const id = `${Date.now()}-${entry.kind}-${slug(title)}-${randomUUID().slice(0, 8)}`;
  const b = backend();
  if (b === 'blob') {
    const { put } = await import('@vercel/blob');
    const r = await withAccess(access => put(`${PREFIX}${id}.json`, body, { access, contentType: 'application/json', addRandomSuffix: false }));
    return { id, url: blobAccess === 'public' ? r.url : `/api/logs/${id}`, backend: b, access: blobAccess };
  }
  if (b === 'file') {
    await mkdir(localDir(), { recursive: true });
    await writeFile(join(localDir(), `${id}.json`), body);
    return { id, url: `/api/logs/${id}`, backend: b };
  }
  throw new Error('Logs are not configured on this deployment (connect a Vercel Blob store: BLOB_STORE_ID or BLOB_READ_WRITE_TOKEN)');
}

export async function listLogs(limit = 100) {
  const b = backend(), out = [];
  if (b === 'blob') {
    const { list } = await import('@vercel/blob');
    let cursor;
    do {
      const page = await list({ prefix: PREFIX, limit: 1000, cursor });
      for (const blob of page.blobs) { const meta = parsePath(blob.pathname); if (meta) out.push({ ...meta, size: blob.size, url: `/api/logs/${meta.id}` }); }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor && out.length < 5000);
  } else if (b === 'file') {
    try {
      for (const name of await readdir(localDir())) { const meta = parsePath(name); if (meta) out.push({ ...meta, size: (await stat(join(localDir(), name))).size, url: `/api/logs/${meta.id}` }); }
    } catch { /* no logs yet */ }
  }
  out.sort((x, y) => y.at - x.at);
  return { enabled: b !== null, backend: b ?? 'none', entries: out.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))) };
}

export async function getLog(id) {
  if (!new RegExp(`^\\d{13}-(${KINDS.join('|')})-[a-z0-9-]+-[0-9a-f]{8}$`).test(String(id))) throw new Error('Invalid log id');
  const b = backend();
  if (b === 'blob') {
    const { get } = await import('@vercel/blob');
    const result = await withAccess(access => get(`${PREFIX}${id}.json`, { access, useCache: false }));
    if (!result || result.statusCode === 404 || !result.stream) throw new Error('Log not found');
    return JSON.parse(await new Response(result.stream).text());
  }
  if (b === 'file') return JSON.parse(await readFile(join(localDir(), `${id}.json`), 'utf8'));
  throw new Error('Logs are not configured on this deployment');
}
