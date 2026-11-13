// Backup endpoint shared by the production server (server.js) and the Vite dev server (vite.config.js).
//
//   POST /api/backup         body = backup JSON from the app -> writes rowing-latest.json + rowing-YYYY-MM-DD.json
//   GET  /api/backup/latest  -> returns rowing-latest.json (404 if none), used to restore a wiped browser
//   POST /api/diagnostics    body = diagnostics recording -> writes diagnostics/diag-YYYY-MM-DD-HHMMSS.json
//
// Files go to $ROWING_BACKUP_DIR (default ~/rowing-backups). File names are chosen here, never by the client.
// If $ROWING_AFTER_BACKUP is set (e.g. an rclone command), it runs after each successful write.

import { exec } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 40 * 1024 * 1024;

export const backupDir = process.env.ROWING_BACKUP_DIR || join(homedir(), 'rowing-backups');

const pad = (n) => String(n).padStart(2, '0');

function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d = new Date()) {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Only the app itself may write: block requests from other websites open in the same browser.
 * Browsers always send Origin on cross-site POSTs, and requiring JSON forces a CORS preflight we never allow.
 */
function fromApp(req) {
  const origin = req.headers.origin;
  const contentType = req.headers['content-type'] || '';
  return (!origin || origin === `http://${req.headers.host}`) && contentType.startsWith('application/json');
}

/** Write via a temp file + rename, so a power cut never leaves a half-written backup. */
async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error('Backup too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

let afterBackupRunning = false;
function runAfterBackup() {
  const cmd = process.env.ROWING_AFTER_BACKUP;
  if (!cmd || afterBackupRunning) return;
  afterBackupRunning = true;
  exec(cmd, { timeout: 5 * 60_000 }, (err, _stdout, stderr) => {
    afterBackupRunning = false;
    if (err) console.error('[backup] after-backup command failed:', stderr || err.message);
    else console.log('[backup] after-backup command finished');
  });
}

/** Returns true if it handled the request. */
export async function handleBackup(req, res) {
  const url = (req.url || '').split('?')[0];
  if (url === '/api/backup' && req.method === 'POST') {
    if (!fromApp(req)) {
      send(res, 403, { error: 'Forbidden' });
      return true;
    }
    try {
      const text = await readBody(req);
      const data = JSON.parse(text);
      if (data?.app !== 'rowing-display') return send(res, 400, { error: 'Not a rowing-display backup' }), true;
      await mkdir(backupDir, { recursive: true });
      const pretty = JSON.stringify(data, null, 1);
      await writeAtomic(join(backupDir, 'rowing-latest.json'), pretty);
      await writeAtomic(join(backupDir, `rowing-${localDate()}.json`), pretty);
      send(res, 200, { ok: true, savedAt: new Date().toISOString(), dir: backupDir });
      runAfterBackup();
    } catch (err) {
      console.error('[backup] failed:', err);
      send(res, 500, { error: String(err.message || err) });
    }
    return true;
  }
  if (url === '/api/diagnostics' && req.method === 'POST') {
    if (!fromApp(req)) {
      send(res, 403, { error: 'Forbidden' });
      return true;
    }
    try {
      const data = JSON.parse(await readBody(req));
      if (data?.app !== 'erg-heart-coach-diagnostics') return send(res, 400, { error: 'Not a diagnostics file' }), true;
      const dir = join(backupDir, 'diagnostics');
      await mkdir(dir, { recursive: true });
      const now = new Date();
      const file = `diag-${localDate(now)}-${localTime(now)}.json`;
      await writeAtomic(join(dir, file), JSON.stringify(data));
      send(res, 200, { ok: true, file, dir });
      runAfterBackup();
    } catch (err) {
      console.error('[diagnostics] failed:', err);
      send(res, 500, { error: String(err.message || err) });
    }
    return true;
  }
  if (url === '/api/backup/latest' && req.method === 'GET') {
    try {
      send(res, 200, await readFile(join(backupDir, 'rowing-latest.json'), 'utf8'));
    } catch {
      send(res, 404, { error: 'No backup yet' });
    }
    return true;
  }
  return false;
}
