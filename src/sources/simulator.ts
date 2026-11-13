import { RowerSource, type RowerSample } from './source';

/**
 * Fake rower + heart rate, for building and testing without the real machine.
 *
 * Controls (keyboard or the on-screen sim panel):
 *   Up / Down  = row harder / easier
 *   Space      = stop / resume rowing
 *   H          = drop / restore the heart-rate strap signal
 */
export class SimulatorSource extends RowerSource {
  readonly name = 'Simulator';

  /** 0 = very easy, 1 = flat out. */
  effort = 0.35;
  rowing = true;
  hrSignal = true;

  private timer: number | undefined;
  private lastTick = 0;
  private lastSampleAt = 0;
  private lastHrAt = 0;

  // Simulated state
  private hr = 72;
  private restingHr = 70;
  private elapsed = 0;
  private distance = 0;
  private calories = 0;
  private strokeCount = 0;
  private strokePhase = 0; // 0..1 through the current stroke
  private power = 0;
  private spm = 0;

  async start(): Promise<void> {
    this.lastTick = performance.now();
    this.timer = window.setInterval(() => this.tick(), 50);
    window.addEventListener('keydown', this.onKey);
    this.emit('status', 'connected', 'Simulated PM4');
  }

  stop(): void {
    window.clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey);
    this.emit('status', 'disconnected');
  }

  adjustEffort(delta: number) {
    this.effort = Math.min(1, Math.max(0, this.effort + delta));
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('input, dialog')) return;
    if (e.key === 'ArrowUp') this.adjustEffort(0.05);
    else if (e.key === 'ArrowDown') this.adjustEffort(-0.05);
    else if (e.key === ' ') this.rowing = !this.rowing;
    else if (e.key.toLowerCase() === 'h') this.hrSignal = !this.hrSignal;
    else return;
    e.preventDefault();
  };

  private tick() {
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;

    // Effort -> stroke rate and power, typical of a beginner (about 40-200 W).
    const targetSpm = this.rowing ? 18 + this.effort * 12 : 0;
    const targetPower = this.rowing ? 40 + this.effort * 160 : 0;
    this.spm += (targetSpm - this.spm) * Math.min(1, dt * 1.5);
    this.power += (targetPower - this.power) * Math.min(1, dt * 0.8);

    if (this.rowing && this.spm > 5) {
      this.elapsed += dt;
      const before = this.strokePhase;
      this.strokePhase += (dt * this.spm) / 60;
      // The drive is roughly the first third of the stroke; send a force curve when it ends.
      if (before < 0.35 && this.strokePhase >= 0.35) this.emit('forceCurve', this.makeForceCurve());
      if (this.strokePhase >= 1) {
        this.strokePhase -= 1;
        this.strokeCount++;
      }
      // Concept2 formula: watts = 2.8 / (seconds per meter)^3
      const secPerMeter = Math.cbrt(2.8 / Math.max(this.power, 1));
      this.distance += dt / secPerMeter;
      this.calories += (dt * (this.power * 4 * 0.8604 + 300)) / 3600;
    }

    this.updateHeartRate(dt);

    const wall = Date.now();
    if (wall - this.lastSampleAt >= 500) {
      this.lastSampleAt = wall;
      const moving = this.rowing && this.power > 5;
      const sample: RowerSample = {
        time: wall,
        elapsed: this.elapsed,
        distance: this.distance,
        pace: moving ? 500 * Math.cbrt(2.8 / this.power) : 0,
        power: moving ? Math.round(this.power) : 0,
        spm: moving ? Math.round(this.spm) : 0,
        calories: Math.round(this.calories),
        strokeCount: this.strokeCount,
        dragFactor: 120,
      };
      this.emit('sample', sample);
    }
    if (wall - this.lastHrAt >= 1000) {
      this.lastHrAt = wall;
      this.emit('heartRate', this.hrSignal ? Math.round(this.hr + (Math.random() - 0.5) * 2) : 0, wall);
    }
  }

  /** Heart rate drifts toward a level set by power: up in about 30 s, down more slowly. */
  private updateHeartRate(dt: number) {
    const target = this.restingHr + (this.rowing ? (this.power / 200) * 95 : 0);
    const tau = target > this.hr ? 30 : 50;
    this.hr += (target - this.hr) * (dt / tau);
  }

  /** Bell-shaped drive force with a little stroke-to-stroke variation. */
  private makeForceCurve(): number[] {
    const n = 40;
    const peak = 60 + this.power * 0.9 + (Math.random() - 0.5) * 15;
    const skew = 0.4 + (Math.random() - 0.5) * 0.08; // where in the drive the peak happens
    const curve: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      const width = x < skew ? skew : 1 - skew;
      const f = Math.exp(-(((x - skew) / (width * 0.6)) ** 2)) * Math.sin(Math.PI * x) ** 0.4;
      curve.push(Math.max(0, Math.round(peak * f + (Math.random() - 0.5) * 3)));
    }
    return curve;
  }
}
