import { Alarm } from './alarm';
import {
  applyBackup,
  downloadBackup,
  fetchServerBackup,
  lastBackupAt,
  pushBackup,
  sessionCount,
} from './backup';
import { diag, saveDiagnostics } from './diagnostics';
import { drawForceCurves, drawSessionHr } from './charts';
import { HeartRateTracker, ZONE_LABEL, type Zone } from './heartrate';
import { remindersEnabled, scheduleReminder, sendTestNotification } from './notify';
import { MobilityRoutine, routineMinutes, syncMobility } from './mobility';
import { attachTooltips, renderProgress } from './progress';
import { VideoPlayer } from './video';
import { loadHistory, saveHistory, Session, updateSession, type Phase, type SessionSummary } from './session';
import {
  ageOn,
  defaultsForAge,
  limitsMatchAge,
  loadSettings,
  refreshAgeLimits,
  saveSettings,
  settingsAreDefaults,
  validate,
  withLimitsSource,
  zoneLimits,
  type Settings,
} from './settings';
import { PM4Source } from './sources/pm4';
import { SimulatorSource } from './sources/simulator';
import type { ConnectionStatus, RowerSample, RowerSource } from './sources/source';
import {
  applyLayoff,
  CHECK_MAIN_MIN,
  dayNumber,
  daysSinceLastSession,
  dayToDate,
  discardLatestCheck,
  levelInfo,
  loadTrainer,
  planToday,
  recordSession,
  saveTrainer,
  type SessionPlan,
  type Today,
} from './trainer';

// ---------- State ----------
let settings = loadSettings();
const tracker = new HeartRateTracker(settings);
const alarm = new Alarm();
alarm.enabled = settings.sound;
const session = new Session(settings);
const trainer = loadTrainer();
// Older versions marked an unscored fitness check as done (next one in 4 weeks): redo it (at the first session of a week) instead.
{
  const history = loadHistory();
  const last = history.filter((s) => s.type === 'check' && !s.checkDiscarded).at(-1);
  if (last && !last.checkWatts && trainer.lastCheckAt === last.startedAt) {
    discardLatestCheck(trainer, history);
    saveHistory(history);
  }
}
let welcomeBack = applyLayoff(trainer, Date.now());
/** Shown on the home screen after a birthday moved the estimated heart-rate limits. */
let birthdayNotice: string | null = null;
let source: RowerSource | null = null;
let lastSample: RowerSample | null = null;
const curves: number[][] = [];
const MAX_CURVES = 6;

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  connDot: $('conn-dot'),
  connText: $('conn-text'),
  phaseName: $('phase-name'),
  hrValue: $('hr-value'),
  hrZoneLabel: $('hr-zone-label'),
  zoneBar: $('zone-bar'),
  zoneMarker: $('zone-marker'),
  hrLimits: $('hr-limits'),
  pace: $('m-pace'),
  power: $('m-power'),
  spm: $('m-spm'),
  distance: $('m-distance'),
  time: $('m-time'),
  cal: $('m-cal'),
  guideText: $('guide-text'),
  guideSub: $('guide-sub'),
  phaseActions: $('phase-actions'),
  coach: $('coach'),
  coachStage: $('coach-stage'),
  coachPips: $('coach-pips'),
  coachClocks: $('coach-clocks'),
  workoutBar: $('workout-bar'),
  btnVideo: $('btn-video'),
  summaryHrChart: $<HTMLCanvasElement>('summary-hr-chart'),
  forceChart: $<HTMLCanvasElement>('force-chart'),
  banner: $('alert-banner'),
  connectOverlay: $('connect-overlay'),
  connectError: $('connect-error'),
  simPanel: $('sim-panel'),
  simEffort: $('sim-effort'),
  settingsDialog: $<HTMLDialogElement>('settings-dialog'),
  settingsForm: $<HTMLFormElement>('settings-form'),
  settingsError: $('settings-error'),
  notifyStatus: $('notify-status'),
  cancelDialog: $<HTMLDialogElement>('cancel-dialog'),
  summaryDialog: $<HTMLDialogElement>('summary-dialog'),
  summaryBody: $('summary-body'),
  feedback: $('feedback'),
  rpeButtons: $('rpe-buttons'),
  symptoms: $<HTMLInputElement>('symptoms'),
  verdict: $('coach-verdict'),
  feedbackSave: $<HTMLButtonElement>('btn-feedback-save'),
  summaryClose: $('btn-summary-close'),
  progressOverlay: $('progress-overlay'),
  chartTip: $('chart-tip'),
  diagDialog: $<HTMLDialogElement>('diag-dialog'),
  diagStatus: $('diag-status'),
  diagToggle: $<HTMLButtonElement>('btn-diag-toggle'),
  diagRec: $('btn-diag-rec'),
};

function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtPace(sec: number): string {
  if (!sec || sec > 600) return '--';
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// ---------- Connecting ----------
async function useSource(src: RowerSource, interactive: boolean) {
  source?.stop();
  source = src;
  src.on('status', onStatus);
  src.on('sample', (s) => {
    lastSample = s;
    session.onSample(s);
  });
  src.on('heartRate', (bpm, t) => {
    tracker.report(bpm, t);
  });
  src.on('forceCurve', (c) => {
    curves.push(c);
    if (curves.length > MAX_CURVES) curves.shift();
    drawForceCurves(el.forceChart, curves);
  });
  await src.start(interactive);
  el.connectOverlay.hidden = true;
  el.simPanel.hidden = !(src instanceof SimulatorSource);
  // First run, or settings from before birth dates were asked for.
  if (settingsAreDefaults() || !settings.birthDate) openSettings();
}

function onStatus(status: ConnectionStatus, message?: string) {
  el.connDot.className = `dot ${status}`;
  const name = source?.name ?? '';
  el.connText.textContent =
    status === 'connected'
      ? `${name}${message && message !== name ? `: ${message}` : ''}`
      : status === 'connecting'
        ? 'Connecting…'
        : status === 'disconnected'
          ? 'Monitor disconnected, reconnecting…'
          : message ?? 'Connection error';
}

$('btn-connect-pm').addEventListener('click', async () => {
  alarm.unlock();
  el.connectError.hidden = true;
  try {
    await useSource(new PM4Source(), true);
  } catch (err) {
    el.connectError.textContent = `Could not connect to the monitor: ${String(err)}`;
    el.connectError.hidden = false;
  }
});

$('btn-connect-sim').addEventListener('click', () => {
  alarm.unlock();
  void useSource(new SimulatorSource(), true);
});

// ---------- Simulator controls ----------
el.simPanel.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest('button')?.dataset.sim;
  if (!(source instanceof SimulatorSource) || !action) return;
  if (action === 'up') source.adjustEffort(0.05);
  if (action === 'down') source.adjustEffort(-0.05);
  if (action === 'pause') source.rowing = !source.rowing;
  if (action === 'hr') source.hrSignal = !source.hrSignal;
});

// ---------- Session controls ----------
const PHASE_TITLE: Record<Phase, string> = {
  idle: 'Ready',
  standby: 'Standing by',
  warmup: 'Warm-up',
  main: 'Workout',
  cooldown: 'Cool-down',
  done: 'Done',
};

type ActionButton = [label: string, fn: () => void, cls?: string, disabled?: boolean];
let renderedActionsKey = '';

function renderPhaseActions(today: Today, hasHr: boolean) {
  const key = `${session.phase}|${session.checkPart() ? 'chk' : ''}|${today.kind}|${today.kind === 'row' ? today.plan.type : ''}|${hasHr}|${session.plan.type}`;
  if (key === renderedActionsKey) return;
  renderedActionsKey = key;
  el.phaseName.textContent =
    session.checkPart()
      ? 'Fitness check'
      : session.phase === 'main' && session.plan.type === 'intervals'
        ? 'Intervals'
        : PHASE_TITLE[session.phase];

  const buttons: ActionButton[] = [];
  switch (session.phase) {
    case 'idle':
      if (today.kind === 'row') {
        // No heart rate needed to press Start: the strap may be out of the receiver's range at the laptop.
        const startLabel =
          today.plan.type === 'check'
            ? 'Start fitness check'
            : today.plan.type === 'intervals'
              ? 'Start interval session'
              : "Start today's session";
        buttons.push([startLabel, () => startSession(today.plan), 'primary huge']);
      } else if (today.kind === 'rest' || today.kind === 'done-today') {
        buttons.push(['Row anyway (free row)', () => startSession(freePlan())]);
      } else if (today.kind === 'paused') {
        buttons.push(['My doctor has cleared me', resumeTrainer]);
      }
      buttons.push([`Mobility (${routineMinutes()} min)`, openMobility, 'ghost']);
      break;
    case 'standby':
      buttons.push(['Start now', () => session.begin()]);
      break;
    case 'warmup':
      buttons.push(['Skip warm-up', () => session.skipWarmup()]);
      buttons.push(['Stop early', () => session.beginCooldown()]);
      break;
    case 'main':
      buttons.push([session.plan.mainMinutes ? 'Stop early' : 'Cool down', () => session.beginCooldown(), 'big']);
      break;
    case 'cooldown':
      buttons.push(['Finish', () => session.finish(), 'primary big']);
      break;
  }
  if (session.phase !== 'idle' && session.phase !== 'done') {
    buttons.push(['Cancel session', () => el.cancelDialog.showModal(), 'ghost']);
  }
  el.phaseActions.replaceChildren(
    ...buttons.map(([label, fn, cls, disabled]) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.disabled = !!disabled;
      b.addEventListener('click', () => {
        alarm.unlock();
        fn();
        renderedActionsKey = '';
        update();
      });
      return b;
    }),
  );
}

function freePlan(): SessionPlan {
  return { type: 'free', mainMinutes: null, level: trainer.level };
}

function startSession(plan: SessionPlan) {
  curves.length = 0;
  drawForceCurves(el.forceChart, curves);
  welcomeBack = null;
  birthdayNotice = null;
  session.start(plan, lastSample);
}

function resumeTrainer() {
  const ok = confirm(
    'Only continue if a doctor has checked the symptoms you reported and said it is OK to exercise. Continue?',
  );
  if (!ok) return;
  trainer.paused = false;
  saveTrainer(trainer);
}

/** Main line and second line of the guidance strip. */
function guidance(zone: Zone, today: Today): [string, string] {
  const s = settings;
  const range = `${s.targetLow}–${s.targetHigh}`;
  if (zone === 'over') return [`Too high! Stop pushing. Row very lightly or stop until you're under ${s.ceiling - 3}.`, ''];

  if (session.phase === 'idle') {
    const waiting = zone === 'nosignal' ? 'Waiting for heart rate: put the strap on and wet the electrodes.' : '';
    const gap = daysSinceLastSession(trainer, Date.now());
    const shortBreak =
      !welcomeBack && gap !== null && gap >= 4 && today.kind === 'row'
        ? `It's been ${gap} days since your last row. Take it easy today and see how it feels.`
        : '';
    switch (today.kind) {
      case 'paused':
        return [
          'Trainer paused because you reported symptoms.',
          'Please see your doctor before rowing again. Tap the button once you have been cleared.',
        ];
      case 'row':
        return [
          today.text,
          waiting ||
            (today.plan.type === 'check'
              ? `For the first ${CHECK_MAIN_MIN} min hold one heart rate, ${today.plan.testHr} bpm, instead of your usual zone: it measures your watts at that heart rate.`
              : '') ||
            birthdayNotice ||
            welcomeBack ||
            shortBreak ||
            `Plus ${s.warmupMinutes} min warm-up and ${s.cooldownMinutes} min cool-down. Heart rate OK, ready when you are.`,
        ];
      default:
        return [today.text, waiting || birthdayNotice || welcomeBack || ''];
    }
  }

  if (session.phase === 'standby') {
    return zone === 'nosignal'
      ? ['Standing by. Waiting for your heart rate.', 'It appears once you are close to the receiver. Then start rowing.']
      : ['Heart rate OK. Start rowing when you are ready.', 'The session starts with your first stroke.'];
  }

  if (zone === 'nosignal') return ['No heart rate! Check the strap.', 'Row very gently until it comes back.'];

  switch (session.phase) {
    case 'warmup':
      if (session.plan.type === 'check') {
        return [
          zone === 'easy' ? 'Warm up gently. A fitness check comes next.' : 'Ease off a little: still warming up.',
          `After the warm-up, hold ${session.plan.testHr} bpm for ${CHECK_MAIN_MIN} min, not your usual zone.`,
        ];
      }
      return zone === 'easy'
        ? ['Warm up gently.', `Easy strokes. Stay below ${s.targetLow} bpm for now.`]
        : ['Ease off a little: still warming up.', `Stay below ${s.targetLow} bpm until the workout starts.`];
    case 'main': {
      const piece = session.intervalState();
      if (piece?.hard) {
        if (zone === 'target') return ["You're in the hard-piece zone. Hold it!", `Stay under ${s.ceiling}.`];
        return ['Push harder!', `Get up to ${s.targetHigh}–${s.ceiling} bpm.`];
      }
      if (piece) {
        return [
          'Easy now. Let your heart rate come down.',
          piece.last ? 'That was the last hard piece. Well done.' : 'Gentle strokes. Get ready for the next piece.',
        ];
      }
      if (session.checkPart()) {
        const hr = session.plan.testHr!;
        if (zone === 'easy') return [`Build up gently to ${hr} bpm.`, 'Steady and smooth, no sprints.'];
        if (zone === 'target') return [`Hold it right here: ${hr} bpm.`, 'The last 5 minutes of the check are scored.'];
        return [`Ease off slightly: aim for ${hr} bpm.`, ''];
      }
      if (zone === 'easy') return ['Push a little harder to reach your target.', `Target: ${range} bpm.`];
      if (zone === 'target') return ["You're in the zone. Hold this effort.", `Target: ${range} bpm.`];
      return ['Ease back into your target.', `Back under ${s.targetHigh} bpm.`];
    }
    case 'cooldown': {
      const aim = session.cooldownWatts ? `about ${session.cooldownWatts} W with light pressure, any comfortable rate` : 'light pressure, any comfortable rate';
      if (session.dropSecondsLeft() !== null) {
        return ['Workout done! Keep rowing easily.', `Steady at ${aim}. Measuring your heart-rate drop.`];
      }
      const drop = session.hrDropTo ? session.hrDropFrom - session.hrDropTo : null;
      return [
        drop !== null ? `Heart rate dropped ${drop} bpm in the first minute.` : 'Cool down: easy strokes.',
        `Keep it easy, ${aim}, and let your heart rate keep falling.`,
      ];
    }
    default:
      return ['', ''];
  }
}

/** The big coach panel: what stage you are in, interval progress, and the clocks that matter right now. */
function renderCoach(now: number) {
  const phase = session.phase;
  const piece = session.intervalState(now);
  const clock = session.phaseClock(now);
  const inPhase = (now - session.phaseStartedAt) / 1000;
  let stage = '';
  type Clock = [label: string, value: number | string, main?: boolean, cls?: string];
  let clocks: Clock[] = [];
  const left = (label: string, seconds: number, main?: boolean): Clock => [label, seconds, main];

  switch (phase) {
    case 'standby':
      stage = 'Standing by';
      break;
    case 'warmup':
      stage = session.plan.type === 'check' ? `Warm-up · then fitness check at ${session.plan.testHr} bpm` : 'Warm-up';
      clocks.push(left('Warm-up left', clock.seconds, true));
      break;
    case 'main':
      if (piece) {
        stage = piece.hard ? `Hard piece ${piece.rep} of ${piece.reps}` : `Easy · after piece ${piece.rep} of ${piece.reps}`;
        clocks.push([piece.hard ? 'In this piece' : 'Easy so far', piece.secondsIn]);
        clocks.push([piece.hard ? (piece.last ? 'Cool-down in' : 'Easy in') : 'Next hard piece in', piece.secondsLeft, true]);
        clocks.push(left('Workout left', clock.seconds));
      } else if (session.checkPart(now)) {
        const part = session.checkPart(now)!;
        stage = `Fitness check · hold ${session.plan.testHr} bpm`;
        clocks.push(['Check so far', part.secondsIn]);
        clocks.push(left('Check left', part.secondsLeft, true));
        clocks.push(left('Workout left', clock.seconds));
      } else if (clock.countdown) {
        stage = 'Steady in your zone';
        clocks.push(['Workout so far', inPhase]);
        clocks.push(left('Workout left', clock.seconds, true));
      } else {
        stage = 'Free row';
        clocks.push(['Rowing for', inPhase, true]);
      }
      break;
    case 'cooldown': {
      stage = videoView ? 'Workout done · Cool-down' : 'Cool-down';
      const measuring = session.dropSecondsLeft(now);
      clocks.push(measuring !== null ? ['Measuring', measuring, true] : ['Cool-down left', clock.seconds, true]);
      if (session.cooldownWatts) clocks.push(['Aim for', `${session.cooldownWatts} W`]);
      if (measuring !== null && tracker.hasSignal()) {
        const drop = session.hrDropFrom - tracker.bpm;
        clocks.push([`Drop from ${session.hrDropFrom}`, drop >= 0 ? `${drop}` : `up ${-drop}`]);
      } else if (session.hrDropTo) {
        clocks.push(['HR drop, 1st min', `${session.hrDropFrom - session.hrDropTo}`]);
      }
      break;
    }
  }

  // Video mode: % through the current colored stretch and the time to the next one replace the minute clocks.
  // Video mode has no rowing-numbers panel, but watts matter for pacing (especially on interval days).
  const fresh = lastSample && now - lastSample.time < 5000 ? lastSample : null;
  const watts: Clock = ['Watts', fresh?.power ? String(fresh.power) : '--'];
  const pos = videoView ? workoutPosition(now) : null;
  if (pos) {
    const head: Clock[] = [
      [pos.seg.label, `${pos.pct}%`, false, `seg-${pos.seg.kind}`],
      [pos.nextLabel, pos.left, true, pos.nextKind ? `seg-${pos.nextKind}` : ''],
    ];
    if (phase === 'cooldown') {
      // Cells, 3 across: % | countdown | measuring (or empty), then Watts Aimed | Watts | heart-rate drop,
      // so the suggested and actual watts sit side by side.
      const find = (test: (label: string) => boolean) => clocks.find(([label]) => test(label));
      const measuring = find((l) => l === 'Measuring');
      const aim = find((l) => l === 'Aim for');
      const drop = find((l) => l.startsWith('Drop from') || l === 'HR drop, 1st min');
      head.push(measuring ?? ['', '']);
      const aimed: Clock = aim ? ['Watts Aimed', String(session.cooldownWatts)] : ['', ''];
      clocks = [...head, aimed, watts, ...(drop ? [drop] : [])];
    } else {
      clocks = [...head, watts];
    }
  } else if (videoView && session.rowingPhase) {
    clocks.push(watts);
  }
  renderWorkoutBar(pos);
  el.coachStage.textContent = stage;
  el.coachStage.hidden = !stage;
  el.coach.classList.toggle('hard', !!piece?.hard);
  el.coach.classList.toggle('easy-piece', !!piece && !piece.hard);
  el.coach.classList.toggle('cooldown', phase === 'cooldown');

  const pips = piece
    ? Array.from({ length: piece.reps }, (_, i) => {
        const n = i + 1;
        if (n < piece.rep || (n === piece.rep && !piece.hard)) return '<span class="done"></span>';
        return n === piece.rep ? '<span class="now"></span>' : '<span></span>';
      }).join('')
    : '';
  if (el.coachPips.innerHTML !== pips) el.coachPips.innerHTML = pips;

  const html = clocks
    .map(
      ([label, v, main, cls]) =>
        `<div class="clock${main ? ' main' : ''}${cls ? ` ${cls}` : ''}"><div class="m-label">${label}</div>` +
        `<div class="clock-value">${typeof v === 'number' ? fmtTime(v) : v}</div></div>`,
    )
    .join('');
  if (el.coachClocks.innerHTML !== html) el.coachClocks.innerHTML = html;
}

// ---------- Main update loop ----------
let lastSessionTick = 0;
let lastLayoffCheck = Date.now();

let loggedPhase = '';

function update() {
  const now = Date.now();
  if (session.phase !== loggedPhase) {
    diag.log('phase', { from: loggedPhase, to: session.phase });
    loggedPhase = session.phase;
  }

  // During a fitness check's main part, "target" means a narrow band around the test HR.
  const checking = !!session.checkPart(now) && session.plan.testHr;
  // During an interval session's hard pieces, "target" means the top of the zone up to the ceiling.
  const hardPiece = session.intervalState(now)?.hard ?? false;
  tracker.setTargetOverride(
    checking
      ? { low: session.plan.testHr! - 3, high: session.plan.testHr! + 3 }
      : hardPiece
        ? { low: settings.targetHigh, high: settings.ceiling }
        : null,
  );
  const zone = tracker.evaluate(now);

  // Re-check for a break regularly, so it is noticed even if the app was left running (kiosk mode).
  if (session.phase === 'idle' && now - lastLayoffCheck >= 60_000) {
    lastLayoffCheck = now;
    welcomeBack = applyLayoff(trainer, now);
    checkBirthday();
  }

  if (now - lastSessionTick >= 1000) {
    lastSessionTick = now;
    const changed = session.tick(now, tracker.bpm, zone);
    if (changed) alarm.chime();
    if (session.phase === 'done' && !el.summaryDialog.open) showSummary(session.complete());
  }

  // Zone colors and heart rate
  document.body.className = `zone-${zone}`;
  el.hrValue.textContent = zone === 'nosignal' ? '--' : String(tracker.bpm);
  el.hrZoneLabel.textContent =
    checking && zone === 'target' ? 'On test heart rate' : hardPiece && zone === 'target' ? 'In hard-piece zone' : ZONE_LABEL[zone];
  positionZoneMarker(zone === 'nosignal' ? null : tracker.bpm);

  // Alarms and banner
  // Standby is not rowing yet: no signal-loss alarm while walking to the rower (the over-limit alarm always works).
  const active = session.phase !== 'idle' && session.phase !== 'standby' && session.phase !== 'done';
  alarm.update(zone, active);
  followSessionWithVideo(zone, active);
  if (zone === 'over') showBanner('over', `HEART RATE ${tracker.bpm}: EASE OFF`);
  else if (zone === 'nosignal' && active) showBanner('nosignal', 'NO HEART RATE SIGNAL');
  else if (zone === 'nosignal' && session.phase === 'standby') showBanner('waiting', 'Waiting for heart-rate signal…');
  else el.banner.hidden = true;

  // Rowing numbers (blank them if data stops coming, e.g. monitor asleep)
  const fresh = lastSample && now - lastSample.time < 5000 ? lastSample : null;
  el.pace.textContent = fresh ? fmtPace(fresh.pace) : '--';
  el.power.textContent = fresh?.power ? String(fresh.power) : '--';
  el.spm.textContent = fresh?.spm ? String(fresh.spm) : '--';
  if (session.phase === 'idle') {
    // No session yet: show the monitor's own totals (as on its display), kept for 2 minutes after the last stroke.
    const recent = lastSample && now - lastSample.time < 120_000 ? lastSample : null;
    el.distance.textContent = recent ? `${Math.round(recent.distance)} m` : '--';
    el.time.textContent = recent ? fmtTime(recent.elapsed) : '--';
    el.cal.textContent = recent ? String(Math.round(recent.calories)) : '--';
  } else {
    el.distance.textContent = `${Math.round(session.distance)} m`;
    el.time.textContent = fmtTime(((session.rowingPhase ? now : session.phaseStartedAt) - session.startedAt) / 1000);
    el.cal.textContent = String(Math.round(session.calories));
  }

  // Guidance strip and coach
  const today = planToday(trainer, settings, now);
  renderPhaseActions(today, zone !== 'nosignal');
  const [main, sub] = guidance(zone, today);
  el.guideText.textContent = main;
  el.guideText.classList.toggle('coach', session.phase === 'idle');
  el.guideSub.textContent = sub;
  el.guideSub.hidden = !sub;
  renderCoach(now);

  if (source instanceof SimulatorSource) {
    el.simEffort.textContent = `effort ${Math.round(source.effort * 100)}%${source.rowing ? '' : ' (stopped)'}${source.hrSignal ? '' : ' (HR off)'}`;
  }

}

function showBanner(kind: 'over' | 'nosignal' | 'waiting', text: string) {
  el.banner.className = kind;
  el.banner.textContent = text;
  el.banner.hidden = false;
}

function zoneScale() {
  const lo = settings.targetLow - 20;
  const hi = settings.ceiling + 15;
  return { lo, hi, pct: (bpm: number) => ((Math.min(hi, Math.max(lo, bpm)) - lo) / (hi - lo)) * 100 };
}

function layoutZoneBar() {
  const { pct } = zoneScale();
  const [easy, target, high, over] = Array.from(el.zoneBar.querySelectorAll<HTMLElement>('.seg'));
  easy.style.width = `${pct(settings.targetLow)}%`;
  target.style.width = `${pct(settings.targetHigh) - pct(settings.targetLow)}%`;
  high.style.width = `${pct(settings.ceiling) - pct(settings.targetHigh)}%`;
  over.style.width = `${100 - pct(settings.ceiling)}%`;
  el.hrLimits.textContent = `Target ${settings.targetLow}–${settings.targetHigh} · Limit ${settings.ceiling}`;
}

function positionZoneMarker(bpm: number | null) {
  el.zoneMarker.style.display = bpm === null ? 'none' : 'block';
  if (bpm !== null) el.zoneMarker.style.left = `${zoneScale().pct(bpm)}%`;
}

// ---------- Phone reminders ----------
/** Schedules a push for the next rowing day at the reminder hour (no-op if reminders are off). */
async function scheduleNextReminder() {
  if (!remindersEnabled(settings)) return;
  const now = Date.now();
  const today = planToday(trainer, settings, now);
  if (today.kind === 'paused') return;
  const day = today.kind === 'row' ? dayNumber(now) : today.nextDay;
  const when = dayToDate(day);
  when.setHours(settings.reminderHour, 0, 0, 0);
  if (when.getTime() <= now && today.kind === 'row') return; // already past today's reminder time
  // The plan for the reminder's day (booked the evening before, today is a rest day, so ask about that day).
  const that = planToday(trainer, settings, when.getTime());
  const plan = that.kind === 'row' ? that.plan : null;
  const lvl = levelInfo(trainer.level);
  const msg =
    plan?.type === 'check'
      ? `Rowing day with a fitness check: ${plan.mainMinutes} minutes, the first ${CHECK_MAIN_MIN} holding one heart rate, ${plan.testHr} bpm (not your usual zone), then your zone.`
      : plan?.type === 'intervals'
        ? `Interval day: ${plan.mainMinutes} minutes of harder pieces with easy rowing between, plus warm-up and cool-down.`
        : `Rowing day: ${lvl.mainMin} minutes in your zone, plus warm-up and cool-down.`;
  const result = await scheduleReminder(settings, when, msg);
  if (result.status === 'scheduled') reminderNotice.hidden = true;
  if (result.status !== 'failed') return;
  const saved = await saveDiagnostics({
    app: 'erg-heart-coach-diagnostics',
    version: 1,
    kind: 'reminder-booking-failed',
    savedAt: new Date().toISOString(),
    reminderFor: when.toISOString(),
    ntfyServer: settings.ntfyServer,
    attempts: result.attempts,
  });
  const whenText = when.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  reminderNoticeText.textContent =
    'file' in saved
      ? `The phone reminder for ${whenText} could not be booked (3 tries). Details: ${saved.file} in Google Drive → rowing-backups/diagnostics.`
      : `The phone reminder for ${whenText} could not be booked (3 tries). Details were downloaded as ${saved.downloaded} (${saved.reason}).`;
  reminderNotice.hidden = false;
}
const reminderNotice = $('reminder-notice');
const reminderNoticeText = $('reminder-notice-text');
$('btn-reminder-notice').addEventListener('click', () => (reminderNotice.hidden = true));

// ---------- Settings ----------
const NUMBER_FIELDS = ['maxHr', 'targetLow', 'targetHigh', 'ceiling', 'warmupMinutes', 'cooldownMinutes', 'reminderHour'];

/** Age given by the birth date currently in the form; used to keep estimated limits in step while editing. */
let formAge: number | null = null;

function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function showFormAge(age: number | null) {
  $('age-display').textContent = age !== null && age >= 0 ? `(age ${age})` : '';
}

function fillForm(s: Settings) {
  const f = el.settingsForm.elements as any;
  for (const key of NUMBER_FIELDS) f[key].value = String((s as any)[key]);
  f.birthDate.value = s.birthDate;
  f.zone.value = s.zone;
  f.birthDate.max = localIsoDate(new Date());
  f.sound.checked = s.sound;
  f.ntfyTopic.value = s.ntfyTopic;
  f.ntfyServer.value = s.ntfyServer;
  f.videoPlaylists.value = s.videoPlaylists;
  formAge = ageOn(s.birthDate) ?? s.limitsFromAge;
  showFormAge(ageOn(s.birthDate));
}

function readForm(): Settings {
  const f = el.settingsForm.elements as any;
  const out: any = {
    birthDate: f.birthDate.value,
    zone: f.zone.value,
    limitsFromAge: settings.limitsFromAge, // worked out again on save
    sound: f.sound.checked,
    ntfyTopic: f.ntfyTopic.value.trim(),
    ntfyServer: f.ntfyServer.value.trim(),
    videoPlaylists: f.videoPlaylists.value.trim(),
  };
  for (const key of NUMBER_FIELDS) out[key] = Number(f[key].value);
  return out as Settings;
}

/** Makes new settings live everywhere and saves them. */
function applySettings(next: Settings) {
  settings = next;
  saveSettings(settings);
  tracker.setSettings(settings);
  session.setSettings(settings);
  alarm.enabled = settings.sound;
  layoutZoneBar();
  if (videoView) void video.prepare(settings.videoPlaylists);
  void scheduleNextReminder();
  void backupNow();
}

/** On a birthday, move estimated limits to the new age (only between sessions; hand-entered limits stay). */
function checkBirthday() {
  if (session.phase !== 'idle') return;
  const next = refreshAgeLimits(settings);
  if (!next) return;
  applySettings(next);
  birthdayNotice =
    `Happy birthday! Your estimated heart-rate limits now match age ${next.limitsFromAge}: ` +
    `target ${next.targetLow}–${next.targetHigh}, limit ${next.ceiling}. If your doctor gave you limits, enter them in Settings.`;
}

function openSettings() {
  fillForm(settings);
  el.settingsError.hidden = true;
  el.notifyStatus.hidden = true;
  el.settingsDialog.showModal();
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-settings-cancel').addEventListener('click', () => el.settingsDialog.close());
$('btn-estimate').addEventListener('click', () => {
  const current = readForm();
  const age = ageOn(current.birthDate);
  if (age === null || age < 10 || age > 110) {
    el.settingsError.textContent = 'Enter your birth date first.';
    el.settingsError.hidden = false;
    return;
  }
  el.settingsError.hidden = true;
  fillForm({ ...current, ...defaultsForAge(age, current.zone) });
});
// Choosing a zone, or typing a max heart rate (e.g. from a stress test), fills in the target and ceiling.
for (const name of ['zone', 'maxHr']) {
  (el.settingsForm.elements.namedItem(name) as HTMLElement).addEventListener('change', () => {
    const current = readForm();
    if (!(current.maxHr >= 80 && current.maxHr <= 230)) return;
    fillForm({ ...current, ...zoneLimits(current.maxHr, current.zone) });
  });
}
// Changing the birth date keeps estimated limits in step; hand-entered limits are left alone.
(el.settingsForm.elements.namedItem('birthDate') as HTMLInputElement).addEventListener('change', () => {
  const current = readForm();
  const age = ageOn(current.birthDate);
  showFormAge(age);
  if (age === null || age < 10 || age > 110) return;
  if (formAge !== null && formAge !== age && limitsMatchAge(current, formAge)) {
    fillForm({ ...current, ...defaultsForAge(age, current.zone) });
  }
  formAge = age;
});
$('btn-test-sound').addEventListener('click', () => {
  alarm.unlock();
  const wasEnabled = alarm.enabled;
  alarm.enabled = true;
  alarm.update('target', true);
  alarm.update('over', true);
  alarm.enabled = wasEnabled;
});
$('btn-test-notify').addEventListener('click', async () => {
  const s = readForm();
  el.notifyStatus.hidden = false;
  if (!s.ntfyTopic) {
    el.notifyStatus.textContent = 'Enter a topic name first.';
    return;
  }
  el.notifyStatus.textContent = 'Sending…';
  try {
    await sendTestNotification(s);
    el.notifyStatus.textContent = 'Sent! Check your phone.';
  } catch (err) {
    el.notifyStatus.textContent = `Could not send: ${String(err)}`;
  }
});
el.settingsForm.addEventListener('submit', (e) => {
  const next = readForm();
  const problem = validate(next);
  if (problem) {
    e.preventDefault();
    el.settingsError.textContent = problem;
    el.settingsError.hidden = false;
    return;
  }
  applySettings(withLimitsSource(next));
  birthdayNotice = null;
});

// ---------- Summary and feedback ----------
let currentSummary: SessionSummary | null = null;
let selectedRpe = 0;

const RPE_HINT = ['', 'very easy', 'very easy', 'easy', 'easy', 'moderate', 'moderate', 'hard', 'hard', 'very hard', 'maximal'];
el.rpeButtons.replaceChildren(
  ...Array.from({ length: 10 }, (_, i) => {
    const b = document.createElement('button');
    b.textContent = String(i + 1);
    b.title = RPE_HINT[i + 1];
    b.addEventListener('click', () => {
      selectedRpe = i + 1;
      el.rpeButtons.querySelectorAll('button').forEach((x, j) => x.classList.toggle('selected', j === i));
      el.feedbackSave.disabled = false;
    });
    return b;
  }),
);

function showSummary(s: SessionSummary) {
  currentSummary = s;
  const zones: [Zone, string][] = [
    ['easy', 'Easy'],
    ['target', 'Target'],
    ['high', 'Above target'],
    ['over', 'Over limit'],
    ['nosignal', 'No signal'],
  ];
  const total = Math.max(1, Object.values(s.zoneSeconds).reduce((a, b) => a + b, 0));
  const drop = s.hrDropFrom && s.hrDropTo ? s.hrDropFrom - s.hrDropTo : null;
  const tile = (label: string, value: string) =>
    `<div class="metric"><div class="m-label">${label}</div><div class="m-value">${value}</div></div>`;
  const fifth =
    s.type === 'check'
      ? tile('Watts at test HR', s.checkWatts ? `${s.checkWatts}` : '--')
      : tile('Watts in zone', s.targetWatts ? String(s.targetWatts) : '--');
  el.summaryBody.innerHTML = `
    <div class="summary-grid">
      ${tile('Time', fmtTime(s.durationSec))}
      ${tile('Distance', `${s.distance} m`)}
      ${fifth}
      ${tile('Avg HR', s.avgHr ? String(s.avgHr) : '--')}
      ${tile('Max HR', s.maxHr ? String(s.maxHr) : '--')}
      ${tile('HR drop, 1st min of cool-down', drop === null ? '--' : drop >= 0 ? `${drop} bpm` : `up ${-drop}`)}
    </div>
    <div class="m-label">Time in each zone</div>
    <div class="zone-split">
      ${zones.map(([z]) => `<div style="width:${(s.zoneSeconds[z] / total) * 100}%;background:var(--${z})"></div>`).join('')}
    </div>
    <div class="zone-legend">
      ${zones
        .filter(([z]) => s.zoneSeconds[z] >= 1)
        .map(([z, label]) => `<span><i style="background:var(--${z})"></i>${label} ${fmtTime(s.zoneSeconds[z])}</span>`)
        .join('')}
    </div>`;
  selectedRpe = 0;
  el.rpeButtons.querySelectorAll('button').forEach((x) => x.classList.remove('selected'));
  el.symptoms.checked = false;
  el.feedback.hidden = false;
  el.verdict.hidden = true;
  el.feedbackSave.hidden = false;
  el.feedbackSave.disabled = true;
  el.summaryClose.hidden = true;
  summaryMobility.hidden = true;
  el.summaryDialog.showModal();
  const has = s.hrTrace.some((v) => v > 0);
  el.summaryHrChart.parentElement!.hidden = !has;
  if (has) drawSessionHr(el.summaryHrChart, s.hrTrace, s.settingsUsed);
}

el.feedbackSave.addEventListener('click', () => {
  if (!currentSummary || !selectedRpe) return;
  const fb = { rpe: selectedRpe, symptoms: el.symptoms.checked };
  updateSession(currentSummary.id, fb);
  const msg = recordSession(trainer, currentSummary, fb);
  el.verdict.textContent = msg;
  el.verdict.classList.toggle('warn', fb.symptoms);
  el.verdict.hidden = false;
  el.feedback.hidden = true;
  el.feedbackSave.hidden = true;
  el.summaryClose.hidden = false;
  summaryMobility.hidden = false;
  void scheduleNextReminder();
  void backupNow();
});

// ---------- Cancelling a session ----------
function refreshActions() {
  renderedActionsKey = '';
  update();
}
$('btn-cancel-keep').addEventListener('click', () => el.cancelDialog.close());
// Discard: nothing is saved and the trainer is untouched (it only changes when feedback is saved).
$('btn-cancel-discard').addEventListener('click', () => {
  el.cancelDialog.close();
  if (session.phase === 'idle' || session.phase === 'done') return;
  session.reset();
  curves.length = 0;
  drawForceCurves(el.forceChart, curves);
  refreshActions();
});

// The summary must be answered before closing; Escape would skip the questions.
el.summaryDialog.addEventListener('cancel', (e) => {
  if (!el.feedbackSave.hidden) e.preventDefault();
});
el.summaryClose.addEventListener('click', () => el.summaryDialog.close());

// ---------- Mobility routine (after rowing, or any time from the start screen) ----------
const mobility = new MobilityRoutine(() => alarm.chime(), () => void backupNow());
function openMobility() {
  alarm.unlock();
  if (el.summaryDialog.open) el.summaryDialog.close();
  mobility.open();
}
const summaryMobility = $('btn-summary-mobility');
summaryMobility.addEventListener('click', openMobility);
// However the dialog closes (button or Escape after answering), return to the idle screen exactly once.
el.summaryDialog.addEventListener('close', () => {
  session.reset();
  currentSummary = null;
});

// ---------- Progress screen ----------
const progressEls = {
  tiles: $('progress-tiles'),
  testHr: $('test-hr'),
  check: $<HTMLCanvasElement>('pc-check'),
  target: $<HTMLCanvasElement>('pc-target'),
  recovery: $<HTMLCanvasElement>('pc-recovery'),
  weekly: $<HTMLCanvasElement>('pc-weekly'),
  knee: $<HTMLCanvasElement>('pc-knee'),
};
attachTooltips([progressEls.check, progressEls.target, progressEls.recovery, progressEls.weekly, progressEls.knee], el.chartTip);

const redoCheckBtn = $('btn-redo-check');
function showProgress() {
  redoCheckBtn.hidden = !loadHistory().some((s) => s.type === 'check' && !s.checkDiscarded);
  renderProgress(progressEls, trainer);
}
$('btn-progress').addEventListener('click', () => {
  el.progressOverlay.hidden = false;
  showBackupStatus();
  requestAnimationFrame(showProgress);
  // Stretching done on the iPad: fetch it, and redraw if anything new came in.
  const before = localStorage.getItem('rowing.mobility.v1');
  void syncMobility().then(() => {
    if (localStorage.getItem('rowing.mobility.v1') !== before && !el.progressOverlay.hidden) showProgress();
  });
});
// Keep the laptop's copy of the stretching progress (part of its backups) up to date.
void syncMobility();
redoCheckBtn.addEventListener('click', () => {
  const latest = loadHistory().filter((s) => s.type === 'check' && !s.checkDiscarded).at(-1);
  if (!latest) return;
  const when = new Date(latest.startedAt).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  if (!confirm(`Discard the fitness check from ${when}? Its score is removed and the check is redone at the first session of next week (normally Monday).`)) return;
  const history = loadHistory();
  if (!discardLatestCheck(trainer, history)) return;
  saveHistory(history);
  renderedActionsKey = '';
  showProgress();
  void scheduleNextReminder();
  void backupNow();
});
$('btn-progress-close').addEventListener('click', () => {
  el.progressOverlay.hidden = true;
  el.chartTip.hidden = true;
});

$('btn-export').addEventListener('click', downloadBackup);

const importInput = $<HTMLInputElement>('import-file');
$('btn-import').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', async () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.app !== 'rowing-display') throw new Error('This is not a rowing-display backup file.');
    if (!confirm(`Replace all data on this device with the backup (${sessionCount(data)} sessions)?`)) return;
    applyBackup(data);
    location.reload();
  } catch (err) {
    alert(`Import failed: ${String(err)}`);
  }
});

// ---------- Automatic backups ----------
const backupStatus = $('backup-status');
function showBackupStatus() {
  const at = lastBackupAt();
  backupStatus.textContent = at
    ? `Last automatic backup: ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    : 'No automatic backup yet';
}
async function backupNow() {
  await pushBackup();
  showBackupStatus();
}

/** If this browser's data was wiped but the laptop has a backup, offer to bring it back. */
async function offerRestoreIfEmpty() {
  if (loadHistory().length > 0) return;
  const backup = await fetchServerBackup();
  const n = backup ? sessionCount(backup) : 0;
  if (!backup || n === 0) return;
  const when = new Date(backup.exportedAt).toLocaleString();
  if (confirm(`This screen has no rowing history, but a backup from ${when} with ${n} sessions was found on this computer. Restore it?`)) {
    applyBackup(backup);
    location.reload();
  }
}

// ---------- Video mode ----------
// videoPref: what the Videos button last chose (remembered). videoView: what is on screen now.
const VIDEO_KEY = 'rowing.videoMode';
let videoPref = false;
try {
  videoPref = localStorage.getItem(VIDEO_KEY) === '1';
} catch {
  /* per-browser convenience only */
}
let videoView = false;
const video = new VideoPlayer($('video-host'), (msg) => ($('video-msg').textContent = msg));
let videoPhase: Phase | null = null;

// In video mode the workout clocks and progress bar move to their own box under the heart rate.
const clocksHome = { parent: el.coachClocks.parentElement!, next: el.coachClocks.nextSibling };
const barHome = { parent: el.workoutBar.parentElement!, next: el.workoutBar.nextSibling };

function setVideoView(on: boolean) {
  videoView = on;
  if (on) {
    $('video-progress').append(el.workoutBar, el.coachClocks);
    flashTapHint('Tap the video for the next song');
  }
  else {
    clocksHome.parent.insertBefore(el.coachClocks, clocksHome.next);
    barHome.parent.insertBefore(el.workoutBar, barHome.next);
  }
  document.documentElement.classList.toggle('video-mode', on);
  el.btnVideo.classList.toggle('on', on);
  el.btnVideo.textContent = on ? 'Dashboard' : 'Videos';
  if (on) void video.prepare(settings.videoPlaylists);
  if (on && session.rowingPhase) video.play();
  // The force curve was hidden: redraw it at its size again.
  if (!on) requestAnimationFrame(() => drawForceCurves(el.forceChart, curves));
}

el.btnVideo.addEventListener('click', () => {
  videoPref = !videoView;
  try {
    localStorage.setItem(VIDEO_KEY, videoPref ? '1' : '0');
  } catch {
    /* ignore */
  }
  setVideoView(videoPref);
  if (!videoPref) video.pause(); // switched off by hand: stop the music too
});

const videoTap = $('video-tap');
let tapHintTimer = 0;
function flashTapHint(text: string) {
  $('video-tap-hint').textContent = text;
  videoTap.classList.add('show-hint');
  clearTimeout(tapHintTimer);
  tapHintTimer = window.setTimeout(() => videoTap.classList.remove('show-hint'), 4000);
}
videoTap.addEventListener('click', () => {
  video.next();
  flashTapHint('Next song…');
});

/** Percent of the planned session (warm-up + workout + cool-down) done, or null for open-ended rows. */
/** One colored stretch of the workout bar in video mode. */
type SegKind = 'warm' | 'steady' | 'hard' | 'easy' | 'cool';
interface Segment {
  kind: SegKind;
  sec: number;
  label: string;
}

/** The planned workout as colored stretches: warm-up, steady or interval pieces, cool-down. Null for a free row. */
function workoutSegments(): Segment[] | null {
  if (session.plan.mainMinutes === null) return null;
  const segs: Segment[] = [];
  const warm = settings.warmupMinutes * 60;
  const cool = settings.cooldownMinutes * 60;
  if (warm > 0) segs.push({ kind: 'warm', sec: warm, label: 'Warm-up' });
  const iv = session.plan.intervals;
  if (iv) {
    for (let r = 1; r <= iv.reps; r++) {
      segs.push({ kind: 'hard', sec: iv.workSec, label: `Hard ${r} of ${iv.reps}` });
      if (r < iv.reps) segs.push({ kind: 'easy', sec: iv.easySec, label: 'Easy' });
    }
  } else {
    const main = session.plan.mainMinutes * 60;
    if (session.plan.type === 'check') {
      const chk = Math.min(main, CHECK_MAIN_MIN * 60);
      segs.push({ kind: 'steady', sec: chk, label: 'Fitness check' });
      if (main > chk) segs.push({ kind: 'steady', sec: main - chk, label: 'Steady' });
    } else {
      segs.push({ kind: 'steady', sec: main, label: 'Steady' });
    }
  }
  if (cool > 0) segs.push({ kind: 'cool', sec: cool, label: 'Cool-down' });
  return segs;
}

/** Seconds into the planned workout, counted from the phase clock so it always matches the phase. */
function workoutElapsed(now: number): number {
  const warm = settings.warmupMinutes * 60;
  const main = (session.plan.mainMinutes ?? 0) * 60;
  const cool = settings.cooldownMinutes * 60;
  const before = session.phase === 'warmup' ? 0 : session.phase === 'main' ? warm : warm + main;
  const length = session.phase === 'warmup' ? warm : session.phase === 'main' ? main : cool;
  return before + Math.max(0, length - session.phaseClock(now).seconds);
}

const NEXT_LABEL: Record<SegKind, string> = {
  warm: 'Warm-up in',
  steady: 'Steady in',
  hard: 'Hard in',
  easy: 'Easy in',
  cool: 'Cool-down in',
};

/** Where you are on the bar: the current stretch, % through it, and time until the next change. */
function workoutPosition(now: number) {
  const segs = workoutSegments();
  if (!segs || !session.rowingPhase) return null;
  const total = segs.reduce((n, sg) => n + sg.sec, 0);
  if (total <= 0) return null;
  const elapsed = Math.min(total, workoutElapsed(now));
  let start = 0;
  let i = 0;
  while (i < segs.length - 1 && elapsed >= start + segs[i].sec) start += segs[i++].sec;
  const seg = segs[i];
  const next = segs[i + 1];
  return {
    segs,
    total,
    elapsed,
    seg,
    pct: Math.max(0, Math.min(100, Math.floor(((elapsed - start) / seg.sec) * 100))),
    left: Math.max(0, start + seg.sec - elapsed),
    nextLabel: next ? NEXT_LABEL[next.kind] : 'Done in',
    nextKind: next?.kind ?? null,
  };
}

/** Draws the colored stretches once per workout, then moves the dot and darkens what is behind it. */
let barKey = '';
function renderWorkoutBar(pos: ReturnType<typeof workoutPosition>) {
  el.workoutBar.hidden = pos === null;
  if (!pos) return;
  const key = pos.segs.map((sg) => `${sg.kind}${sg.sec}`).join(',');
  if (key !== barKey) {
    barKey = key;
    el.workoutBar.innerHTML =
      '<div class="wb-track">' +
      pos.segs.map((sg) => `<span class="wb-seg seg-${sg.kind}" style="flex-grow:${sg.sec}"></span>`).join('') +
      '<div class="wb-past"></div></div><div class="wb-dot"></div>';
  }
  const at = `${(pos.elapsed / pos.total) * 100}%`;
  (el.workoutBar.querySelector('.wb-past') as HTMLElement).style.width = at;
  const dot = el.workoutBar.querySelector('.wb-dot') as HTMLElement;
  dot.style.left = at;
  dot.className = `wb-dot seg-${pos.seg.kind}`;
}

const videoBanner = $('video-banner');
let videoBannerTimer = 0;
function showVideoBanner(title: string, sub: string, ms: number) {
  videoBanner.innerHTML = `${title}<small>${sub}</small>`;
  videoBanner.hidden = false;
  clearTimeout(videoBannerTimer);
  videoBannerTimer = window.setTimeout(() => (videoBanner.hidden = true), ms);
}

/** Videos play from the start of the session through the cool-down, and pause when it ends. */
function followSessionWithVideo(zone: Zone, active: boolean) {
  const phase = session.phase;
  if (phase !== videoPhase) {
    const was = videoPhase;
    videoPhase = phase;
    if (phase === 'warmup' || (phase === 'main' && was !== 'warmup')) {
      if (videoPref && !videoView) setVideoView(true);
      if (videoView) video.play();
    } else if (phase === 'cooldown') {
      if (videoView) showVideoBanner('Workout done!', 'Cool-down: keep rowing easily', 10_000);
    } else if (phase === 'done' || phase === 'idle') {
      video.pause();
    }
  }
  // Turn the video down while an alarm sounds.
  video.duck(zone === 'over' || (zone === 'nosignal' && active));
}

setVideoView(videoPref);

// ---------- Misc ----------
$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});
window.addEventListener('resize', () => {
  drawForceCurves(el.forceChart, curves);
  if (!el.progressOverlay.hidden) showProgress();
});
// Unlock audio on the first tap anywhere (browsers block sound until then).
window.addEventListener('pointerdown', () => alarm.unlock(), { once: true });

// ---------- Diagnostics ----------
let diagMessage = '';

function renderDiag() {
  el.diagRec.hidden = !diag.active;
  el.diagToggle.textContent = diag.active ? 'Stop and save' : 'Start recording';
  if (diag.active) {
    el.diagStatus.textContent = `Recording for ${fmtTime(diag.elapsedSec)}, ${diag.entryCount.toLocaleString()} entries.`;
  } else {
    el.diagStatus.textContent = diagMessage || 'Not recording.';
  }
}

function startDiagnostics() {
  diagMessage = '';
  diag.start({
    source: source?.name ?? 'none',
    connection: el.connText.textContent,
    phase: session.phase,
    url: location.href,
  });
  renderDiag();
}

function openDiagnostics() {
  el.settingsDialog.close();
  renderDiag();
  el.diagDialog.showModal();
}

el.diagToggle.addEventListener('click', async () => {
  if (!diag.active) return startDiagnostics();
  const data = diag.stop();
  diagMessage = 'Saving…';
  renderDiag();
  el.diagToggle.disabled = true;
  const saved = await saveDiagnostics(data);
  el.diagToggle.disabled = false;
  diagMessage =
    'file' in saved
      ? `Saved as ${saved.file} in ~/rowing-backups/diagnostics. It goes to Google Drive (rowing-backups/diagnostics) if rclone is set up.`
      : `Not saved to the backups folder: ${saved.reason}. The file was downloaded to ~/Downloads as ${saved.downloaded} instead.`;
  renderDiag();
});
$('btn-diag-close').addEventListener('click', () => el.diagDialog.close());
$('btn-diag-settings').addEventListener('click', openDiagnostics);
$('btn-diag-connect').addEventListener('click', openDiagnostics);
el.diagRec.addEventListener('click', openDiagnostics);
// Records the whole connection sequence: drop the monitor and connect again from scratch.
$('btn-diag-reconnect').addEventListener('click', async () => {
  diag.log('manual-reconnect');
  el.diagDialog.close();
  if (await PM4Source.hasGrantedDevice()) {
    await useSource(new PM4Source(), false).catch(() => (el.connectOverlay.hidden = true));
  } else {
    el.connectOverlay.hidden = false;
  }
});
diag.onChange(renderDiag);
setInterval(() => diag.active && renderDiag(), 1000);
// Opening the app with ?diag starts recording before anything connects.
if (new URLSearchParams(location.search).has('diag')) startDiagnostics();

// ---------- Startup ----------
layoutZoneBar();
drawForceCurves(el.forceChart, curves);
setInterval(update, 250);
update();
void scheduleNextReminder();
// Debug helper in the browser console: rowing.history() lists saved sessions.
(window as any).rowing = { history: loadHistory, trainer };

(async () => {
  await offerRestoreIfEmpty();
  checkBirthday();
  const params = new URLSearchParams(location.search);
  if (params.has('sim')) {
    await useSource(new SimulatorSource(), false);
  } else if (await PM4Source.hasGrantedDevice()) {
    // USB permission was granted before: reconnect without asking (e.g. after a reboot).
    await useSource(new PM4Source(), false).catch(() => {
      el.connectOverlay.hidden = true; // PM4 source keeps retrying in the background
    });
  } else if ('hid' in navigator) {
    // The monitor is asleep (a sleeping PM disappears from USB). Connect as soon as it is woken up,
    // without a tap, as long as nothing else was chosen on the connect screen in the meantime.
    const hid = (navigator as any).hid;
    const onWake = async () => {
      if (source || !(await PM4Source.hasGrantedDevice())) return;
      hid.removeEventListener('connect', onWake);
      await useSource(new PM4Source(), false).catch(() => (el.connectOverlay.hidden = true));
    };
    hid.addEventListener('connect', onWake);
  }
})();
