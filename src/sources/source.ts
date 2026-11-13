/** One snapshot of rowing data from the monitor. */
export interface RowerSample {
  /** Wall-clock time the sample was received (ms since epoch). */
  time: number;
  /** Elapsed work time reported by the monitor, in seconds. */
  elapsed: number;
  /** Distance rowed, in meters. */
  distance: number;
  /** Pace in seconds per 500 m (0 when not moving). */
  pace: number;
  /** Power in watts. */
  power: number;
  /** Stroke rate, strokes per minute. */
  spm: number;
  /** Total calories. */
  calories: number;
  strokeCount: number;
  dragFactor: number;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SourceEvents {
  sample: (s: RowerSample) => void;
  /** Heart rate in bpm. 0 means the monitor reports no strap signal. */
  heartRate: (bpm: number, time: number) => void;
  /** Force curve of the stroke that just finished (raw force values over the drive). */
  forceCurve: (curve: number[]) => void;
  status: (status: ConnectionStatus, message?: string) => void;
}

/** Common base for the real PM4 and the simulator, so the UI does not care which it gets. */
export abstract class RowerSource {
  abstract readonly name: string;
  private listeners: { [K in keyof SourceEvents]: Set<SourceEvents[K]> } = {
    sample: new Set(),
    heartRate: new Set(),
    forceCurve: new Set(),
    status: new Set(),
  };

  on<K extends keyof SourceEvents>(event: K, fn: SourceEvents[K]): void {
    this.listeners[event].add(fn);
  }

  protected emit<K extends keyof SourceEvents>(event: K, ...args: Parameters<SourceEvents[K]>): void {
    for (const fn of this.listeners[event]) {
      try {
        (fn as (...a: Parameters<SourceEvents[K]>) => void)(...args);
      } catch (err) {
        console.error(`Error in ${event} listener`, err);
      }
    }
  }

  /** Start producing data. `interactive` is true when called from a user tap (needed for USB permission prompts). */
  abstract start(interactive: boolean): Promise<void>;
  abstract stop(): void;
}
