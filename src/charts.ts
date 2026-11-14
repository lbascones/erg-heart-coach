import type { Settings } from './settings';

/** Sizes the canvas backing store to its on-screen size so lines stay sharp. */
function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface HrPoint {
  t: number;
  /** 0 = no signal */
  hr: number;
}

type Limits = Pick<Settings, 'targetLow' | 'targetHigh' | 'ceiling'>;

/**
 * Heart rate over the `windowMin` minutes up to `now`, drawn over the target zone and ceiling bands.
 * Time labels count back from now ("-4m"), or, with `fromStart`, up from the start ("4m").
 */
export function drawHrChart(
  canvas: HTMLCanvasElement,
  points: HrPoint[],
  s: Limits,
  now: number,
  windowMin = 10,
  fromStart = false,
) {
  const { ctx, w, h } = prepare(canvas);
  const padL = 44;
  const padR = 8;
  const padT = 8;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const lo = Math.min(60, s.targetLow - 20);
  const hi = Math.max(s.ceiling + 15, ...points.map((p) => p.hr));
  const y = (bpm: number) => padT + plotH - ((bpm - lo) / (hi - lo)) * plotH;
  const t0 = now - windowMin * 60_000;
  const x = (t: number) => padL + ((t - t0) / (windowMin * 60_000)) * plotW;

  // Bands: target zone (green) and above the ceiling (red).
  ctx.fillStyle = css('--band-target');
  ctx.fillRect(padL, y(s.targetHigh), plotW, y(s.targetLow) - y(s.targetHigh));
  ctx.fillStyle = css('--band-over');
  ctx.fillRect(padL, padT, plotW, y(s.ceiling) - padT);

  // Grid lines and labels at the important heart rates.
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const [bpm, color] of [
    [s.targetLow, '--text-muted'],
    [s.targetHigh, '--text-muted'],
    [s.ceiling, '--over'],
  ] as const) {
    ctx.strokeStyle = css(color);
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(bpm));
    ctx.lineTo(w - padR, y(bpm));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = css(color);
    ctx.fillText(String(bpm), padL - 6, y(bpm));
  }

  // Time labels.
  ctx.fillStyle = css('--text-muted');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  if (fromStart) {
    const step = windowMin <= 12 ? 2 : windowMin <= 30 ? 5 : 10;
    for (let m = 0; m <= windowMin; m += step) ctx.fillText(`${m}m`, x(t0 + m * 60_000), h - padB + 6);
  } else {
    for (let m = 0; m <= windowMin; m += 2) {
      ctx.fillText(m === windowMin ? 'now' : `-${windowMin - m}m`, x(t0 + m * 60_000), h - padB + 6);
    }
  }

  // The HR line; gaps where there was no signal.
  ctx.strokeStyle = css('--text');
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let drawing = false;
  for (const p of points) {
    if (p.t < t0) continue;
    if (p.hr <= 0) {
      drawing = false;
      continue;
    }
    if (!drawing) ctx.moveTo(x(p.t), y(p.hr));
    else ctx.lineTo(x(p.t), y(p.hr));
    drawing = true;
  }
  ctx.stroke();
}

/** Latest force curve in bold, the previous few faded, so you can see stroke consistency. */
export function drawForceCurves(canvas: HTMLCanvasElement, curves: number[][]) {
  const { ctx, w, h } = prepare(canvas);
  const pad = 10;
  if (!curves.length) {
    ctx.fillStyle = css('--text-muted');
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Start rowing to see your force curve', w / 2, h / 2);
    return;
  }
  const peak = Math.max(50, ...curves.flat());
  const accent = css('--accent');
  curves.forEach((curve, i) => {
    const latest = i === curves.length - 1;
    ctx.strokeStyle = latest ? accent : css('--text-muted');
    ctx.globalAlpha = latest ? 1 : 0.15 + (0.35 * i) / curves.length;
    ctx.lineWidth = latest ? 4 : 2;
    ctx.beginPath();
    curve.forEach((v, j) => {
      const px = pad + (j / Math.max(1, curve.length - 1)) * (w - 2 * pad);
      const py = h - pad - (v / peak) * (h - 2 * pad);
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

/** A whole session's heart rate (one reading every `stepSec` seconds), for the wrap-up. */
export function drawSessionHr(canvas: HTMLCanvasElement, trace: number[], s: Limits, stepSec = 5) {
  const points = trace.map((hr, i) => ({ t: i * stepSec * 1000, hr }));
  const end = Math.max(1, trace.length - 1) * stepSec * 1000;
  drawHrChart(canvas, points, s, end, end / 60_000, true);
}
