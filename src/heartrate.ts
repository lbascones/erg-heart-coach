import type { Settings } from './settings';

export type Zone = 'nosignal' | 'easy' | 'target' | 'high' | 'over';

/** If no valid heart rate arrives for this long, we say the signal is lost. */
export const SIGNAL_TIMEOUT_MS = 5000;
/** Once over the ceiling, HR must fall this far below it before the alarm clears (stops flicker). */
const CEILING_HYSTERESIS = 3;

/**
 * Turns the raw heart-rate stream into a zone, with two safety rules:
 *  - a stale or missing reading is reported as "nosignal", never as the last known number;
 *  - the "over" alarm latches until HR is clearly back below the ceiling.
 */
export class HeartRateTracker {
  bpm = 0;
  zone: Zone = 'nosignal';
  private lastValidAt = 0;
  private overLatched = false;

  /** During a fitness check the "target" is a narrow band around the test HR. The ceiling never changes. */
  private targetOverride: { low: number; high: number } | null = null;

  constructor(private settings: Settings) {}

  setSettings(s: Settings) {
    this.settings = s;
  }

  setTargetOverride(range: { low: number; high: number } | null) {
    this.targetOverride = range;
  }

  get targetRange(): { low: number; high: number } {
    return this.targetOverride ?? { low: this.settings.targetLow, high: this.settings.targetHigh };
  }

  report(bpm: number, time: number) {
    if (bpm > 0) {
      this.bpm = bpm;
      this.lastValidAt = time;
    }
    this.evaluate(time);
  }

  /** Call regularly so a strap that silently stops sending is noticed. */
  evaluate(now = Date.now()): Zone {
    const s = this.settings;
    if (this.lastValidAt === 0 || now - this.lastValidAt > SIGNAL_TIMEOUT_MS) {
      this.zone = 'nosignal';
      this.overLatched = false;
      return this.zone;
    }
    const hr = this.bpm;
    if (hr >= s.ceiling) this.overLatched = true;
    else if (hr <= s.ceiling - CEILING_HYSTERESIS) this.overLatched = false;

    const t = this.targetRange;
    if (this.overLatched) this.zone = 'over';
    else if (hr > t.high) this.zone = 'high';
    else if (hr >= t.low) this.zone = 'target';
    else this.zone = 'easy';
    return this.zone;
  }

  hasSignal(): boolean {
    return this.zone !== 'nosignal';
  }
}

export const ZONE_LABEL: Record<Zone, string> = {
  nosignal: 'NO HEART RATE',
  easy: 'Easy',
  target: 'In target zone',
  high: 'Above target',
  over: 'TOO HIGH: EASE OFF',
};
