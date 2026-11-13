// Production server for the laptop: serves the built app (dist/) and saves backups to disk.
// Run with:  npm run build && npm start      (then open http://localhost:4173)
//
// Listens on 127.0.0.1 only, so nothing else on the network can reach it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupDir, handleBackup } from './server/backup.js';

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

const server = createServer(async (req, res) => {
  if (await handleBackup(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // Static files from dist/, never outside it.
  let path = decodeURIComponent((req.url || '/').split('?')[0]);
  if (path === '/') path = '/index.html';
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Rowing display: http://localhost:${PORT}`);
  console.log(`Backups folder: ${backupDir}`);
});
