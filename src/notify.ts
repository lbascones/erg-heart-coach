import type { Settings } from './settings';

/**
 * Phone reminders through ntfy (https://ntfy.sh), a free push service with a phone app.
 * You subscribe to a private "topic" name in the app; we post scheduled messages to it.
 *
 * The laptop is usually off between sessions, so reminders are scheduled ahead of time:
 * ntfy holds the message and delivers it at the right moment. ntfy.sh allows up to 3 days ahead.
 *
 * Privacy: the message text goes through the ntfy server. We keep it generic (no name, no health data),
 * and the topic name works like a password, so pick something hard to guess.
 */

const MAX_DELAY_MS = 3 * 86_400_000 - 60_000;
const SCHEDULED_KEY = 'rowing.reminder.scheduledFor';

export function remindersEnabled(s: Settings): boolean {
  return s.ntfyTopic.trim().length > 0;
}

async function post(s: Settings, message: string, at?: number): Promise<void> {
  const url = `${s.ntfyServer.replace(/\/+$/, '')}/${encodeURIComponent(s.ntfyTopic.trim())}`;
  const headers: Record<string, string> = { Title: 'Rowing', Tags: 'rowboat' };
  if (at) headers.At = String(Math.floor(at / 1000));
  const res = await fetch(url, { method: 'POST', body: message, headers });
  if (!res.ok) throw new Error(`ntfy replied ${res.status}`);
}

export async function sendTestNotification(s: Settings): Promise<void> {
  await post(s, 'Test from your rowing display: reminders are working.');
}

/**
 * Schedule a reminder for `day` at the reminder hour, once per day.
 * Silently skips if the time has passed or is too far ahead (it will be scheduled on a later app start).
 */
export async function scheduleReminder(s: Settings, when: Date, message: string): Promise<'scheduled' | 'skipped'> {
  if (!remindersEnabled(s)) return 'skipped';
  const at = when.getTime();
  const now = Date.now();
  if (at - now < 60_000 || at - now > MAX_DELAY_MS) return 'skipped';
  const key = String(at);
  try {
    if (localStorage.getItem(SCHEDULED_KEY) === key) return 'skipped';
  } catch {
    /* ignore */
  }
  await post(s, message, at);
  try {
    localStorage.setItem(SCHEDULED_KEY, key);
  } catch {
    /* ignore */
  }
  return 'scheduled';
}
