// Production server for the laptop: serves the built app (dist/) and saves backups to disk.
// Run with:  npm run build && npm start      (then open http://localhost:4173)
//
// Listens on the home network too, so the iPad can open the stretching page (http://<laptop>.local:4173/mobility).
// Other devices get only the app's files and the stretching progress; backups and diagnostics stay laptop-only,
// and anything outside the home network (public addresses) is refused.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, hostname } from 'node:os';
import { backupDir, handleBackup } from './server/backup.js';
import { handleMobility } from './server/mobility.js';

const PORT = Number(process.env.PORT || 4173);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

/** The laptop itself. */
function isLocal(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Private home-network addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x, IPv6 link-local / unique-local). */
function isHomeNetwork(addr) {
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (/^(10|127)\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4) || /^169\.254\./.test(v4)) return true;
  return /^(fe80|fc|fd)/i.test(addr) || addr === '::1';
}

const server = createServer(async (req, res) => {
  const addr = req.socket.remoteAddress || '';
  if (!isHomeNetwork(addr)) {
    res.writeHead(403).end();
    return;
  }
  if (await handleMobility(req, res)) return;
  // Backups and diagnostics: only the app running on the laptop.
  if (isLocal(addr) && (await handleBackup(req, res))) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // Static files from dist/, never outside it.
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/') path = '/index.html';
  if (path === '/mobility' || path === '/mobility/') path = '/mobility.html';
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': path.startsWith('/assets/') ? 'max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Rowing display: http://localhost:${PORT}`);
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && /^(192\.168|10)\./.test(i.address));
  console.log(`Stretching page for the iPad: http://${hostname().toLowerCase()}.local:${PORT}/mobility` +
    (ips.length ? ` (or ${ips.map((i) => `http://${i.address}:${PORT}/mobility`).join(', ')})` : ''));
  console.log(`Backups folder: ${backupDir}`);
});
