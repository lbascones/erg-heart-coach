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
import { drawForceCurves, drawHrChart, type HrPoint } from './charts';
import { HeartRateTracker, ZONE_LABEL, type Zone } from './heartrate';
import { remindersEnabled, scheduleReminder, sendTestNotification } from './notify';
import { attachTooltips, renderProgress } from './progress';
import { loadHistory, Session, updateSession, type Phase, type SessionSummary } from './session';
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
  type Settings,
} from './settings';
import { PM4Source } from './sources/pm4';
import { SimulatorSource } from './sources/simulator';
import type { ConnectionStatus, RowerSample, RowerSource } from './sources/source';
import {
  applyLayoff,
  dayNumber,
  daysSinceLastSession,
  dayToDate,
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
let welcomeBack = applyLayoff(trainer, Date.now());
/** Shown on the home screen after a birthday moved the estimated heart-rate limits. */
let birthdayNotice: string | null = null;
let source: RowerSource | null = null;
let lastSample: RowerSample | null = null;
const hrPoints: HrPoint[] = [];
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
  phaseTimer: $('phase-timer'),
  phaseActions: $('phase-actions'),
  hrChart: $<HTMLCanvasElement>('hr-chart'),
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
    hrPoints.push({ t, hr: bpm });
    const cutoff = t - 15 * 60_000;
    while (hrPoints.length && hrPoints[0].t < cutoff) hrPoints.shift();
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
  warmup: 'Warm-up',
  main: 'Workout',
  cooldown: 'Cool-down',
  recovery: 'Recovery check',
  done: 'Done',
};

type ActionButton = [label: string, fn: () => void, cls?: string, disabled?: boolean];
let renderedActionsKey = '';

function renderPhaseActions(today: Today, hasHr: boolean) {
  const key = `${session.phase}|${today.kind}|${hasHr}|${session.plan.type}`;
  if (key === renderedActionsKey) return;
  renderedActionsKey = key;
  el.phaseName.textContent =
    session.phase === 'main' && session.plan.type === 'check' ? 'Fitness check' : PHASE_TITLE[session.phase];

  const buttons: ActionButton[] = [];
  switch (session.phase) {
    case 'idle':
      if (today.kind === 'row') {
        buttons.push(["Start today's session", () => startSession(today.plan), 'primary huge', !hasHr]);
      } else if (today.kind === 'rest' || today.kind === 'done-today') {
        buttons.push(['Row anyway (free row)', () => startSession(freePlan()), '', !hasHr]);
      } else if (today.kind === 'paused') {
        buttons.push(['My doctor has cleared me', resumeTrainer]);
      }
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
    case 'recovery':
      buttons.push(['Skip', () => session.finish()]);
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
  session.start(plan);
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
            birthdayNotice ||
            welcomeBack ||
            shortBreak ||
            `Plus ${s.warmupMinutes} min warm-up and ${s.cooldownMinutes} min cool-down. Heart rate OK, ready when you are.`,
        ];
      default:
        return [today.text, waiting || birthdayNotice || welcomeBack || ''];
    }
  }

  if (zone === 'nosignal') return ['No heart rate! Check the strap. Row very gently until it comes back.', ''];

  switch (session.phase) {
    case 'warmup':
      return zone === 'easy'
        ? [`Warm up gently. Stay below ${s.targetLow} bpm.`, '']
        : [`Warming up: ease off a little, stay below ${s.targetLow} bpm for now.`, ''];
    case 'main':
      if (session.plan.type === 'check') {
        const hr = session.plan.testHr!;
        if (zone === 'easy') return [`Fitness check: gently build up to ${hr} bpm.`, 'Steady and smooth, no sprints.'];
        if (zone === 'target') return [`Hold it right here: ${hr} bpm.`, 'The last 5 minutes are scored.'];
        return [`Ease off slightly: aim for ${hr} bpm.`, ''];
      }
      if (zone === 'easy') return [`Gently pick up the pace to reach ${range} bpm.`, ''];
      if (zone === 'target') return ['Good! Hold this effort.', ''];
      return [`Ease off a little: back under ${s.targetHigh} bpm.`, ''];
    case 'cooldown':
      return ['Cool down: easy strokes, let your heart rate come down.', ''];
    case 'recovery':
      return ['Stop rowing and sit still. Measuring heart-rate recovery…', ''];
    default:
      return ['', ''];
  }
}

// ---------- Main update loop ----------
let lastSessionTick = 0;
let lastChartDraw = 0;
let lastLayoffCheck = Date.now();

function update() {
  const now = Date.now();

  // During a fitness check's main part, "target" means a narrow band around the test HR.
  const checking = session.phase === 'main' && session.plan.type === 'check' && session.plan.testHr;
  tracker.setTargetOverride(checking ? { low: session.plan.testHr! - 3, high: session.plan.testHr! + 3 } : null);
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
  el.hrZoneLabel.textContent = checking && zone === 'target' ? 'On test heart rate' : ZONE_LABEL[zone];
  positionZoneMarker(zone === 'nosignal' ? null : tracker.bpm);

  // Alarms and banner
  const active = session.phase !== 'idle' && session.phase !== 'done';
  alarm.update(zone, active);
  if (zone === 'over') showBanner('over', `HEART RATE ${tracker.bpm}: EASE OFF`);
  else if (zone === 'nosignal' && active) showBanner('nosignal', 'NO HEART RATE SIGNAL');
  else el.banner.hidden = true;

  // Rowing numbers (blank them if data stops coming, e.g. monitor asleep)
  const fresh = lastSample && now - lastSample.time < 5000 ? lastSample : null;
  el.pace.textContent = fresh ? fmtPace(fresh.pace) : '--';
  el.power.textContent = fresh?.power ? String(fresh.power) : '--';
  el.spm.textContent = fresh?.spm ? String(fresh.spm) : '--';
  el.distance.textContent = session.phase === 'idle' ? '--' : `${Math.round(session.distance)} m`;
  el.time.textContent =
    session.phase === 'idle'
      ? '--'
      : fmtTime(((session.rowingPhase ? now : session.phaseStartedAt) - session.startedAt) / 1000);
  el.cal.textContent = session.phase === 'idle' ? '--' : String(Math.round(session.calories));

  // Guidance strip and coach
  const today = planToday(trainer, settings, now);
  renderPhaseActions(today, zone !== 'nosignal');
  const [main, sub] = guidance(zone, today);
  el.guideText.textContent = main;
  el.guideText.classList.toggle('coach', session.phase === 'idle');
  el.guideSub.textContent = sub;
  el.guideSub.hidden = !sub;
  const clock = session.phaseClock(now);
  el.phaseTimer.textContent = session.phase === 'idle' || session.phase === 'done' ? '' : fmtTime(clock.seconds);

  if (source instanceof SimulatorSource) {
    el.simEffort.textContent = `effort ${Math.round(source.effort * 100)}%${source.rowing ? '' : ' (stopped)'}${source.hrSignal ? '' : ' (HR off)'}`;
  }

  if (now - lastChartDraw >= 1000) {
    lastChartDraw = now;
    drawHrChart(el.hrChart, hrPoints, settings, now);
  }
}

function showBanner(kind: 'over' | 'nosignal', text: string) {
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
  const lvl = levelInfo(trainer.level);
  const msg =
    today.kind === 'row' && today.plan.type === 'check'
      ? 'Fitness check day: 10 minutes at a steady heart rate. Your rowing display is ready when you are.'
      : `Rowing day: ${lvl.mainMin} minutes in your zone, plus warm-up and cool-down.`;
  try {
    await scheduleReminder(settings, when, msg);
  } catch (err) {
    console.warn('Could not schedule reminder', err);
  }
}

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
  f.birthDate.max = localIsoDate(new Date());
  f.sound.checked = s.sound;
  f.ntfyTopic.value = s.ntfyTopic;
  f.ntfyServer.value = s.ntfyServer;
  formAge = ageOn(s.birthDate) ?? s.limitsFromAge;
  showFormAge(ageOn(s.birthDate));
}

function readForm(): Settings {
  const f = el.settingsForm.elements as any;
  const out: any = {
    birthDate: f.birthDate.value,
    limitsFromAge: settings.limitsFromAge, // worked out again on save
    sound: f.sound.checked,
    ntfyTopic: f.ntfyTopic.value.trim(),
    ntfyServer: f.ntfyServer.value.trim(),
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
  drawHrChart(el.hrChart, hrPoints, settings, Date.now());
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
  fillForm({ ...current, ...defaultsForAge(age) });
});
// Changing the birth date keeps estimated limits in step; hand-entered limits are left alone.
(el.settingsForm.elements.namedItem('birthDate') as HTMLInputElement).addEventListener('change', () => {
  const current = readForm();
  const age = ageOn(current.birthDate);
  showFormAge(age);
  if (age === null || age < 10 || age > 110) return;
  if (formAge !== null && formAge !== age && limitsMatchAge(current, formAge)) {
    fillForm({ ...current, ...defaultsForAge(age) });
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
  const drop = s.hrAtStop && s.hrAfterRecovery ? s.hrAtStop - s.hrAfterRecovery : null;
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
      ${tile('HR drop in 60 s', drop !== null ? `${drop} bpm` : '--')}
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
  el.summaryDialog.showModal();
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
};
attachTooltips([progressEls.check, progressEls.target, progressEls.recovery, progressEls.weekly], el.chartTip);

$('btn-progress').addEventListener('click', () => {
  el.progressOverlay.hidden = false;
  showBackupStatus();
  requestAnimationFrame(() => renderProgress(progressEls, trainer));
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

// ---------- Misc ----------
$('btn-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
});
window.addEventListener('resize', () => {
  drawHrChart(el.hrChart, hrPoints, settings, Date.now());
  drawForceCurves(el.forceChart, curves);
  if (!el.progressOverlay.hidden) renderProgress(progressEls, trainer);
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
  }
})();
