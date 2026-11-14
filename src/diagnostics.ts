/**
 * Diagnostics recorder. Off by default. While on, it keeps a timeline of what the app sees:
 * connection events, raw USB reports to and from the monitor, rowing and heart-rate data,
 * ErgometerJS log lines and errors. "Stop and save" sends it to the local server, which writes
 * ~/rowing-backups/diagnostics/diag-<date>-<time>.json (copied to Google Drive with the backups).
 *
 * Start it from Settings → Diagnostics, from the connect screen, or by opening the app with ?diag.
 */

declare const __APP_VERSION__: string;

interface Entry {
  /** Milliseconds since recording started. */
  t: number;
  k: string;
  [field: string]: unknown;
}

const MAX_ENTRIES = 150_000;
const MAX_HID_REPORTS = 60_000;

function hex(data: DataView | ArrayBuffer | ArrayBufferView): string {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Reports are padded with zeros to a fixed size; the trailing zeros carry nothing.
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  let s = '';
  for (let i = 0; i < end; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function describeHidDevice(d: any) {
  const reports = (list: any[]) =>
    (list ?? []).map((r: any) => {
      const bits = (r.items ?? []).reduce((n: number, it: any) => n + it.reportSize * it.reportCount, 0);
      return `${r.reportId}:${bits / 8}B`;
    });
  return {
    vendorId: d.vendorId,
    productId: d.productId,
    productName: d.productName,
    opened: d.opened,
    collections: (d.collections ?? []).map((c: any) => ({
      usagePage: c.usagePage,
      usage: c.usage,
      input: reports(c.inputReports),
      output: reports(c.outputReports),
      feature: reports(c.featureReports),
    })),
  };
}

class Diagnostics {
  private entries: Entry[] = [];
  private startedAt = 0;
  private dropped = 0;
  private hidReports = 0;
  private listeners = new Set<() => void>();
  active = false;

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  get entryCount() {
    return this.entries.length;
  }

  get elapsedSec() {
    return this.active ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  start(context: Record<string, unknown> = {}) {
    this.entries = [];
    this.dropped = 0;
    this.hidReports = 0;
    this.startedAt = Date.now();
    this.active = true;
    this.log('start', {
      appVersion: __APP_VERSION__,
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      window: `${innerWidth}x${innerHeight}`,
      webHid: 'hid' in navigator,
      ...context,
    });
    void this.logHidDevices('hid-devices-at-start');
    this.changed();
  }

  /** Stops recording and returns everything recorded. */
  stop(): object {
    this.log('stop', { dropped: this.dropped, hidReports: this.hidReports });
    this.active = false;
    const data = {
      app: 'erg-heart-coach-diagnostics',
      version: 1,
      startedAt: new Date(this.startedAt).toISOString(),
      stoppedAt: new Date().toISOString(),
      entries: this.entries,
    };
    this.entries = [];
    this.changed();
    return data;
  }

  log(kind: string, fields: Record<string, unknown> = {}) {
    if (!this.active) return;
    if (this.entries.length >= MAX_ENTRIES) {
      this.dropped++;
      return;
    }
    this.entries.push({ t: Date.now() - this.startedAt, k: kind, ...fields });
  }

  /** A raw USB HID report: 'out' = app → monitor, 'in' = monitor → app. */
  hid(dir: 'in' | 'out', reportId: number, data: DataView | ArrayBuffer | ArrayBufferView) {
    if (!this.active) return;
    if (++this.hidReports > MAX_HID_REPORTS) return;
    this.log(`hid-${dir}`, { id: reportId, len: data.byteLength, hex: hex(data) });
  }

  async logHidDevices(kind = 'hid-devices') {
    if (!('hid' in navigator)) return;
    try {
      const devices = await (navigator as any).hid.getDevices();
      this.log(kind, { devices: devices.map(describeHidDevice) });
    } catch (err) {
      this.log(kind, { error: String(err) });
    }
  }
}

export const diag = new Diagnostics();

/** Taps a WebHID device so its traffic is recorded while diagnostics are on. Safe to call twice. */
export function tapHidDevice(device: any) {
  if (!device || device.__diagTapped) return;
  device.__diagTapped = true;
  const send = device.sendReport.bind(device);
  device.sendReport = (reportId: number, data: ArrayBuffer) => {
    diag.hid('out', reportId, data);
    return send(reportId, data);
  };
  device.addEventListener('inputreport', (e: any) => diag.hid('in', e.reportId, e.data));
}

// Errors and warnings from anywhere in the app.
for (const level of ['warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    diag.log(`console-${level}`, { text: args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : safeJson(a))).join(' ') });
    orig(...args);
  };
}
window.addEventListener('error', (e) => diag.log('window-error', { text: e.message, at: `${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => diag.log('unhandled-rejection', { text: String(e.reason) }));

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Sends a finished recording to the laptop's server. If that fails, the browser downloads the file
 * instead (to ~/Downloads), so the recording is never lost.
 */
export async function saveDiagnostics(data: object): Promise<{ file: string } | { downloaded: string; reason: string }> {
  const body = JSON.stringify(data);
  let reason: string;
  try {
    const res = await fetch('/api/diagnostics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) return { file: (await res.json()).file as string };
    reason =
      res.status === 404 || res.status === 405
        ? 'the app server is an older version (restart it after updating)'
        : `the app server replied ${res.status} ${await res.text().catch(() => '')}`.trim();
  } catch (err) {
    reason = `the app server could not be reached (${String(err)})`;
  }
  const name = `diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return { downloaded: name, reason };
}
