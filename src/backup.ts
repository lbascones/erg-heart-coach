/**
 * Backups of everything the app stores (settings, trainer state, session history).
 *  - Manual: Export / Import buttons on the progress screen (a JSON file).
 *  - Automatic: after each session the app sends the same JSON to the local server, which writes it to
 *    ~/rowing-backups on the laptop (and rclone copies that folder to Google Drive).
 */

const STORAGE_KEYS = ['rowing.settings.v1', 'rowing.trainer.v1', 'rowing.history.v1'] as const;
const LAST_BACKUP_KEY = 'rowing.lastBackupAt';

export interface BackupData {
  app: 'rowing-display';
  version: 1;
  exportedAt: string;
  [key: string]: unknown;
}

export function buildBackup(): BackupData {
  const data: BackupData = { app: 'rowing-display', version: 1, exportedAt: new Date().toISOString() };
  for (const k of STORAGE_KEYS) {
    try {
      data[k] = JSON.parse(localStorage.getItem(k) ?? 'null');
    } catch {
      data[k] = null;
    }
  }
  return data;
}

export function sessionCount(data: BackupData): number {
  const h = data['rowing.history.v1'];
  return Array.isArray(h) ? h.length : 0;
}

/** Replaces everything stored in this browser with the backup. Caller should reload the page afterwards. */
export function applyBackup(data: unknown): void {
  const d = data as BackupData;
  if (d?.app !== 'rowing-display') throw new Error('This is not a rowing-display backup file.');
  for (const k of STORAGE_KEYS) {
    if (d[k] !== null && d[k] !== undefined) localStorage.setItem(k, JSON.stringify(d[k]));
  }
}

export function downloadBackup(): void {
  const blob = new Blob([JSON.stringify(buildBackup(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rowing-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Sends a backup to the local server. Returns false (without throwing) if there is no server,
 * e.g. when the app is opened some other way; manual export still works then.
 */
export async function pushBackup(): Promise<boolean> {
  try {
    const res = await fetch('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBackup()),
    });
    if (!res.ok) throw new Error(`server replied ${res.status}`);
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
    return true;
  } catch (err) {
    console.warn('Automatic backup failed', err);
    return false;
  }
}

export function lastBackupAt(): Date | null {
  try {
    const v = localStorage.getItem(LAST_BACKUP_KEY);
    return v ? new Date(v) : null;
  } catch {
    return null;
  }
}

/** The newest backup saved on the laptop, or null if there is none / no server. */
export async function fetchServerBackup(): Promise<BackupData | null> {
  try {
    const res = await fetch('/api/backup/latest', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.app === 'rowing-display' ? data : null;
  } catch {
    return null;
  }
}
