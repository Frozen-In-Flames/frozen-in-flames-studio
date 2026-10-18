/**
 * ui/panel808.ts — 808 studio panel: parameter sliders, sweep trigger,
 * drum pads, automation-curve canvas, and MIDI export of the sweep.
 *
 * The documented mapping: cutoff slider is Hz (20–200); the sweep renders
 * startHz -> 1200 Hz; MIDI export scales the same sweep to CC74.
 */

import {
  EightOhEight,
  automationSteps,
  automationToMidi,
  type EightOhEightParams,
} from '../audio/eight08.js';
import { downloadBlob } from './panels.js';
import { noteName } from './keybed.js';

export function build808Panel(container: HTMLElement, kit: EightOhEight): EightOhEightParams {
  const params: EightOhEightParams = { note: 36, bpm: 140, startCutoff: 40, resonance: 64 };
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h2>808 Studio</h2>
    <p class="sub">Sub-bass voice with 16-step filter sweep. Cutoff is honest Hz;
    MIDI export scales the sweep to CC74 as <code>round(127·(Hz−20)/1180)</code>.
    The 808 runs through a 90 Hz Linkwitz-Riley crossover (lows mono, highs stereo)
    and a kick-triggered sidechain duck.</p>
    <div class="sec">
      <div class="sec-title">Voice</div>
      <div class="controls">
        <div class="control"><label>Root note <b data-k="noteVal">C1 (36)</b></label>
          <input data-k="note" type="range" min="24" max="48" value="36"></div>
        <div class="control"><label>BPM <b data-k="bpmVal">140</b></label>
          <input data-k="bpm" type="range" min="60" max="180" value="140"></div>
        <div class="control"><label>Sweep start cutoff <b data-k="cutVal">40 Hz</b></label>
          <input data-k="cutoff" type="range" min="20" max="200" value="40"></div>
        <div class="control"><label>Resonance to Q <b data-k="resVal">6.4</b></label>
          <input data-k="res" type="range" min="10" max="127" value="64"></div>
        <div class="control"><label>Sidechain duck <b data-k="scVal">50%</b></label>
          <input data-k="sidechain" type="range" min="0" max="100" value="50"></div>
      </div>
    </div>
    <div class="sec">
      <div class="sec-title">Trigger pads</div>
      <div class="pad-grid">
        <button class="primary" data-k="sweep">Trigger 808 Sweep</button>
        <button data-k="kick">Kick</button>
        <button data-k="snare">Snare</button>
        <button data-k="hat">Hat</button>
        <button data-k="stop">Stop</button>
        <button data-k="mid">Export sweep .mid</button>
      </div>
    </div>
    <div class="sec">
      <div class="sec-title">Automation curve</div>
      <p class="sub">16 steps, start Hz to 1200 Hz over 4 bars.</p>
      <canvas class="frame" data-k="curve" width="640" height="180"></canvas>
    </div>
  `;
  container.appendChild(wrap);
  const q = <T extends HTMLElement>(k: string): T => {
    const el = wrap.querySelector(`[data-k="${k}"]`);
    if (!el) throw new Error(`808panel: missing [data-k="${k}"]`);
    return el as T;
  };
  const canvas = q<HTMLCanvasElement>('curve');
  const cctx = canvas.getContext('2d');
  if (!cctx) throw new Error('2D canvas unavailable');

  const drawCurve = () => {
    const steps = automationSteps(params.startCutoff);
    const w = canvas.width;
    const h = canvas.height;
    cctx.clearRect(0, 0, w, h);
    cctx.strokeStyle = '#30363d';
    cctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      cctx.beginPath(); cctx.moveTo(x, 0); cctx.lineTo(x, h); cctx.stroke();
    }
    cctx.strokeStyle = '#58a6ff';
    cctx.lineWidth = 2;
    cctx.beginPath();
    const lo = 20, hi = 1200;
    for (let i = 0; i < steps.length; i++) {
      const x = (i / (steps.length - 1)) * (w - 16) + 8;
      const y = h - 12 - ((steps[i] - lo) / (hi - lo)) * (h - 24);
      if (i === 0) cctx.moveTo(x, y);
      else cctx.lineTo(x, y);
    }
    cctx.stroke();
    cctx.fillStyle = '#8b949e';
    cctx.font = '10px monospace';
    cctx.fillText(`${params.startCutoff} Hz`, 8, h - 4);
    cctx.fillText('1200 Hz', w - 52, 14);
  };

  q<HTMLInputElement>('note').addEventListener('input', (e) => {
    params.note = parseInt((e.target as HTMLInputElement).value, 10);
    q('noteVal').textContent = `${noteName(params.note)} (${params.note})`;
  });
  q<HTMLInputElement>('bpm').addEventListener('input', (e) => {
    params.bpm = parseInt((e.target as HTMLInputElement).value, 10);
    q('bpmVal').textContent = `${params.bpm}`;
  });
  q<HTMLInputElement>('cutoff').addEventListener('input', (e) => {
    params.startCutoff = parseInt((e.target as HTMLInputElement).value, 10);
    q('cutVal').textContent = `${params.startCutoff} Hz`;
    drawCurve();
  });
  q<HTMLInputElement>('res').addEventListener('input', (e) => {
    params.resonance = parseInt((e.target as HTMLInputElement).value, 10);
    q('resVal').textContent = `${(params.resonance / 10).toFixed(1)}`;
  });
  q<HTMLInputElement>('sidechain').addEventListener('input', (e) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    q('scVal').textContent = `${v}%`;
    kit.setSidechain({ amount: v / 100 });
  });

  q('sweep').addEventListener('click', () => kit.sweep({ ...params }));
  q('stop').addEventListener('click', () => kit.stopAll());
  q('kick').addEventListener('click', () => {
    kit.kick();
    kit.duckAt(); // demo the kick-triggered sidechain on this panel's sub bus
  });
  q('snare').addEventListener('click', () => kit.snare());
  q('hat').addEventListener('click', () => kit.hat());
  q('mid').addEventListener('click', () => {
    const bytes = automationToMidi({ ...params });
    downloadBlob(new Blob([bytes], { type: 'audio/midi' }), 'frozen-in-flames-808-sweep.mid');
  });

  drawCurve();
  return params;
}
