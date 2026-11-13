import { RowerSource } from './source';

/**
 * Real Concept2 PM3/PM4/PM5 over USB, using ErgometerJS (loaded globally from /lib/ergometer.js)
 * and the browser's WebHID API (Chrome / Chromium / Edge).
 */

// ErgometerJS is a global script; we only use a small part of it, so keep the typing loose.
declare const ergometer: any;

const CONCEPT2_VENDOR_ID = 0x17a4;
const READY_FOR_COMMUNICATION = 6; // ergometer.MonitorConnectionState.readyForCommunication

/** How often we ask the PM for heart rate ourselves (see pollHeartRate). */
const HR_POLL_MS = 1000;
/** How often we try to reconnect after the PM goes away (sleep, cable pulled). */
const RECONNECT_MS = 3000;

export class PM4Source extends RowerSource {
  readonly name = 'Concept2 monitor (USB)';
  private pm: any = null;
  private hrTimer: number | undefined;
  private reconnectTimer: number | undefined;
  private hrInFlight = false;
  private lastHrAt = 0;
  private stopped = false;

  static isSupported(): boolean {
    return 'hid' in navigator && typeof ergometer !== 'undefined';
  }

  /** True if the user already granted USB permission for a PM earlier, so we can connect without a tap. */
  static async hasGrantedDevice(): Promise<boolean> {
    if (!PM4Source.isSupported()) return false;
    const devices = await (navigator as any).hid.getDevices();
    return devices.some((d: any) => d.vendorId === CONCEPT2_VENDOR_ID);
  }

  async start(interactive: boolean): Promise<void> {
    this.stopped = false;
    if (!PM4Source.isSupported()) {
      this.emit('status', 'error', 'This browser has no WebHID. Use Chrome or Chromium.');
      throw new Error('WebHID not supported');
    }
    (navigator as any).hid.addEventListener('connect', this.onHidConnect);
    // Start polling before connecting, so it is running even if the first attempt fails and a retry succeeds.
    this.hrTimer = window.setInterval(() => this.pollHeartRate(), HR_POLL_MS);
    await this.connect(interactive);
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.hrTimer);
    window.clearTimeout(this.reconnectTimer);
    (navigator as any).hid.removeEventListener('connect', this.onHidConnect);
    this.pm?.disconnect();
    this.pm = null;
    this.emit('status', 'disconnected');
  }

  private onHidConnect = (e: any) => {
    if (e.device?.vendorId === CONCEPT2_VENDOR_ID && !this.isConnected()) {
      this.connect(false).catch(() => this.scheduleReconnect());
    }
  };

  private isConnected(): boolean {
    return this.pm?.connectionState === READY_FOR_COMMUNICATION;
  }

  private async connect(interactive: boolean): Promise<void> {
    this.emit('status', 'connecting');
    // A fresh monitor object per connection keeps ErgometerJS's internal state clean.
    const pm = new ergometer.PerformanceMonitorUsb();
    pm.driver = this.makeDriver(interactive);
    this.subscribe(pm);
    this.pm = pm;

    try {
      const devices = await pm.requestDevics();
      if (!devices.length) throw new Error('No Concept2 monitor found');
      await pm.connectToDevice(devices[0]);
      this.emit('status', 'connected', devices[0].productName);
    } catch (err) {
      this.emit('status', 'error', `Could not connect: ${String(err)}`);
      if (!interactive) this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Driver that first reuses a device the user already allowed (no prompt, works after reboot
   * or when the PM wakes up), and only shows the browser's USB picker when called from a tap.
   */
  private makeDriver(interactive: boolean) {
    const webHidDriver = new ergometer.usb.DriverWebHid();
    return {
      requestDevics: async () => {
        const granted = await (navigator as any).hid.getDevices();
        const hid = granted.find((d: any) => d.vendorId === CONCEPT2_VENDOR_ID);
        if (hid) {
          const dev = new ergometer.usb.DeviceWebHid(hid);
          dev.productId = hid.productId;
          dev.vendorId = hid.vendorId;
          dev.productName = hid.productName;
          return [dev];
        }
        if (!interactive) return [];
        return webHidDriver.requestDevics();
      },
    };
  }

  private subscribe(pm: any) {
    pm.logEvent.sub(this, (text: string, level: number) => {
      if (level === 0) console.warn('[ergometer]', text);
    });

    pm.connectionStateChangedEvent.sub(this, (oldState: number, newState: number) => {
      if (pm !== this.pm) return;
      if (oldState === READY_FOR_COMMUNICATION && newState !== READY_FOR_COMMUNICATION) {
        // PM went to sleep or the cable was unplugged.
        this.emit('status', 'disconnected', 'Monitor disconnected');
        this.emit('heartRate', 0, Date.now());
        this.scheduleReconnect();
      }
    });

    // ErgometerJS only starts its USB polling loop if someone listens to strokeStateEvent or
    // trainingDataEvent (strokeDataEvent alone is not enough), so keep a listener on one of them.
    pm.trainingDataEvent.sub(this, () => {});

    pm.strokeDataEvent.sub(this, (d: any) => {
      const now = Date.now();
      this.emit('sample', {
        time: now,
        elapsed: (d.workTime ?? 0) / 1000,
        distance: d.distance ?? 0,
        pace: (d.splitTime ?? 0) / 1000,
        power: d.power ?? 0,
        spm: d.strokesPerMinute ?? 0,
        calories: d.totCalories ?? 0,
        strokeCount: d.strokeCount ?? 0,
        dragFactor: d.dragFactor ?? 0,
      });
      if (typeof d.heartRate === 'number') this.reportHeartRate(d.heartRate, now);
    });

    // Subscribing to this event makes ErgometerJS fetch the force curve after every drive.
    pm.powerCurveEvent.sub(this, (curve: number[]) => {
      if (curve?.length) this.emit('forceCurve', curve.slice());
    });
  }

  private reportHeartRate(raw: number, time: number) {
    // The PM reports 0 when it hears no strap. Treat anything implausible as "no signal" too.
    const bpm = raw >= 25 && raw <= 240 ? raw : 0;
    this.lastHrAt = time;
    this.emit('heartRate', bpm, time);
  }

  /**
   * ErgometerJS only refreshes heart rate when the stroke phase changes, so HR would freeze as soon
   * as you stop rowing (exactly when you want to watch it come down). Poll it ourselves.
   */
  private pollHeartRate() {
    if (!this.isConnected() || this.hrInFlight) return;
    if (Date.now() - this.lastHrAt < HR_POLL_MS) return;
    this.hrInFlight = true;
    this.pm
      .newCsafeBuffer()
      .getHeartRate({ onDataReceived: (v: number) => this.reportHeartRate(v, Date.now()) })
      .send()
      .catch((err: unknown) => console.warn('HR poll failed', err))
      .finally(() => (this.hrInFlight = false));
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      if (this.stopped || this.isConnected()) return;
      this.connect(false).catch(() => {
        /* connect() schedules the next attempt */
      });
    }, RECONNECT_MS);
  }
}
