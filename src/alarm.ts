import type { Zone } from './heartrate';

/**
 * Sound cues made with the Web Audio API (no sound files needed).
 * Browsers only allow audio after a user tap, so call unlock() from a click handler.
 */
export class Alarm {
  enabled = true;
  private ctx: AudioContext | null = null;
  private lastZone: Zone | null = null;
  private lastCueAt = 0;

  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /**
   * Call a few times a second with the current zone.
   * @param active false while idle (before Start / after the summary), when only "over" should sound.
   */
  update(zone: Zone, active: boolean) {
    const now = performance.now();
    const changed = zone !== this.lastZone;
    this.lastZone = zone;
    const since = now - this.lastCueAt;

    switch (zone) {
      case 'over':
        // Urgent and repeating until HR comes down.
        if (changed || since > 1200) this.cue(now, [[1320, 0.12], [0, 0.06], [1320, 0.12], [0, 0.06], [1320, 0.12]], 0.5);
        break;
      case 'nosignal':
        // Repeating low tones while a session is running: you are rowing blind.
        if (active && (changed || since > 4000)) this.cue(now, [[440, 0.25], [0, 0.1], [330, 0.35]], 0.35);
        break;
      case 'high':
        // A gentle reminder when you drift above target, repeated every 20 s.
        if (active && (changed || since > 20000)) this.cue(now, [[880, 0.15], [0, 0.05], [660, 0.2]], 0.25);
        break;
      case 'target':
        if (active && changed && this.lastCueAt > 0) this.cue(now, [[660, 0.12], [0, 0.04], [880, 0.15]], 0.15);
        break;
      default:
        break;
    }
  }

  /** A friendly chime for phase changes (e.g. "main set done, cool down now"). */
  chime() {
    this.cue(performance.now(), [[523, 0.15], [0, 0.04], [659, 0.15], [0, 0.04], [784, 0.25]], 0.2);
  }

  /** Plays a sequence of [frequency Hz (0 = silence), seconds] notes. */
  private cue(now: number, notes: [number, number][], volume: number) {
    this.lastCueAt = now;
    if (!this.enabled || !this.ctx) return;
    let t = this.ctx.currentTime + 0.01;
    for (const [freq, dur] of notes) {
      if (freq > 0) {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 0.01);
        gain.gain.setValueAtTime(volume, t + dur - 0.02);
        gain.gain.linearRampToValueAtTime(0, t + dur);
        osc.connect(gain).connect(this.ctx.destination);
        osc.start(t);
        osc.stop(t + dur);
      }
      t += dur;
    }
  }
}
