import { loadHistory, type SessionSummary } from './session';
import { dayNumber, dayToDate, GOOD_TO_LEVEL_UP, levelInfo, LEVELS, type TrainerState } from './trainer';

/** A plotted point plus the text its tooltip shows. */
interface Point {
  t: number;
  v: number;
  tip: string;
}

interface Hit {
  x: number;
  y: number;
  tip: string;
}
const hits = new Map<HTMLCanvasElement, Hit[]>();

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function prepare(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '13px system-ui, sans-serif';
  return { ctx, w, h };
}

function emptyState(canvas: HTMLCanvasElement, text: string) {
  const { ctx, w, h } = prepare(canvas);
  hits.set(canvas, []);
  ctx.fillStyle = css('--text-muted');
  ctx.font = '16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

/** "Nice" axis bounds and ticks so labels are round numbers. */
function niceScale(min: number, max: number, ticks = 4) {
  if (min === max) {
    min -= 5;
    max += 5;
  }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(v);
  return { lo, hi, ticks: out };
}

/** One series over time: 2px line, 8px markers, light grid, date labels, hover tooltips. */
function lineChart(canvas: HTMLCanvasElement, pts: Point[], empty: string, zeroBased = false) {
  if (pts.length === 0) return emptyState(canvas, empty);
  const { ctx, w, h } = prepare(canvas);
  const padL = 44, padR = 16, padT = 12, padB = 26;
  const vs = pts.map((p) => p.v);
  const { lo, hi, ticks } = niceScale(zeroBased ? 0 : Math.min(...vs) * 0.9, Math.max(...vs) * 1.05);
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => (pts.length === 1 ? padL + (w - padL - padR) / 2 : padL + ((t - t0) / span) * (w - padL - padR));
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);

  // Recessive grid and y labels.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ticks) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(w - padR, y(v));
    ctx.stroke();
    ctx.fillStyle = css('--text-muted');
    ctx.fillText(String(Math.round(v)), padL - 8, y(v));
  }
  // Date labels: first and last (and middle if there is room).
  ctx.textBaseline = 'top';
  const labelIdx = pts.length > 2 ? [0, Math.floor(pts.length / 2), pts.length - 1] : pts.map((_, i) => i);
  labelIdx.forEach((i, k) => {
    ctx.textAlign = labelIdx.length > 1 && k === 0 ? 'left' : k === labelIdx.length - 1 && labelIdx.length > 1 ? 'right' : 'center';
    ctx.fillText(fmtDate(pts[i].t), x(pts[i].t), h - padB + 8);
  });

  // Line.
  const accent = css('--accent');
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
  ctx.stroke();

  // Markers with a surface ring, and remember them for hover.
  const list: Hit[] = [];
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(x(p.t), y(p.v), 4, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#151a21';
    ctx.stroke();
    list.push({ x: x(p.t), y: y(p.v), tip: p.tip });
  }
  // Direct label on the latest value only.
  const last = pts[pts.length - 1];
  ctx.fillStyle = css('--text');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillText(String(Math.round(last.v)), Math.min(w - padR, x(last.t) + 4), y(last.v) - 8);
  hits.set(canvas, list);
}

/** Weekly minutes as bars, with the current level's weekly goal as a dashed line. */
function weeklyChart(canvas: HTMLCanvasElement, weeks: { start: number; minutes: number }[], goal: number) {
  const { ctx, w, h } = prepare(canvas);
  const padL = 44, padR = 16, padT = 12, padB = 26;
  const { lo, hi, ticks } = niceScale(0, Math.max(goal * 1.15, ...weeks.map((wk) => wk.minutes)));
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  const slot = (w - padL - padR) / weeks.length;
  const barW = Math.max(4, slot - 2); // 2px surface gap between bars

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of ticks) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(w - padR, y(v));
    ctx.stroke();
    ctx.fillStyle = css('--text-muted');
    ctx.fillText(String(v), padL - 8, y(v));
  }

  const list: Hit[] = [];
  const accent = css('--accent');
  weeks.forEach((wk, i) => {
    const bx = padL + i * slot + 1;
    const top = y(wk.minutes);
    const bh = y(0) - top;
    if (bh > 0) {
      const r = Math.min(4, bh, barW / 2);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(bx, y(0));
      ctx.lineTo(bx, top + r);
      ctx.quadraticCurveTo(bx, top, bx + r, top);
      ctx.lineTo(bx + barW - r, top);
      ctx.quadraticCurveTo(bx + barW, top, bx + barW, top + r);
      ctx.lineTo(bx + barW, y(0));
      ctx.fill();
    }
    list.push({ x: bx + barW / 2, y: top, tip: `Week of ${fmtDate(wk.start)}: ${Math.round(wk.minutes)} min` });
    if (i % 3 === 0 || i === weeks.length - 1) {
      ctx.fillStyle = css('--text-muted');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(fmtDate(wk.start), bx + barW / 2, h - padB + 8);
    }
  });

  // Goal line, labeled directly.
  ctx.strokeStyle = css('--text');
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padL, y(goal));
  ctx.lineTo(w - padR, y(goal));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.fillStyle = css('--text');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`Goal at your level: ${goal} min`, padL + 6, y(goal) - 4);
  hits.set(canvas, list);
}

/** Shows the tooltip for the nearest point under the pointer (mouse or finger). */
export function attachTooltips(canvases: HTMLCanvasElement[], tip: HTMLElement) {
  for (const c of canvases) {
    const show = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left;
      const list = hits.get(c) ?? [];
      let best: Hit | null = null;
      for (const hpt of list) if (!best || Math.abs(hpt.x - px) < Math.abs(best.x - px)) best = hpt;
      if (!best || Math.abs(best.x - px) > 40) {
        tip.hidden = true;
        return;
      }
      tip.textContent = best.tip;
      tip.hidden = false;
      tip.style.left = `${r.left + best.x}px`;
      tip.style.top = `${r.top + best.y - 12}px`;
    };
    c.addEventListener('pointermove', show);
    c.addEventListener('pointerdown', show);
    c.addEventListener('pointerleave', () => (tip.hidden = true));
  }
}

function mondayOf(day: number): number {
  const dow = dayToDate(day).getDay(); // 0 = Sunday
  return day - ((dow + 6) % 7);
}

export interface ProgressEls {
  tiles: HTMLElement;
  testHr: HTMLElement;
  check: HTMLCanvasElement;
  target: HTMLCanvasElement;
  recovery: HTMLCanvasElement;
  weekly: HTMLCanvasElement;
}

export function renderProgress(els: ProgressEls, trainer: TrainerState) {
  const history = loadHistory().filter((s) => s.durationSec >= 60);
  const lvl = levelInfo(trainer.level);
  const now = Date.now();
  const today = dayNumber(now);

  // Weekly minutes, last 12 weeks.
  const thisMonday = mondayOf(today);
  const weeks = Array.from({ length: 12 }, (_, i) => ({ day: thisMonday - (11 - i) * 7, minutes: 0 }));
  for (const s of history) {
    const wk = weeks.find((x) => x.day === mondayOf(dayNumber(s.startedAt)));
    // Main-set minutes (warm-up and cool-down excluded), to compare with the level's plan.
    if (wk) wk.minutes += s.mainSec / 60;
  }

  const totalKm = history.reduce((a, s) => a + s.distance, 0) / 1000;
  const recoveries = history.filter(hasRecovery);
  const lastRec = recoveries.at(-1);
  const tile = (label: string, value: string, sub = '') =>
    `<div class="metric"><div class="m-label">${label}</div><div class="m-value">${value}</div><div class="m-sub">${sub}</div></div>`;
  els.tiles.innerHTML = [
    tile(
      'Level',
      `${trainer.level} <small>of ${LEVELS.length}</small>`,
      trainer.level < LEVELS.length ? `${trainer.goodStreak}/${GOOD_TO_LEVEL_UP} good sessions to next` : 'Top level',
    ),
    tile('Current plan', `${lvl.mainMin} min`, `${lvl.perWeek}× a week`),
    tile('This week', `${Math.round(weeks.at(-1)!.minutes)} min`, `goal ${lvl.perWeek * lvl.mainMin} min`),
    tile('Sessions', String(history.length), `${totalKm.toFixed(1)} km total`),
    tile('HR recovery', lastRec ? `${lastRec.hrAtStop - lastRec.hrAfterRecovery}` : '--', 'bpm drop in 60 s, latest'),
  ].join('');

  const checks = history.filter((s) => s.type === 'check' && s.checkWatts);
  els.testHr.textContent = String(trainer.testHr ?? checks.at(-1)?.testHr ?? '–');
  lineChart(
    els.check,
    checks.map((s) => ({ t: s.startedAt, v: s.checkWatts!, tip: `${fmtDate(s.startedAt)}: ${s.checkWatts} W at ${s.testHr} bpm` })),
    trainer.lastCheckAt === null ? 'Your first fitness check comes after a few sessions' : 'No scored checks yet',
  );
  lineChart(
    els.target,
    history
      .filter((s) => s.targetWatts > 0)
      .map((s) => ({ t: s.startedAt, v: s.targetWatts, tip: `${fmtDate(s.startedAt)}: ${s.targetWatts} W in target zone` })),
    'Appears after your first session with a minute or more in your zone',
  );
  lineChart(
    els.recovery,
    recoveries.map((s) => ({
      t: s.startedAt,
      v: s.hrAtStop - s.hrAfterRecovery,
      tip: `${fmtDate(s.startedAt)}: ${s.hrAtStop} → ${s.hrAfterRecovery} bpm (−${s.hrAtStop - s.hrAfterRecovery})`,
    })),
    'Finish a session with the 60 s recovery check to see this',
    true,
  );
  weeklyChart(
    els.weekly,
    weeks.map((wk) => ({ start: dayToDate(wk.day).getTime(), minutes: wk.minutes })),
    lvl.perWeek * lvl.mainMin,
  );
}

function hasRecovery(s: SessionSummary) {
  return s.hrAtStop > 0 && s.hrAfterRecovery > 0;
}
