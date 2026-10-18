/**
 * main.ts — Frozen In Flames Studio bootstrap.
 *
 * The page is inert until the user clicks "Initialize Audio"
 * (a user gesture is required to create the AudioContext).
 * UI modules import only from src/audio/* and src/visuals.ts.
 */

import './styles.css';
import { AudioEngine, type AudioHost } from './audio/engine.js';
import { MarxophoneEngine } from './audio/marxophone.js';
import { EightOhEight } from './audio/eight08.js';
import { MixerEngine } from './audio/mixer.js';
import { FrozenFlamesRenderer } from './visuals.js';
import { buildKeybed } from './ui/keybed.js';
import { build808Panel } from './ui/panel808.js';
import { buildMixerView } from './ui/mixerview.js';
import { buildTransport, buildMidiPanel } from './ui/panels.js';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

/** The live engine once audio is initialized; null before. */
let liveEngine: AudioEngine | null = null;
/** Shared transport BPM. */
const bpmState = { value: 140 };

async function boot(): Promise<void> {
  const engine = new AudioEngine();
  await engine.init();
  liveEngine = engine;

  // --- spatial mixer first: stems must exist before instruments route in ---
  const mixer = new MixerEngine(engine);
  const { getStems } = buildMixerView(el('panel-mixer'), mixer, [
    { name: 'Sub Bass', category: 'bass' },
    { name: 'Drums', category: 'drums' },
    { name: 'Keys', category: 'melody' },
    { name: 'Vocal', category: 'vocal' },
    { name: 'FX', category: 'fx' },
  ]);

  const stemInput = (category: string): GainNode => {
    const stem = getStems().find((s) => s.category === category);
    const node = stem ? mixer.stemInput(stem.id) : null;
    if (!node) throw new Error(`mixer stem missing for category "${category}"`);
    return node;
  };
  const subHost = (input: GainNode): AudioHost => ({
    ctx: engine.ctx,
    bus: input,
    convolver: engine.convolver,
    reverbReturn: engine.reverbReturn,
  });

  // --- instruments, each routed through its mixer stem ---
  const kitBass = new EightOhEight(subHost(stemInput('bass')));
  const kitDrums = new EightOhEight(subHost(stemInput('drums')));
  const marx = new MarxophoneEngine(subHost(stemInput('melody')), { decay: 0.7 });

  // --- panels ---
  buildTransport(el('transport'), {
    engine,
    kit: kitBass,
    drumsKit: kitDrums,
    marx,
    getBpm: () => bpmState.value,
    onBpmChange: (bpm) => {
      bpmState.value = bpm;
    },
  });
  buildKeybed(el('panel-keys'), marx);
  build808Panel(el('panel-808'), kitBass);
  buildMidiPanel(el('panel-midi'), { marx, getBpm: () => bpmState.value });

  // --- visuals ---
  const renderer = new FrozenFlamesRenderer(el<HTMLCanvasElement>('visuals'));
  renderer.start(engine.analyser);
  el('visualStatus').textContent = 'Visual field live: analyser-reactive, stereo only.';

  // Apply the master-volume slider's current value.
  engine.setMasterVolume(parseInt(el<HTMLInputElement>('masterVol').value, 10) / 100);

  const badge = el('engineStatus');
  badge.textContent = 'AUDIO LIVE';
  badge.classList.add('on');
  el('initBtn').textContent = 'Audio initialized';
}

// --- tabs ---
function wireTabs(): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab'));
  const panels = Array.from(document.querySelectorAll<HTMLElement>('.panel'));
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const t of tabs) t.classList.remove('active');
      for (const p of panels) p.classList.remove('active');
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.tab}`)?.classList.add('active');
    });
  }
}

wireTabs();

el('initBtn').addEventListener('click', async (e) => {
  const btn = e.target as HTMLButtonElement;
  btn.disabled = true;
  try {
    await boot();
  } catch (err) {
    btn.disabled = false;
    el('engineStatus').textContent = `INIT FAILED: ${(err as Error).message}`;
  }
});

el('masterVol').addEventListener('input', (e) => {
  const v = parseInt((e.target as HTMLInputElement).value, 10);
  el('masterVolVal').textContent = `${v}%`;
  liveEngine?.setMasterVolume(v / 100);
});
