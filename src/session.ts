import type { Zone } from './heartrate';
import type { Settings } from './settings';
import type { RowerSample } from './sources/source';
import type { SessionPlan, SessionType } from './trainer';

export type Phase = 'idle' | 'warmup' | 'main' | 'cooldown' | 'recovery' | 'done';

/** How long to sit still after finishing while we measure heart-rate recovery. */
export const RECOVERY_SECONDS = 60;
/** Fitness check: only the last part of the main phase is scored, once HR has settled. */
const CHECK_SCORED_SECONDS = 5 * 60;
/** Fitness check: HR samples further than this from the test HR are ignored. */
const CHECK_HR_TOLERANCE = 5;

export interface SessionSummary {
  id: string;
  startedAt: number;
  type: SessionType;
  level: number;
  durationSec: number;
  distance: number;
  calories: number;
  avgHr: number;
  maxHr: number;
  avgPower: number;
  zoneSeconds: Record<Zone, number>;
  /** Main-phase time actually rowed vs. planned (planned = 0 for free rows). */
  mainSec: number;
  plannedMainSec: number;
  /** Average watts while in the target zone during the main phase: rises as you get fitter. */
  targetWatts: number;
  /** Fitness check only: heart rate held and average watts at it. */
  testHr?: number;
  checkWatts?: number;
  /** HR when you stopped rowing, and 60 s later. The drop is a good fitness indicator. */
  hrAtStop: number;
  hrAfterRecovery: number;
  /** Heart rate every 5 s, for charts and future comparisons. */
  hrTrace: number[];
  settingsUsed: Pick<Settings, 'targetLow' | 'targetHigh' | 'ceiling' | 'maxHr'>;
  /** Filled in from the after-session questions. */
  rpe?: number;
  symptoms?: boolean;
}

const HISTORY_KEY = 'rowing.history.v1';
const HISTORY_LIMIT = 1000;

function emptyZones(): Record<Zone, number> {
  return { nosignal: 0, easy: 0, target: 0, high: 0, over: 0 };
}

/** Weighted average; when weights are seconds, `n` is the total time covered. */
class Averager {
  sum = 0;
  n = 0;
  add(v: number, weight = 1) {
    this.sum += v * weight;
    this.n += weight;
  }
  get value() {
    return this.n ? Math.round(this.sum / this.n) : 0;
  }
}

export class Session {
  phase: Phase = 'idle';
  phaseStartedAt = 0;
  startedAt = 0;
  plan: SessionPlan = { type: 'free', mainMinutes: null, level: 1 };

  distance = 0;
  calories = 0;
  zoneSeconds = emptyZones();
  maxHr = 0;
  mainSec = 0;
  private hr = new Averager();
  private power = new Averager();
  private targetPower = new Averager();
  private checkPower = new Averager();
  private lastPower = 0;
  private hrTrace: number[] = [];
  private lastTraceAt = 0;
  private lastTickAt = 0;
  private lastDistance: number | null = null;
  private lastCalories: number | null = null;
  private hrAtStop = 0;
  private lastHr = 0;

  constructor(private settings: Settings) {}

  setSettings(s: Settings) {
    this.settings = s;
  }

  get rowingPhase(): boolean {
    return this.phase === 'warmup' || this.phase === 'main' || this.phase === 'cooldown';
  }

  /** Seconds left in a timed phase, or elapsed seconds for an open-ended phase. */
  phaseClock(now = Date.now()): { seconds: number; countdown: boolean } {
    const inPhase = (now - this.phaseStartedAt) / 1000;
    const length = this.phaseLength();
    if (length === null) return { seconds: inPhase, countdown: false };
    return { seconds: Math.max(0, length - inPhase), countdown: true };
  }

  private phaseLength(): number | null {
    if (this.phase === 'warmup') return this.settings.warmupMinutes * 60;
    if (this.phase === 'main' && this.plan.mainMinutes !== null) return this.plan.mainMinutes * 60;
    if (this.phase === 'cooldown') return this.settings.cooldownMinutes * 60;
    if (this.phase === 'recovery') return RECOVERY_SECONDS;
    return null;
  }

  start(plan: SessionPlan, now = Date.now()) {
    const settings = this.settings;
    Object.assign(this, new Session(settings));
    this.plan = plan;
    this.startedAt = now;
    this.lastTickAt = now;
    this.setPhase(settings.warmupMinutes > 0 ? 'warmup' : 'main', now);
  }

  skipWarmup(now = Date.now()) {
    if (this.phase === 'warmup') this.setPhase('main', now);
  }

  beginCooldown(now = Date.now()) {
    if (this.phase === 'warmup' || this.phase === 'main') {
      this.setPhase(this.settings.cooldownMinutes > 0 ? 'cooldown' : 'recovery', now);
    }
  }

  finish(now = Date.now()) {
    if (this.rowingPhase) this.setPhase('recovery', now);
    else if (this.phase === 'recovery') this.setPhase('done', now);
  }

  reset() {
    this.phase = 'idle';
  }

  private setPhase(p: Phase, now: number) {
    if (p === 'recovery') this.hrAtStop = this.lastHr;
    this.phase = p;
    this.phaseStartedAt = now;
  }

  onSample(s: RowerSample) {
    if (!this.rowingPhase) return;
    // The PM's counters reset when a new workout starts on it, so add up the increases ourselves.
    this.distance += delta(this.lastDistance, s.distance);
    this.calories += delta(this.lastCalories, s.calories);
    this.lastDistance = s.distance;
    this.lastCalories = s.calories;
    this.lastPower = s.power;
    if (s.power > 0) this.power.add(s.power);
  }

  /** Call about once a second. Returns true when the phase changed by itself (timer ran out). */
  tick(now: number, hr: number, zone: Zone): boolean {
    const dt = Math.min(5, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    const hasHr = zone !== 'nosignal';
    if (hasHr) this.lastHr = hr;
    if (this.phase === 'idle' || this.phase === 'done') return false;

    if (this.rowingPhase) {
      this.zoneSeconds[zone] += dt;
      if (hasHr) {
        this.hr.add(hr);
        this.maxHr = Math.max(this.maxHr, hr);
      }
    }
    if (this.phase === 'main') {
      this.mainSec += dt;
      if (zone === 'target' && this.lastPower > 0) this.targetPower.add(this.lastPower, dt);
      if (this.plan.type === 'check' && this.plan.testHr && hasHr && this.lastPower > 0) {
        const left = this.phaseClock(now).seconds;
        if (left <= CHECK_SCORED_SECONDS && Math.abs(hr - this.plan.testHr) <= CHECK_HR_TOLERANCE) {
          this.checkPower.add(this.lastPower, dt);
        }
      }
    }
    if (now - this.lastTraceAt >= 5000) {
      this.lastTraceAt = now;
      this.hrTrace.push(hasHr ? hr : 0);
    }

    const clock = this.phaseClock(now);
    if (clock.countdown && clock.seconds <= 0) {
      if (this.phase === 'warmup') this.setPhase('main', now);
      else if (this.phase === 'main') this.beginCooldown(now);
      else if (this.phase === 'cooldown') this.setPhase('recovery', now);
      else if (this.phase === 'recovery') this.setPhase('done', now);
      return true;
    }
    return false;
  }

  /** Builds the summary and adds it to the saved history. Call once when the phase becomes 'done'. */
  complete(): SessionSummary {
    const s = this.settings;
    const summary: SessionSummary = {
      id: new Date(this.startedAt).toISOString(),
      startedAt: this.startedAt,
      type: this.plan.type,
      level: this.plan.level,
      durationSec: Math.round(Object.values(this.zoneSeconds).reduce((a, b) => a + b, 0)),
      distance: Math.round(this.distance),
      calories: Math.round(this.calories),
      avgHr: this.hr.value,
      maxHr: this.maxHr,
      avgPower: this.power.value,
      zoneSeconds: { ...this.zoneSeconds },
      mainSec: Math.round(this.mainSec),
      plannedMainSec: (this.plan.mainMinutes ?? 0) * 60,
      // Require a minute (n = seconds) of in-zone data so a few stray samples don't produce a misleading number.
      targetWatts: this.targetPower.n >= 60 ? this.targetPower.value : 0,
      hrAtStop: this.hrAtStop,
      hrAfterRecovery: this.lastHr,
      hrTrace: this.hrTrace.slice(),
      settingsUsed: { targetLow: s.targetLow, targetHigh: s.targetHigh, ceiling: s.ceiling, maxHr: s.maxHr },
    };
    if (this.plan.type === 'check') {
      summary.testHr = this.plan.testHr;
      // Need at least 2 of the 5 scored minutes near the test HR for a fair result.
      summary.checkWatts = this.checkPower.n >= 120 ? this.checkPower.value : 0;
    }
    const history = loadHistory();
    history.push(summary);
    saveHistory(history);
    return summary;
  }
}

function delta(prev: number | null, cur: number): number {
  if (prev === null) return 0;
  return cur >= prev ? cur - prev : cur; // counter reset: count from zero
}

export function loadHistory(): SessionSummary[] {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as Partial<SessionSummary>[];
    // Sessions saved before the trainer existed: fill in the new fields.
    const defaults = { type: 'free', level: 1, mainSec: 0, plannedMainSec: 0, targetWatts: 0 } as const;
    return list.map((s) => ({ ...defaults, ...s }) as SessionSummary);
  } catch {
    return [];
  }
}

export function saveHistory(history: SessionSummary[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)));
  } catch (err) {
    console.error('Could not save history', err);
  }
}

/** Adds the after-session answers to a saved session. */
export function updateSession(id: string, patch: Partial<SessionSummary>) {
  const history = loadHistory();
  const s = history.find((h) => h.id === id);
  if (s) {
    Object.assign(s, patch);
    saveHistory(history);
  }
}
