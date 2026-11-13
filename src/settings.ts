/** User settings, kept in the browser's localStorage. */
export interface Settings {
  age: number;
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

export const DEFAULT_SETTINGS: Settings = {
  age: 62,
  ...defaultsForAge(62),
  warmupMinutes: 5,
  cooldownMinutes: 5,
  sound: true,
  ntfyTopic: '',
  ntfyServer: 'https://ntfy.sh',
  reminderHour: 9,
};

export function validate(s: Settings): string | null {
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
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings;
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
