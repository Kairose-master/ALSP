// Central run log: every agent run, measurement and exported archive from the deployment in one place.
// Storage is Vercel Blob when BLOB_READ_WRITE_TOKEN is set (connect a Blob store to the project), else a
// local directory for `npm run demo`. Entries are JSON; the listing is derived from blob pathnames so it
// needs no index file. Nothing here is secret: exports never contain bearer signatures.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const KINDS = ['agent-run', 'measurement', 'session', 'mission', 'note'];
const PREFIX = 'alsp-logs/';
const MAX_BYTES = 1024 * 1024;
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'untitled';

function backend() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob';
  if (!process.env.VERCEL) return 'file';
  return null;
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
    const r = await put(`${PREFIX}${id}.json`, body, { access: 'public', contentType: 'application/json', addRandomSuffix: false });
    return { id, url: r.url, backend: b };
  }
  if (b === 'file') {
    await mkdir(localDir(), { recursive: true });
    await writeFile(join(localDir(), `${id}.json`), body);
    return { id, url: `/api/logs/${id}`, backend: b };
  }
  throw new Error('Logs are not configured on this deployment (connect a Vercel Blob store or set BLOB_READ_WRITE_TOKEN)');
}

export async function listLogs(limit = 100) {
  const b = backend(), out = [];
  if (b === 'blob') {
    const { list } = await import('@vercel/blob');
    let cursor;
    do {
      const page = await list({ prefix: PREFIX, limit: 1000, cursor });
      for (const blob of page.blobs) { const meta = parsePath(blob.pathname); if (meta) out.push({ ...meta, size: blob.size, url: blob.url }); }
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
    const { list } = await import('@vercel/blob');
    const page = await list({ prefix: `${PREFIX}${id}.json`, limit: 1 });
    const blob = page.blobs[0];
    if (!blob) throw new Error('Log not found');
    const r = await fetch(blob.url, { cache: 'no-store' });
    if (!r.ok) throw new Error('Log fetch failed');
    return JSON.parse(await r.text());
  }
  if (b === 'file') return JSON.parse(await readFile(join(localDir(), `${id}.json`), 'utf8'));
  throw new Error('Logs are not configured on this deployment');
}
