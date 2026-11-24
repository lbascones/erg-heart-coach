import type { Zone } from './heartrate';
import type { Settings } from './settings';
import type { RowerSample } from './sources/source';
import { CHECK_MAIN_MIN, type SessionPlan, type SessionType } from './trainer';

/** 'standby': Start was pressed, waiting for the first stroke (the laptop is out of reach from the seat). */
export type Phase = 'idle' | 'standby' | 'warmup' | 'main' | 'cooldown' | 'done';

/**
 * Heart-rate drop: HR at the end of the workout, and again this long into the cool-down (still rowing easily).
 * Same method as exercise tests, but after moderate work the drop is smaller: compare with your own sessions, not published values.
 */
export const HR_DROP_SECONDS = 60;
/** Fitness check: only the last part of the check (the first CHECK_MAIN_MIN of the main phase) is scored, once HR has settled. */
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
  /** Fitness check thrown away with "Redo the latest check" (its score is removed). */
  checkDiscarded?: boolean;
  /** HR at the end of the workout and after the first minute of the cool-down (0 = not measured). */
  hrDropFrom?: number;
  hrDropTo?: number;
  /** Older sessions: HR after the cool-down and 60 s later sitting still (no longer measured). */
  hrAtStop?: number;
  hrAfterRecovery?: number;
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
  private mainPower = new Averager();
  /** Suggested cool-down effort: about half the workout's average watts (0 = no suggestion). */
  cooldownWatts = 0;
  private targetPower = new Averager();
  private checkPower = new Averager();
  private wasInCheck = false;
  private lastPower = 0;
  private hrTrace: number[] = [];
  private lastTraceAt = 0;
  private lastTickAt = 0;
  private lastDistance: number | null = null;
  private lastCalories: number | null = null;
  /** Heart-rate drop: HR at the end of the workout, and after the first minute of the cool-down. */
  hrDropFrom = 0;
  hrDropTo = 0;
  private dropDone = false;
  private lastHr = 0;
  private lastHrAt = 0;
  /** Interval session: the piece we were in at the last tick, to chime when it changes. */
  private lastPieceKey = '';

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
    return null;
  }

  /**
   * Fitness-check day, main phase: the first CHECK_MAIN_MIN minutes hold the test heart rate (the check),
   * then the rest of the planned time is normal rowing in your zone. Null once the check part is over.
   */
  checkPart(now = Date.now()): { secondsIn: number; secondsLeft: number } | null {
    if (this.phase !== 'main' || this.plan.type !== 'check') return null;
    const t = Math.max(0, (now - this.phaseStartedAt) / 1000);
    const len = CHECK_MAIN_MIN * 60;
    return t < len ? { secondsIn: t, secondsLeft: len - t } : null;
  }

  /**
   * Interval session, main phase only: which piece you are in and how long it has left.
   * `rep` counts from 1. Null outside an interval session's main phase.
   */
  intervalState(
    now = Date.now(),
  ): { hard: boolean; rep: number; reps: number; secondsIn: number; secondsLeft: number; last: boolean } | null {
    const iv = this.plan.intervals;
    if (this.phase !== 'main' || !iv) return null;
    const t = Math.max(0, (now - this.phaseStartedAt) / 1000);
    const cycle = iv.workSec + iv.easySec;
    const rep = Math.min(iv.reps - 1, Math.floor(t / cycle));
    const within = t - rep * cycle;
    const hard = within < iv.workSec;
    const secondsLeft = Math.max(0, hard ? iv.workSec - within : cycle - within);
    const secondsIn = hard ? within : within - iv.workSec;
    return { hard, rep: rep + 1, reps: iv.reps, secondsIn, secondsLeft, last: rep + 1 === iv.reps };
  }

  /**
   * Arms a session: it waits in standby and begins with the first stroke (or begin()).
   * `last` is the monitor's latest reading, so the first stroke's meters are counted too.
   */
  start(plan: SessionPlan, last: { distance: number; calories: number } | null = null, now = Date.now()) {
    const settings = this.settings;
    Object.assign(this, new Session(settings));
    this.plan = plan;
    this.startedAt = now;
    this.lastTickAt = now;
    this.lastDistance = last?.distance ?? null;
    this.lastCalories = last?.calories ?? null;
    this.setPhase('standby', now);
  }

  /** Leaves standby: the session clock and warm-up start now. */
  begin(now = Date.now()) {
    if (this.phase !== 'standby') return;
    this.startedAt = now;
    this.lastTickAt = now;
    this.setPhase(this.settings.warmupMinutes > 0 ? 'warmup' : 'main', now);
  }

  skipWarmup(now = Date.now()) {
    if (this.phase === 'warmup') this.setPhase('main', now);
  }

  beginCooldown(now = Date.now()) {
    if (this.phase === 'warmup' || this.phase === 'main') {
      this.setPhase(this.settings.cooldownMinutes > 0 ? 'cooldown' : 'done', now);
    }
  }

  finish(now = Date.now()) {
    if (this.rowingPhase) this.setPhase('done', now);
  }

  /** Seconds until the heart-rate drop is measured, or null when it is not being measured right now. */
  dropSecondsLeft(now = Date.now()): number | null {
    if (this.phase !== 'cooldown' || this.dropDone || !this.hrDropFrom) return null;
    return Math.max(0, HR_DROP_SECONDS - (now - this.phaseStartedAt) / 1000);
  }

  reset() {
    this.phase = 'idle';
  }

  private setPhase(p: Phase, now: number) {
    // The drop is measured from the last fresh reading of the workout.
    if (p === 'cooldown') {
      this.hrDropFrom = now - this.lastHrAt <= 5000 ? this.lastHr : 0;
      // Rounded to 5 W so it is an easy number to hold; never below 20 W.
      this.cooldownWatts = this.mainPower.n ? Math.max(20, Math.round(this.mainPower.value / 2 / 5) * 5) : 0;
    }
    this.phase = p;
    this.phaseStartedAt = now;
  }

  onSample(s: RowerSample) {
    if (this.phase === 'standby' && s.power > 0) this.begin(s.time);
    if (!this.rowingPhase) return;
    // The PM's counters reset when a new workout starts on it, so add up the increases ourselves.
    this.distance += delta(this.lastDistance, s.distance);
    this.calories += delta(this.lastCalories, s.calories);
    this.lastDistance = s.distance;
    this.lastCalories = s.calories;
    this.lastPower = s.power;
    if (s.power > 0) this.power.add(s.power);
    if (s.power > 0 && this.phase === 'main') this.mainPower.add(s.power);
  }

  /** Call about once a second. Returns true when the phase changed by itself (timer ran out) or an interval piece changed. */
  tick(now: number, hr: number, zone: Zone): boolean {
    const dt = Math.min(5, (now - this.lastTickAt) / 1000);
    this.lastTickAt = now;
    const hasHr = zone !== 'nosignal';
    if (hasHr) {
      this.lastHr = hr;
      this.lastHrAt = now;
    }
    if (this.phase === 'idle' || this.phase === 'standby' || this.phase === 'done') return false;

    if (this.rowingPhase) {
      this.zoneSeconds[zone] += dt;
      if (hasHr) {
        this.hr.add(hr);
        this.maxHr = Math.max(this.maxHr, hr);
      }
    }
    if (this.phase === 'main') {
      this.mainSec += dt;
      // Interval sessions are left out: their "target" during the hard pieces is a different band.
      if (zone === 'target' && this.lastPower > 0 && this.plan.type !== 'intervals') this.targetPower.add(this.lastPower, dt);
      if (this.plan.type === 'check' && this.plan.testHr && hasHr && this.lastPower > 0) {
        const left = this.checkPart(now)?.secondsLeft ?? 0;
        if (left > 0 && left <= CHECK_SCORED_SECONDS && Math.abs(hr - this.plan.testHr) <= CHECK_HR_TOLERANCE) {
          this.checkPower.add(this.lastPower, dt);
        }
      }
    }
    if (now - this.lastTraceAt >= 5000) {
      this.lastTraceAt = now;
      this.hrTrace.push(hasHr ? hr : 0);
    }

    if (this.phase === 'cooldown' && !this.dropDone && (now - this.phaseStartedAt) / 1000 >= HR_DROP_SECONDS) {
      this.dropDone = true;
      if (hasHr && this.hrDropFrom) this.hrDropTo = hr;
    }

    // Chime when an interval piece starts or ends.
    const piece = this.intervalState(now);
    const pieceKey = piece ? `${piece.rep}|${piece.hard}` : '';
    const pieceChanged = this.lastPieceKey !== '' && pieceKey !== '' && pieceKey !== this.lastPieceKey;
    this.lastPieceKey = pieceKey;
    // Chime when the check part ends and normal zone rowing begins.
    const inCheck = this.checkPart(now) !== null;
    const checkEnded = this.wasInCheck && !inCheck && this.phase === 'main';
    this.wasInCheck = inCheck;

    const clock = this.phaseClock(now);
    if (clock.countdown && clock.seconds <= 0) {
      if (this.phase === 'warmup') this.setPhase('main', now);
      else if (this.phase === 'main') this.beginCooldown(now);
      else if (this.phase === 'cooldown') this.setPhase('done', now);
      return true;
    }
    return pieceChanged || checkEnded;
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
      hrDropFrom: this.hrDropTo ? this.hrDropFrom : 0,
      hrDropTo: this.hrDropTo,
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
