/** User settings, kept in the browser's localStorage. */
export interface Settings {
  /** YYYY-MM-DD, or '' until entered. Age is worked out from it, so it never goes stale. */
  birthDate: string;
  /**
   * The age the heart-rate limits were estimated for, so they can follow your birthdays.
   * null = limits entered by hand (e.g. from a doctor): those are never changed automatically.
   */
  limitsFromAge: number | null;
  maxHr: number;
  /** Bottom of the target heart-rate zone (bpm). */
  targetLow: number;
  /** Top of the target heart-rate zone (bpm). */
  targetHigh: number;
  /** Never go above this (bpm). Triggers the loud alarm. */
  ceiling: number;
  warmupMinutes: number;
  cooldownMinutes: number;
  sound: boolean;
  /** ntfy topic for phone reminders; empty = reminders off. */
  ntfyTopic: string;
  ntfyServer: string;
  /** Hour of day (0-23) to send the reminder on rowing days. */
  reminderHour: number;
}

const KEY = 'rowing.settings.v1';

/** Tanaka formula, a common estimate. Only a starting point: real limits should come from a doctor. */
export function estimateMaxHr(age: number): number {
  return Math.round(208 - 0.7 * age);
}

/** Conservative beginner defaults: target 60-70% of estimated max, hard ceiling at 80%. */
export function defaultsForAge(age: number): Pick<Settings, 'maxHr' | 'targetLow' | 'targetHigh' | 'ceiling'> {
  const maxHr = estimateMaxHr(age);
  return {
    maxHr,
    targetLow: Math.round(maxHr * 0.6),
    targetHigh: Math.round(maxHr * 0.7),
    ceiling: Math.round(maxHr * 0.8),
  };
}

/** Age in whole years on the given day, or null if the birth date is missing or invalid. */
export function ageOn(birthDate: string, now: Date = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const born = new Date(y, mo - 1, d);
  if (born.getMonth() !== mo - 1 || born.getDate() !== d) return null; // e.g. 1962-02-30
  let age = now.getFullYear() - y;
  const month = now.getMonth() + 1;
  if (month < mo || (month === mo && now.getDate() < d)) age--; // birthday not reached yet this year
  return age;
}

/** True if the heart-rate limits are exactly the estimates for this age. */
export function limitsMatchAge(s: Pick<Settings, 'maxHr' | 'targetLow' | 'targetHigh' | 'ceiling'>, age: number): boolean {
  const d = defaultsForAge(age);
  return s.maxHr === d.maxHr && s.targetLow === d.targetLow && s.targetHigh === d.targetHigh && s.ceiling === d.ceiling;
}

/** Records whether the limits being saved are age estimates (kept in step with birthdays) or hand-entered. */
export function withLimitsSource(s: Settings, now: Date = new Date()): Settings {
  const age = ageOn(s.birthDate, now);
  return { ...s, limitsFromAge: age !== null && limitsMatchAge(s, age) ? age : null };
}

/**
 * After a birthday, moves age-estimated limits to the new age's estimates.
 * Returns the updated settings, or null when nothing changes (no birth date, hand-entered limits, same age).
 */
export function refreshAgeLimits(s: Settings, now: Date = new Date()): Settings | null {
  const age = ageOn(s.birthDate, now);
  if (age === null || s.limitsFromAge === null || s.limitsFromAge === age) return null;
  return { ...s, ...defaultsForAge(age), limitsFromAge: age };
}

export const DEFAULT_SETTINGS: Settings = {
  birthDate: '',
  limitsFromAge: 62,
  ...defaultsForAge(62),
  warmupMinutes: 5,
  cooldownMinutes: 5,
  sound: true,
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  reminderHour: 9,
};

export function validate(s: Settings): string | null {
  if (s.birthDate) {
    const age = ageOn(s.birthDate);
    if (age === null || age < 10 || age > 110) return 'Please check the birth date.';
  }
  if (!(s.targetLow > 40)) return 'Target low must be above 40 bpm.';
  if (!(s.targetLow < s.targetHigh)) return 'Target low must be below target high.';
  if (!(s.targetHigh <= s.ceiling)) return 'Target high must not be above the ceiling.';
  if (!(s.ceiling <= s.maxHr)) return 'Ceiling must not be above max heart rate.';
  if (!(s.warmupMinutes >= 0 && s.cooldownMinutes >= 0)) return 'Warm-up and cool-down cannot be negative.';
  if (!(s.reminderHour >= 0 && s.reminderHour <= 23)) return 'Reminder hour must be 0–23.';
  if (s.ntfyTopic && !/^[\w-]{1,64}$/.test(s.ntfyTopic)) return 'Reminder topic: letters, numbers, - and _ only.';
  if (s.ntfyTopic && !/^https?:\/\//.test(s.ntfyServer)) return 'Reminder server must start with https://';
  return null;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const stored = JSON.parse(raw);
      // Older versions stored an age instead of a birth date: keep the limits, ask for the date in Settings.
      if (typeof stored.age === 'number' && stored.limitsFromAge === undefined) {
        stored.limitsFromAge = limitsMatchAge(stored, stored.age) ? stored.age : null;
      }
      delete stored.age;
      const s = { ...DEFAULT_SETTINGS, ...stored } as Settings;
      if (!validate(s)) return s;
    }
  } catch {
    /* fall through to defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (err) {
    console.error('Could not save settings', err);
  }
}

/** True until the user has saved their own settings at least once. */
export function settingsAreDefaults(): boolean {
  try {
    return localStorage.getItem(KEY) === null;
  } catch {
    return true;
  }
}
