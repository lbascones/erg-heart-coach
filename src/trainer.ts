import type { SessionSummary } from './session';
import type { Settings } from './settings';

/**
 * The virtual trainer: decides when you row and for how long, based on how your sessions go.
 *
 * Philosophy (conservative, for a deconditioned beginner):
 *  - Intensity never increases: you always row in your own heart-rate zone.
 *  - Duration grows first, then frequency, a small step at a time.
 *  - Moving up needs several good sessions; a too-hard session or time off steps you back.
 *  - Reporting symptoms pauses the plan until you confirm a doctor has cleared you.
 */

export interface Level {
  n: number;
  perWeek: number;
  /** Minutes of main rowing, not counting warm-up and cool-down. */
  mainMin: number;
}

export const LEVELS: Level[] = [
  { n: 1, perWeek: 3, mainMin: 10 },
  { n: 2, perWeek: 3, mainMin: 12 },
  { n: 3, perWeek: 3, mainMin: 14 },
  { n: 4, perWeek: 3, mainMin: 16 },
  { n: 5, perWeek: 3, mainMin: 18 },
  { n: 6, perWeek: 3, mainMin: 20 },
  { n: 7, perWeek: 4, mainMin: 20 },
  { n: 8, perWeek: 4, mainMin: 22 },
  { n: 9, perWeek: 4, mainMin: 25 },
  { n: 10, perWeek: 4, mainMin: 28 },
  { n: 11, perWeek: 4, mainMin: 30 },
  { n: 12, perWeek: 5, mainMin: 30 },
];

/** Good sessions in a row needed to move up a level. */
export const GOOD_TO_LEVEL_UP = 3;
/** Days between fitness checks. */
export const CHECK_EVERY_DAYS = 28;
/** The first fitness check comes after this many sessions, once rowing feels familiar. */
const FIRST_CHECK_AFTER_SESSIONS = 3;
/** Fitness-check length (main part). */
export const CHECK_MAIN_MIN = 10;

export type SessionType = 'planned' | 'check' | 'free';

export interface SessionPlan {
  type: SessionType;
  /** null = open-ended (free row). */
  mainMinutes: number | null;
  /** Heart rate to hold during a fitness check. */
  testHr?: number;
  level: number;
}

export interface Feedback {
  /** How hard it felt, 1 (very easy) to 10 (maximal). */
  rpe: number;
  symptoms: boolean;
}

export interface TrainerState {
  level: number;
  goodStreak: number;
  shortStreak: number;
  paused: boolean;
  /** Heart rate used for every fitness check; fixed at the first check so results stay comparable. */
  testHr: number | null;
  lastCheckAt: number | null;
  lastSessionAt: number | null;
  /** Timestamps of recent sessions, for the "per week" limit. */
  recentSessions: number[];
  /** The lastSessionAt value a layoff step-back was already applied for, and how many levels it took. */
  layoffAppliedFor: number | null;
  layoffSteps: number;
  /** After a long break: run a fitness check once this many sessions are completed. */
  checkAfterSessions: number | null;
  sessionsCompleted: number;
}

export type Today =
  | { kind: 'paused' }
  | { kind: 'row'; plan: SessionPlan; text: string }
  | { kind: 'rest'; nextDay: number; text: string }
  | { kind: 'done-today'; nextDay: number; text: string };

const KEY = 'rowing.trainer.v1';
const DAY = 86_400_000;

export function defaultTrainerState(): TrainerState {
  return {
    level: 1,
    goodStreak: 0,
    shortStreak: 0,
    paused: false,
    testHr: null,
    lastCheckAt: null,
    lastSessionAt: null,
    recentSessions: [],
    layoffAppliedFor: null,
    layoffSteps: 0,
    checkAfterSessions: null,
    sessionsCompleted: 0,
  };
}

export function loadTrainer(): TrainerState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultTrainerState(), ...JSON.parse(raw) };
  } catch {
    /* use defaults */
  }
  return defaultTrainerState();
}

export function saveTrainer(t: TrainerState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch (err) {
    console.error('Could not save trainer state', err);
  }
}

export function levelInfo(n: number): Level {
  return LEVELS[Math.min(LEVELS.length, Math.max(1, n)) - 1];
}

/** Local calendar day number (days since epoch in local time). */
export function dayNumber(t: number): number {
  const d = new Date(t);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY);
}

export function dayToDate(day: number): Date {
  // Noon avoids daylight-saving edge cases when converting back.
  const d = new Date(day * DAY);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
}

export function describeDay(day: number, today: number): string {
  if (day <= today) return 'today';
  if (day === today + 1) return 'tomorrow';
  return dayToDate(day).toLocaleDateString(undefined, { weekday: 'long' });
}

export function daysSinceLastSession(t: TrainerState, now: number): number | null {
  return t.lastSessionAt === null ? null : dayNumber(now) - dayNumber(t.lastSessionAt);
}

/**
 * How many levels to step back after `gapDays` without rowing. A normal gap is 1-3 days.
 * Beginners lose fitness quickly: roughly one level per week away, more for long breaks.
 */
export function layoffStepBack(gapDays: number): number {
  if (gapDays >= 60) return LEVELS.length; // a couple of months: start again from level 1
  if (gapDays >= 28) return 4;
  if (gapDays >= 21) return 3;
  if (gapDays >= 14) return 2;
  if (gapDays >= 8) return 1;
  return 0;
}

/**
 * Time off loses fitness, so step back when you return (e.g. after a vacation).
 * Safe to call often: it acts once per break, and the step grows if the break keeps getting longer.
 * Returns a welcome-back message when a break has been detected.
 */
export function applyLayoff(t: TrainerState, now: number): string | null {
  const gap = daysSinceLastSession(t, now);
  if (gap === null) return null;
  const stepBack = layoffStepBack(gap);
  if (!stepBack) return null;
  // Step back only by what has not already been applied for this same break.
  const already = t.layoffAppliedFor === t.lastSessionAt ? t.layoffSteps : 0;
  if (stepBack > already) {
    t.level = Math.max(1, t.level - (stepBack - already));
    t.layoffAppliedFor = t.lastSessionAt;
    t.layoffSteps = stepBack;
    t.goodStreak = 0;
    t.shortStreak = 0;
    // After a long break, re-measure fitness soon so the progress chart shows where you are now.
    if (gap >= 28) t.checkAfterSessions = t.sessionsCompleted + 2;
    saveTrainer(t);
  }
  const where = t.level === 1 ? 'starting gently at level 1' : `easing you back in at level ${t.level}`;
  return `Welcome back! It's been ${gap} days since your last row, so we're ${where}.`;
}

/** The first day you are allowed to row again under the current level's rules. */
export function nextAllowedDay(t: TrainerState, now: number): number {
  const today = dayNumber(now);
  if (t.lastSessionAt === null) return today;
  const lvl = levelInfo(t.level);
  // Up to 3 a week: always a rest day between sessions. 4+: consecutive days are allowed.
  const minGap = lvl.perWeek <= 3 ? 2 : 1;
  let day = dayNumber(t.lastSessionAt) + minGap;
  // Weekly cap: no more than perWeek sessions in any 7-day window.
  const days = t.recentSessions.map(dayNumber).sort((a, b) => a - b);
  while (days.filter((d) => d > day - 7 && d <= day).length >= lvl.perWeek) day++;
  return Math.max(day, today);
}

function checkDue(t: TrainerState, now: number): boolean {
  if (t.checkAfterSessions !== null && t.sessionsCompleted >= t.checkAfterSessions) return true;
  if (t.lastCheckAt === null) return t.sessionsCompleted >= FIRST_CHECK_AFTER_SESSIONS;
  return now - t.lastCheckAt >= CHECK_EVERY_DAYS * DAY;
}

export function testHrFor(t: TrainerState, s: Settings): number {
  return t.testHr ?? Math.round((s.targetLow + s.targetHigh) / 2);
}

export function planToday(t: TrainerState, s: Settings, now: number): Today {
  if (t.paused) return { kind: 'paused' };
  const today = dayNumber(now);
  const lvl = levelInfo(t.level);
  const rowedToday = t.lastSessionAt !== null && dayNumber(t.lastSessionAt) === today;
  const next = nextAllowedDay(t, now);

  if (rowedToday) {
    return {
      kind: 'done-today',
      nextDay: next === today ? today + 1 : next,
      text: `Done for today. Next session: ${describeDay(next === today ? today + 1 : next, today)}.`,
    };
  }
  if (next > today) {
    return {
      kind: 'rest',
      nextDay: next,
      text: `Rest day: recovery is when you get fitter. Next session: ${describeDay(next, today)}.`,
    };
  }
  if (checkDue(t, now)) {
    const hr = testHrFor(t, s);
    return {
      kind: 'row',
      plan: { type: 'check', mainMinutes: CHECK_MAIN_MIN, testHr: hr, level: t.level },
      text: `Fitness check today: ${CHECK_MAIN_MIN} min holding ${hr} bpm. Keep the damper setting the same as always.`,
    };
  }
  return {
    kind: 'row',
    plan: { type: 'planned', mainMinutes: lvl.mainMin, level: t.level },
    text: `Today: ${lvl.mainMin} min steady in your zone (level ${t.level} of ${LEVELS.length}).`,
  };
}

/**
 * Updates the trainer after a session and returns what it wants to tell you.
 * Rules:
 *  - symptoms: pause everything;
 *  - too hard (felt 8+/10 or over 2 min above the ceiling): step back a level;
 *  - good (90% of planned time, felt 6/10 or easier, under 30 s over the ceiling): count toward level-up;
 *  - cut short twice in a row: step back a level.
 */
export function recordSession(t: TrainerState, s: SessionSummary, fb: Feedback): string {
  t.lastSessionAt = s.startedAt;
  t.recentSessions = [...t.recentSessions, s.startedAt].filter((x) => s.startedAt - x < 14 * DAY);
  t.sessionsCompleted++;

  if (fb.symptoms) {
    t.paused = true;
    saveTrainer(t);
    return (
      'You reported symptoms, so the trainer is paused. Please talk to your doctor before rowing again. ' +
      'If you have chest pain or severe breathlessness right now, call emergency services.'
    );
  }

  const overSec = s.zoneSeconds.over;
  const tooHard = fb.rpe >= 8 || overSec > 120;
  let msg: string;

  if (s.type === 'check') {
    t.lastCheckAt = s.startedAt;
    t.checkAfterSessions = null;
    if (t.testHr === null && s.testHr) t.testHr = s.testHr;
    msg = s.checkWatts
      ? `Fitness check recorded: ${s.checkWatts} W at ${s.testHr} bpm. Next check in about 4 weeks.`
      : 'Fitness check finished, but there was not enough steady heart-rate data to score it. We will try again next time.';
    if (tooHard) {
      t.level = Math.max(1, t.level - 1);
      t.goodStreak = 0;
      msg += ` That felt hard, so we'll ease off to level ${t.level}.`;
    }
  } else if (s.type === 'free') {
    msg = 'Free row logged. It counts toward rest days, but not toward leveling up.';
  } else {
    const ratio = s.plannedMainSec ? s.mainSec / s.plannedMainSec : 1;
    const good = ratio >= 0.9 && fb.rpe <= 6 && overSec < 30;
    if (tooHard) {
      t.goodStreak = 0;
      t.shortStreak = 0;
      const before = t.level;
      t.level = Math.max(1, t.level - 1);
      msg =
        t.level < before
          ? `That was harder than it should be. We'll step back to level ${t.level} and build up again.`
          : 'That was harder than it should be. Next time, row a bit gentler and stay lower in your zone.';
    } else if (good) {
      t.shortStreak = 0;
      t.goodStreak++;
      if (t.goodStreak >= GOOD_TO_LEVEL_UP && t.level < LEVELS.length) {
        t.level++;
        t.goodStreak = 0;
        const l = levelInfo(t.level);
        msg = `Level up! You're now on level ${t.level}: ${l.mainMin} min, ${l.perWeek} times a week.`;
      } else if (t.level >= LEVELS.length) {
        msg = 'Great session. You are at the top level. Keep it up, and talk to your doctor about next goals.';
      } else {
        const left = GOOD_TO_LEVEL_UP - t.goodStreak;
        msg = `Great session! ${left} more like this and you move up a level.`;
      }
    } else {
      if (ratio < 0.9) t.shortStreak++;
      if (t.shortStreak >= 2) {
        t.level = Math.max(1, t.level - 1);
        t.shortStreak = 0;
        t.goodStreak = 0;
        msg = `Two shorter sessions in a row: no problem, we'll go back to level ${t.level} for a while.`;
      } else {
        msg = 'Session logged. Same plan next time.';
      }
    }
  }
  saveTrainer(t);
  return msg;
}
