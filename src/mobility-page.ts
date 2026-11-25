/**
 * The stretching page on its own, for the iPad (http://<laptop>.local:4173/mobility).
 * The laptop serves it; progress is shared through the laptop's server (see syncMobility).
 */
import { Alarm } from './alarm';
import {
  HOLD_MAX_SEC,
  loadMobility,
  MobilityRoutine,
  ROUTINE,
  ROUTINES_PER_STEP,
  routineMinutes,
  secFor,
  syncMobility,
} from './mobility';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const alarm = new Alarm();
// iPad Safari only plays sound after a tap; every tap keeps it allowed.
document.addEventListener('click', () => alarm.unlock());

const routine = new MobilityRoutine(
  () => alarm.chime(),
  () => void refresh(),
  () => void refresh(),
);

const fmtDay = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function renderStats() {
  const s = loadMobility();
  const holds = ROUTINE.filter((e) => e.how === 'Hold').map((e) => secFor(e, s));
  const lo = Math.min(...holds);
  const hi = Math.max(...holds);
  const toNext = ROUTINES_PER_STEP - (s.completed.length % ROUTINES_PER_STEP);
  const last = s.completed.at(-1);
  const kw = s.kneeWall.at(-1);
  const rows: [string, string][] = [
    ['Routines done', `${s.completed.length}${last ? ` · last ${fmtDay(last)}` : ''}`],
    [
      'Holds',
      lo >= HOLD_MAX_SEC ? 'at the full 60 s' : `${lo === hi ? lo : `${lo}–${hi}`} s · 5 s longer after ${toNext} more routine${toNext === 1 ? '' : 's'}`,
    ],
    ['Knee to wall', kw ? `left ${kw.left} in · right ${kw.right} in (${fmtDay(kw.t)})` : 'not measured yet'],
  ];
  $('mp-stats').innerHTML = rows.map(([k, v]) => `<div><span class="m-label">${k}</span><b>${v}</b></div>`).join('');
}

async function refresh() {
  renderStats();
  const ok = await syncMobility();
  $('mp-sync').textContent = ok
    ? 'Progress is shared with the laptop.'
    : "Can't reach the laptop: progress is kept on this iPad and shared next time.";
  renderStats();
}

$('btn-mp-start').textContent = `Start the routine (${routineMinutes()} min)`;
$('btn-mp-start').addEventListener('click', () => {
  alarm.unlock();
  routine.open();
});
void refresh();
