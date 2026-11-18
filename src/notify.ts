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

/** One booking attempt, kept for the diagnostics file if all attempts fail. */
export interface BookingAttempt {
  at: string;
  online: boolean;
  error: string;
}

export type BookingResult =
  | { status: 'scheduled' | 'skipped' | 'superseded' }
  | { status: 'failed'; attempts: BookingAttempt[] };

/** Waits before each retry: 30 s, then 1 min (the laptop is often shut down a few minutes after a session). */
const RETRY_DELAYS_MS = [30_000, 60_000];

/** Bumped on every new booking, so an older booking still retrying stops quietly. */
let generation = 0;

/**
 * Schedule a reminder at `when`, once per target time, retrying twice if ntfy can't be reached.
 * Skips if the time has passed or is too far ahead (it will be scheduled on a later app start).
 */
export async function scheduleReminder(s: Settings, when: Date, message: string): Promise<BookingResult> {
  if (!remindersEnabled(s)) return { status: 'skipped' };
  const at = when.getTime();
  const tooSoonOrFar = () => at - Date.now() < 60_000 || at - Date.now() > MAX_DELAY_MS;
  if (tooSoonOrFar()) return { status: 'skipped' };
  const key = String(at);
  try {
    if (localStorage.getItem(SCHEDULED_KEY) === key) return { status: 'skipped' };
  } catch {
    /* ignore */
  }
  const mine = ++generation;
  const attempts: BookingAttempt[] = [];
  for (let i = 0; ; i++) {
    try {
      await post(s, message, at);
      try {
        localStorage.setItem(SCHEDULED_KEY, key);
      } catch {
        /* ignore */
      }
      return { status: 'scheduled' };
    } catch (err) {
      attempts.push({ at: new Date().toISOString(), online: navigator.onLine, error: String(err) });
    }
    if (i >= RETRY_DELAYS_MS.length) return { status: 'failed', attempts };
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    if (mine !== generation) return { status: 'superseded' };
    if (tooSoonOrFar()) return { status: 'skipped' };
  }
}
