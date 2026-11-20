/**
 * Mobility routine for after rowing: exercises that make the catch (the folded-up front of the stroke) easier.
 * Each step shows sketches (start → finish), a few cues and a timer for that side or exercise.
 * Each step waits for Start; a chime marks the start and end of every hold.
 * A "Demo video" button plays a short YouTube demonstration on request (never automatically).
 */

type P = [number, number];

// ---------- Progress, kept in localStorage and in the backups ----------
export const MOBILITY_KEY = 'rowing.mobility.v1';

export interface KneeWall {
  t: number;
  /** Inches from the wall to the big toe when the knee just touches the wall, heel down. */
  left: number;
  right: number;
}

export interface MobilityState {
  /** When each counted routine was finished (at most one per day). */
  completed: number[];
  kneeWall: KneeWall[];
}

export function loadMobility(): MobilityState {
  try {
    const s = JSON.parse(localStorage.getItem(MOBILITY_KEY) ?? 'null');
    if (s && Array.isArray(s.completed) && Array.isArray(s.kneeWall)) return s;
  } catch {
    /* fall through */
  }
  return { completed: [], kneeWall: [] };
}

function saveMobility(s: MobilityState) {
  try {
    localStorage.setItem(MOBILITY_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Holds start at each exercise's base time and get 5 s longer every 3 counted routines (about a week), up to 60 s. */
const HOLD_STEP_SEC = 5;
const ROUTINES_PER_STEP = 3;
const HOLD_MAX_SEC = 60;
export function holdBonus(s: MobilityState = loadMobility()): number {
  return HOLD_STEP_SEC * Math.floor(s.completed.length / ROUTINES_PER_STEP);
}

/** A knee-to-wall measurement is suggested when none was taken in this many days. */
const MEASURE_EVERY_DAYS = 28;
export function measureDue(s: MobilityState = loadMobility(), now = Date.now()): boolean {
  const last = s.kneeWall.at(-1);
  return !last || now - last.t >= MEASURE_EVERY_DAYS * 86_400_000;
}

const DAY_MS = 86_400_000;
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

const pt = ([x, y]: P) => `${x},${y}`;
/** Polyline path through the points. */
const L = (...pts: P[]) => `M${pts.map(pt).join(' L')}`;

/**
 * A stick figure with some body: a thick torso, near limbs in white and far limbs darker,
 * so crossing legs or arms stay readable.
 */
function fig(o: { head: P; torso: string; near?: P[][]; far?: P[][]; ghost?: boolean }): string {
  const far = (o.far ?? []).map((l) => `<path class="mb-limb-far" d="${L(...l)}"/>`).join('');
  const near = (o.near ?? []).map((l) => `<path class="mb-limb" d="${L(...l)}"/>`).join('');
  return (
    `<g class="mb-fig${o.ghost ? ' mb-ghost' : ''}">${far}<path class="mb-torso" d="${o.torso}"/>${near}` +
    `<circle cx="${o.head[0]}" cy="${o.head[1]}" r="14"/></g>`
  );
}

/** Where you should feel it: a thick translucent orange stroke or patch. */
const feelLine = (a: P, b: P) => `<path class="mb-feel" d="${L(a, b)}"/>`;
const feelSpot = ([x, y]: P, r = 16) => `<circle class="mb-feel-spot" cx="${x}" cy="${y}" r="${r}"/>`;
const arrow = (d: string) => `<path class="mb-arrow" d="${d}" marker-end="url(#mb-head)"/>`;
const arrow2 = (d: string) => `<path class="mb-arrow" d="${d}" marker-start="url(#mb-head)" marker-end="url(#mb-head)"/>`;

const floor = '<path class="mb-prop" d="M15,185 H285"/>';
/** The exercise mat, seen from above. */
const matTop = '<rect class="mb-mat" x="20" y="12" width="260" height="186" rx="12"/>';
const bench = (x: number, w: number, top: number) =>
  `<path class="mb-prop" d="M${x},${top} h${w} M${x + 8},${top} V185 M${x + w - 8},${top} V185"/>`;

export interface Panel {
  svg: string;
  caption: string;
}

export interface Exercise {
  name: string;
  /** Seconds to hold or repeat. */
  sec: number;
  /** Shown under the name, e.g. "8–10 slow rounds" or "Hold". */
  how: string;
  cues: string[];
  sides?: boolean;
  /** One sketch for a hold, or start → finish for a movement. */
  panels: Panel[];
  /** YouTube video id of a short demonstration. */
  video: string;
}

// ---------- Cat-cow (side view) ----------
const catLeg: P[] = [[100, 140], [100, 185], [55, 185], [42, 185]];
const catArm: P[] = [[190, 140], [190, 162], [190, 185]];

// ---------- Figure-4 (seen from above: lying on the back, head at the top) ----------
// Shoulders and hips are short bars; the left leg is the support leg, the right ankle crosses over the left knee.
const f4Torso = `M124,52 H172 M148,52 L148,112 M134,112 H162`;

export const ROUTINE: Exercise[] = [
  {
    name: 'Cat-cow',
    sec: 45,
    how: '8–10 slow rounds',
    cues: [
      'On hands and knees, hands under shoulders, knees under hips.',
      'Round your back up and let your head drop (cat).',
      'Then let your back sag and lift your head (cow). Move slowly with your breath.',
    ],
    video: 'iKQ-DHgti20',
    panels: [
      {
        caption: 'Cat: round up',
        svg:
          floor +
          arrow('M145,108 L145,78') +
          fig({ head: [206, 162], torso: 'M100,140 Q145,96 190,140', near: [catLeg, catArm, [[190, 140], [200, 152]]] }),
      },
      {
        caption: 'Cow: let it sag, head up',
        svg:
          floor +
          arrow('M145,118 L145,148') +
          fig({ head: [212, 120], torso: 'M100,140 Q145,176 190,140', near: [catLeg, catArm, [[190, 140], [203, 128]]] }),
      },
    ],
  },
  {
    name: 'Open book',
    sec: 30,
    how: 'Hold',
    sides: true,
    cues: [
      'Lie on your side, knees bent in front of you and together, both arms straight out in front.',
      'Sweep the top arm up and over toward the floor behind you, turning your chest open. Follow your hand with your eyes.',
      'Hold there and breathe, knees together on the floor. The arm does not need to reach the floor.',
    ],
    video: 'rDviWORCWEw',
    panels: [
      {
        caption: 'Seen from above: arms together in front',
        svg:
          matTop +
          fig({
            head: [58, 100],
            torso: L([80, 100], [178, 100]),
            near: [[[178, 100], [178, 152], [230, 152], [238, 144]], [[86, 100], [86, 130], [86, 162]], [[80, 100], [64, 100]]],
            far: [[[86, 100], [94, 132], [96, 164]]],
          }),
      },
      {
        caption: 'Top arm over to the other side: hold',
        svg:
          matTop +
          feelLine([96, 100], [130, 100]) +
          arrow('M70,170 A62,62 0 0,1 70,40') +
          fig({
            head: [58, 100],
            torso: `${L([80, 100], [178, 100])} M86,84 V116`,
            near: [[[178, 100], [178, 152], [230, 152], [238, 144]], [[86, 84], [86, 56], [86, 26]], [[80, 100], [64, 100]]],
            far: [[[86, 116], [94, 140], [96, 168]]],
          }),
      },
    ],
  },
  {
    name: 'Knee to wall',
    sec: 40,
    how: 'Hold',
    sides: true,
    cues: [
      'Kneel on one knee facing the wall, front foot a few inches from it, hands on the wall.',
      'Push the front knee toward the wall, keeping that heel flat on the floor, and hold.',
      'You should feel it in the calf and ankle. Next time, move the foot back a little if the knee touches easily.',
    ],
    video: 'CRgmHELYh3A',
    panels: [
      {
        caption: 'Knee toward the wall, heel down: hold',
        svg:
          floor +
          '<path class="mb-prop" d="M236,25 V185"/>' +
          feelLine([197, 182], [207, 162]) +
          arrow('M198,124 L226,124') +
          fig({
            head: [175, 58],
            torso: L([175, 136], [175, 76]),
            near: [[[175, 136], [224, 148], [197, 185], [218, 185]], [[175, 80], [204, 94], [232, 96]], [[175, 76], [175, 68]]],
            far: [[[175, 136], [150, 185], [108, 185], [98, 185]]],
          }),
      },
    ],
  },
  {
    name: 'Seated hamstring stretch',
    sec: 45,
    how: 'Hold',
    sides: true,
    cues: [
      'Sit on the edge of the bench, one leg straight out, heel on the floor, toes up.',
      'Lean forward from the hips with a flat back, chest toward the toes.',
      'Stop at a firm stretch behind the thigh, not pain. Breathe.',
    ],
    video: '6xjGh5BW-s4',
    panels: [
      {
        caption: 'Lean forward from the hips, back flat',
        svg:
          floor +
          bench(40, 112, 142) +
          feelLine([146, 142], [214, 176]) +
          arrow('M216,92 L236,122') +
          fig({
            head: [198, 88],
            torso: L([138, 136], [186, 100]),
            near: [[[138, 136], [184, 158], [228, 180], [234, 164]], [[184, 102], [200, 130], [212, 158]]],
            far: [[[138, 136], [176, 144], [170, 185], [190, 185]]],
          }),
      },
    ],
  },
  {
    name: 'Figure-4 stretch',
    sec: 45,
    how: 'Hold',
    sides: true,
    cues: [
      'Lie on your back, knees bent, feet flat. Cross one ankle over the other knee (it makes a "4").',
      'Lift the other foot, hold behind that thigh and pull it gently toward your chest.',
      'You should feel it in the buttock of the crossed leg.',
    ],
    video: '-g0nuyTHMrI',
    panels: [
      {
        caption: 'Seen from above: cross the ankle over the knee',
        svg:
          matTop +
          fig({
            head: [148, 32],
            torso: f4Torso,
            near: [
              [[162, 112], [218, 140], [142, 150]],
              [[124, 52], [112, 84], [108, 114]],
              [[172, 52], [184, 84], [190, 112]],
            ],
            far: [[[134, 112], [134, 152], [134, 190]]],
          }),
      },
      {
        caption: 'Pull the bottom thigh toward your chest',
        svg:
          matTop +
          feelSpot([166, 118]) +
          arrow('M110,160 L110,128') +
          fig({
            head: [148, 32],
            torso: f4Torso,
            near: [
              [[162, 112], [218, 118], [142, 128]],
              [[124, 52], [116, 96], [130, 138]],
              [[172, 52], [160, 98], [140, 138]],
            ],
            far: [[[134, 112], [134, 130], [134, 168]]],
          }),
      },
    ],
  },
  {
    name: 'Supported deep squat',
    sec: 45,
    how: 'Hold',
    cues: [
      'Hold a door frame or something sturdy, feet about hip-width apart.',
      'Sink down as low as is comfortable, heels down, chest up.',
      'Use your hands to take as much weight as you need.',
    ],
    video: 'etggfSMrnY8',
    panels: [
      {
        caption: 'Sink down, holding on, heels down',
        svg:
          floor +
          '<rect class="mb-prop" x="228" y="20" width="10" height="165"/>' +
          feelSpot([130, 160]) +
          fig({
            head: [158, 86],
            torso: L([128, 164], [154, 104]),
            near: [[[128, 164], [182, 140], [154, 185], [176, 185]], [[154, 106], [194, 104], [228, 110]]],
          }),
      },
    ],
  },
  {
    name: 'Squat to bench',
    sec: 45,
    how: '8–10 slow reps',
    cues: [
      'Stand in front of the bench, feet hip-width, arms forward.',
      'Sit back slowly until you just touch the bench, then stand up.',
      'Knees follow your toes; heels stay down.',
    ],
    video: 'w2jbtOQ_bdM',
    panels: [
      {
        caption: 'Stand in front of the bench',
        svg:
          floor +
          bench(58, 76, 142) +
          fig({
            head: [162, 24],
            torso: L([160, 102], [161, 40]),
            near: [[[160, 102], [161, 144], [160, 185], [180, 185]], [[161, 44], [182, 60], [206, 60]]],
          }),
      },
      {
        caption: 'Sit back to touch, then stand',
        svg:
          floor +
          bench(58, 76, 142) +
          arrow2('M100,84 L100,128') +
          fig({
            head: [170, 68],
            torso: L([134, 136], [162, 84]),
            near: [[[134, 136], [182, 134], [164, 185], [184, 185]], [[162, 86], [190, 92], [216, 92]]],
          }),
      },
    ],
  },
  {
    name: 'Glute bridge',
    sec: 50,
    how: '10 slow reps, 2 s pause at the top',
    cues: [
      'Lie on your back, knees bent, feet flat, arms by your sides.',
      'Squeeze your buttocks and lift your hips until your body is a straight line.',
      'Hold 2 seconds at the top, then lower slowly. Lift with your buttocks, not by arching your back.',
    ],
    video: 'CPb8yRUxWBQ',
    panels: [
      {
        caption: 'Lie with knees bent',
        svg:
          floor +
          fig({
            head: [44, 170],
            torso: L([66, 176], [140, 177]),
            near: [[[140, 177], [182, 138], [196, 183], [214, 183]], [[66, 176], [100, 182], [128, 182]]],
          }),
      },
      {
        caption: 'Lift into a straight line, pause 2 s',
        svg:
          floor +
          feelSpot([140, 146]) +
          arrow('M166,178 L166,148') +
          fig({
            head: [44, 170],
            torso: L([66, 176], [140, 140]),
            near: [[[140, 140], [186, 130], [196, 183], [214, 183]], [[66, 176], [100, 182], [128, 182]]],
          }),
      },
    ],
  },
];

const DEFS =
  '<defs><marker id="mb-head" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">' +
  '<path d="M0,0 L10,5 L0,10 z" class="mb-arrowhead"/></marker></defs>';

/** The sketches of one exercise as HTML; the right side is drawn as a mirror image of the left. */
export function sketchHtml(ex: Exercise, mirror = false): string {
  const flip = mirror ? ' transform="translate(300,0) scale(-1,1)"' : '';
  const numbered = ex.panels.length > 1;
  return ex.panels
    .map(
      (p, i) =>
        `<figure class="mb-panel"><svg viewBox="0 0 300 210" role="img" aria-label="${p.caption}">${DEFS}<g${flip}>${p.svg}</g></svg>` +
        `<figcaption>${numbered ? `<b>${i + 1}</b> ` : ''}${p.caption}</figcaption></figure>`,
    )
    .join('');
}

/** Seconds for an exercise today: holds include the progression, reps stay as planned. */
export function secFor(ex: Exercise, s: MobilityState = loadMobility()): number {
  return ex.how === 'Hold' ? Math.min(HOLD_MAX_SEC, Math.max(ex.sec, ex.sec + holdBonus(s))) : ex.sec;
}

/** One timed step: an exercise, on one side or both. */
interface Step {
  ex: Exercise;
  side: 'left' | 'right' | null;
}

const STEPS: Step[] = ROUTINE.flatMap((ex): Step[] =>
  ex.sides ? [{ ex, side: 'left' }, { ex, side: 'right' }] : [{ ex, side: null }],
);

/** Seconds to get into position after pressing Start. */
const READY_SEC = 5;

/** About how long the routine takes, including getting into position. */
export function routineMinutes(): number {
  const s = loadMobility();
  return Math.round(STEPS.reduce((n, st) => n + secFor(st.ex, s) + READY_SEC + 10, 0) / 60);
}

/**
 * Runs the routine in the #mobility-overlay screen.
 * Every step (and every side) waits for Start, since you may need to move to the mat, the wall or the bench.
 * After Start: a short "get into position" countdown, then the timer for that side (or the whole exercise).
 */
export class MobilityRoutine {
  private i = 0;
  private phase: 'waiting' | 'ready' | 'hold' | 'done' = 'waiting';
  private left = 0;
  private paused = false;
  /** The demo video is showing; the timer is paused meanwhile and resumes as it was when the video closes. */
  private demo = false;
  private pausedBeforeDemo = false;
  private lastTick = 0;
  private timer = 0;
  /** Holds finished on their own clock in this run; the routine counts toward progress at half of the steps. */
  private holdsDone = 0;
  private counted = false;
  /** Knee-to-wall form on the end screen: shown when due, or when asked for. */
  private measuring = false;
  private measureSaved = false;
  private readonly $ = (id: string) => document.getElementById(id) as HTMLElement;

  /** @param onChange called after progress is saved (to back it up). */
  constructor(
    private chime: () => void,
    private onChange: () => void = () => {},
  ) {
    this.$('mb-extra').addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.id === 'btn-mb-measure') {
        this.measuring = true;
        this.render();
      } else if (t.id === 'btn-mb-measure-save') {
        this.saveMeasurement();
      }
    });
    this.$('btn-mb-back').addEventListener('click', () => this.go(this.i - 1));
    this.$('btn-mb-next').addEventListener('click', () => (this.phase === 'done' ? this.close() : this.go(this.i + 1)));
    this.$('btn-mb-start').addEventListener('click', () => {
      if (this.phase === 'waiting') {
        this.setDemo(false, false);
        this.phase = 'ready';
        this.left = READY_SEC;
        this.paused = false;
      } else {
        this.paused = !this.paused;
      }
      this.render();
    });
    this.$('btn-mb-demo').addEventListener('click', () => this.setDemo(!this.demo));
    this.$('btn-mb-end').addEventListener('click', () => this.close());
  }

  open() {
    this.$('mobility-overlay').hidden = false;
    this.holdsDone = 0;
    this.counted = false;
    this.measureSaved = false;
    this.measuring = false;
    this.go(0);
    this.lastTick = Date.now();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 200);
  }

  close() {
    this.setDemo(false, false);
    clearInterval(this.timer);
    this.$('mobility-overlay').hidden = true;
  }

  private setDemo(on: boolean, render = true) {
    if (on === this.demo) return;
    this.demo = on;
    if (on) {
      this.pausedBeforeDemo = this.paused;
      this.paused = true;
      const id = STEPS[this.i].ex.video;
      this.$('mb-sketch').innerHTML =
        `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1" ` +
        'title="Demo video" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
    } else {
      this.paused = this.pausedBeforeDemo;
      this.$('mb-sketch').innerHTML = '';
    }
    if (render) this.render();
  }

  /** Shows step i, waiting for Start. */
  private go(i: number) {
    this.setDemo(false, false);
    if (i < 0) i = 0;
    if (i >= STEPS.length) {
      this.phase = 'done';
      this.finish();
    } else {
      this.i = i;
      this.phase = 'waiting';
      this.left = secFor(STEPS[i].ex);
    }
    this.paused = false;
    this.render();
  }

  private tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    if (this.paused || (this.phase !== 'ready' && this.phase !== 'hold')) return;
    this.left -= dt;
    if (this.left > 0) return this.renderTimer();
    this.chime();
    if (this.phase === 'ready') {
      this.phase = 'hold';
      this.left = secFor(STEPS[this.i].ex);
      this.render();
    } else {
      this.holdsDone++;
      this.go(this.i + 1);
    }
  }

  /** End of the routine: count it (once a day, if at least half was done) and offer the measurement when due. */
  private finish() {
    const s = loadMobility();
    const now = Date.now();
    if (!this.counted && this.holdsDone >= Math.ceil(STEPS.length / 2) && !s.completed.some((t) => sameDay(t, now))) {
      s.completed.push(now);
      saveMobility(s);
      this.counted = true;
      this.onChange();
    }
    this.measuring = measureDue(s, now);
  }

  private saveMeasurement() {
    const read = (id: string) => parseFloat((this.$(id) as HTMLInputElement).value);
    const left = read('mb-kw-left');
    const right = read('mb-kw-right');
    const ok = (v: number) => Number.isFinite(v) && v >= 0 && v <= 12;
    if (!ok(left) || !ok(right)) {
      this.$('mb-kw-msg').textContent = 'Enter both sides in inches (0 to 12, e.g. 3.5).';
      return;
    }
    const s = loadMobility();
    s.kneeWall.push({ t: Date.now(), left, right });
    saveMobility(s);
    this.measuring = false;
    this.measureSaved = true;
    this.onChange();
    this.render();
  }

  /** The end screen: what changes next time, and the knee-to-wall measurement. */
  private renderDone() {
    const s = loadMobility();
    const toNext = ROUTINES_PER_STEP - (s.completed.length % ROUTINES_PER_STEP);
    const holdTimes = ROUTINE.filter((e) => e.how === 'Hold').map((e) => secFor(e, s));
    const lo = Math.min(...holdTimes);
    const hi = Math.max(...holdTimes);
    const lines: string[] = [];
    lines.push(this.counted ? `Routines done: ${s.completed.length}.` : `Routines done: ${s.completed.length} (this one did not count: less than half was timed, or one was already counted today).`);
    lines.push(
      hi >= HOLD_MAX_SEC && lo >= HOLD_MAX_SEC
        ? 'Holds are at the full 60 s.'
        : `Holds now: ${lo === hi ? `${lo}` : `${lo}–${hi}`} s. They get ${HOLD_STEP_SEC} s longer after ${toNext} more routine${toNext === 1 ? '' : 's'}.`,
    );
    const last = s.kneeWall.at(-1);
    const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    let measure = '';
    if (this.measuring) {
      measure =
        '<div class="mb-measure"><h3>Knee-to-wall measurement</h3>' +
        '<p>Set up as in the knee-to-wall exercise. Move the front foot back until the knee only just touches the wall with the heel flat. ' +
        'Measure from the wall to the tip of the big toe.</p>' +
        '<div class="mb-kw-inputs"><label>Left (in) <input id="mb-kw-left" type="number" step="0.25" min="0" max="12" inputmode="decimal"></label>' +
        '<label>Right (in) <input id="mb-kw-right" type="number" step="0.25" min="0" max="12" inputmode="decimal"></label>' +
        '<button id="btn-mb-measure-save" class="primary">Save</button></div><p id="mb-kw-msg" class="fine-print"></p></div>';
    } else {
      const lastText = last
        ? `Knee to wall, ${fmt(last.t)}: left ${last.left} in, right ${last.right} in.`
        : 'No knee-to-wall measurement yet.';
      const nextText = last ? ` Next suggested around ${fmt(last.t + MEASURE_EVERY_DAYS * DAY_MS)}.` : '';
      measure =
        `<p>${this.measureSaved ? 'Saved. ' : ''}${lastText}${nextText}</p>` +
        '<button id="btn-mb-measure" class="small">Measure knee to wall now</button>';
    }
    this.$('mb-extra').innerHTML = `${lines.map((l) => `<p>${l}</p>`).join('')}${measure}`;
  }

  private renderTimer() {
    const s = Math.max(0, Math.ceil(this.left));
    this.$('mb-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  private render() {
    const done = this.phase === 'done';
    const overlay = this.$('mobility-overlay');
    overlay.classList.toggle('mb-waiting', this.phase === 'waiting' || this.phase === 'ready');
    overlay.classList.toggle('mb-done', done);
    overlay.classList.toggle('mb-demo', this.demo);
    const start = this.$('btn-mb-start');
    this.$('btn-mb-back').hidden = done;
    start.hidden = done;
    this.$('btn-mb-demo').hidden = done;
    this.$('btn-mb-demo').textContent = this.demo ? 'Close video' : 'Demo video';
    this.$('btn-mb-next').textContent = done ? 'Close' : 'Skip';
    this.$('btn-mb-next').classList.toggle('primary', done);
    const waiting = this.phase === 'waiting';
    start.textContent = waiting ? 'Start' : this.paused ? 'Resume' : 'Pause';
    start.classList.toggle('primary', waiting || this.paused);
    if (done) {
      this.$('mb-step').textContent = 'Mobility';
      this.$('mb-name').textContent = 'Routine complete';
      for (const id of ['mb-side', 'mb-how', 'mb-cues', 'mb-sketch', 'mb-timer-label', 'mb-timer', 'mb-next']) {
        this.$(id).innerHTML = '';
      }
      this.renderDone();
      return;
    }
    this.$('mb-extra').innerHTML = '';
    const { ex, side } = STEPS[this.i];
    const sideName = side ? (side === 'left' ? 'left side' : 'right side') : '';
    this.$('mb-step').textContent = `Step ${this.i + 1} of ${STEPS.length}`;
    this.$('mb-name').textContent = ex.name;
    this.$('mb-side').textContent = side ? (side === 'left' ? 'Left side' : 'Right side') : '';
    this.$('mb-how').textContent = `${ex.how} · ${secFor(ex)} s${ex.sides ? ' each side' : ''}`;
    this.$('mb-cues').innerHTML = ex.cues.map((c) => `<li>${c}</li>`).join('');
    if (!this.demo) this.$('mb-sketch').innerHTML = sketchHtml(ex, side === 'right');
    const scope = side ? sideName : 'this exercise';
    this.$('mb-timer-label').textContent = this.demo
      ? 'Paused for the video'
      : waiting
        ? `Time for ${scope} · press Start when ready`
        : this.phase === 'ready'
          ? 'Get into position'
          : this.paused
            ? `Paused · time left, ${scope}`
            : `Time left · ${scope}`;
    const next = STEPS[this.i + 1];
    this.$('mb-next').textContent = next ? `Next: ${next.ex.name}${next.side ? ` (${next.side})` : ''}` : 'Last one';
    this.renderTimer();
  }
}
