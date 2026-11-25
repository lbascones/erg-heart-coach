// Stretching (mobility) progress, kept on the laptop so the laptop and the iPad share one record.
//
//   GET  /api/mobility   -> { completed: [...], kneeWall: [...] }  (empty lists if nothing saved yet)
//   POST /api/mobility   body = { app: 'rowing-mobility', completed, kneeWall } -> merged with what is saved,
//                        written to mobility.json in the backups folder; replies with the merged record.
//
// Merging only ever adds: a routine or measurement saved on either screen is never lost.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupDir, runAfterBackup } from './backup.js';

const FILE = join(backupDir, 'mobility.json');
const MAX_BYTES = 1024 * 1024;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const dayOf = (t) => new Date(t).toDateString();

/** Union of both records: one counted routine per day (the earliest), one measurement per timestamp. */
export function mergeMobility(a, b) {
  const byDay = new Map();
  for (const t of [...(a?.completed ?? []), ...(b?.completed ?? [])]) {
    if (!num(t)) continue;
    const d = dayOf(t);
    if (!byDay.has(d) || t < byDay.get(d)) byDay.set(d, t);
  }
  const byTime = new Map();
  for (const m of [...(a?.kneeWall ?? []), ...(b?.kneeWall ?? [])]) {
    if (m && num(m.t) && num(m.left) && num(m.right)) byTime.set(m.t, { t: m.t, left: m.left, right: m.right });
  }
  return {
    completed: [...byDay.values()].sort((x, y) => x - y),
    kneeWall: [...byTime.values()].sort((x, y) => x.t - y.t),
  };
}

async function load() {
  try {
    return mergeMobility(JSON.parse(await readFile(FILE, 'utf8')), null);
  } catch {
    return { completed: [], kneeWall: [] };
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error('Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Same rule as the backups: only the app's own pages may write (blocks other websites in the browser). */
function fromApp(req) {
  const origin = req.headers.origin;
  return (!origin || origin === `http://${req.headers.host}`) && (req.headers['content-type'] || '').startsWith('application/json');
}

/** Returns true if it handled the request. */
export async function handleMobility(req, res) {
  const url = (req.url || '').split('?')[0];
  if (url !== '/api/mobility') return false;
  if (req.method === 'GET') {
    send(res, 200, await load());
    return true;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Method not allowed' });
    return true;
  }
  if (!fromApp(req)) {
    send(res, 403, { error: 'Forbidden' });
    return true;
  }
  try {
    const data = JSON.parse(await readBody(req));
    if (data?.app !== 'rowing-mobility') return send(res, 400, { error: 'Not mobility progress' }), true;
    const saved = await load();
    const merged = mergeMobility(saved, data);
    if (JSON.stringify(merged) !== JSON.stringify(saved)) {
      await mkdir(backupDir, { recursive: true });
      await writeFile(`${FILE}.tmp`, JSON.stringify(merged, null, 1), 'utf8');
      await rename(`${FILE}.tmp`, FILE);
      runAfterBackup();
    }
    send(res, 200, merged);
  } catch (err) {
    console.error('[mobility] failed:', err);
    send(res, 500, { error: String(err.message || err) });
  }
  return true;
}
