// Local harness: serves api/index.js on a port (reads DATABASE_URL). For E2E/debugging only.
import http from 'node:http';
import handler from '../api/index.js';
const port = Number(process.env.PORT || 3987);
http.createServer(async (req, rawRes) => {
  const res = Object.assign(rawRes, {
    status(c) { this.statusCode = c; return this; },
    json(v) { this.setHeader('content-type', 'application/json'); this.end(JSON.stringify(v)); return this; },
    send(v) { this.end(v); return this; },
  });
  try { await handler(req, res); } catch (e) { console.error(e); res.statusCode = 500; res.end('error'); }
}).listen(port, () => console.log('listening', port));
