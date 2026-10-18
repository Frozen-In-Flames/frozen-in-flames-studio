/**
 * ui/keybed.ts — Marxophone keybed: clickable piano keys with hammer-strike
 * animation, computer-keyboard mapping, and voice controls
 * (tuning system, cents, decay, spring-bounce mode).
 */

import type { MarxophoneEngine } from '../audio/marxophone.js';
import { TUNING_LABELS, type TuningSystem } from '../audio/tuning.js';

const LOWEST = 60; // C4
const HIGHEST = 83; // B5
const WHITE_STEPS = new Set([0, 2, 4, 5, 7, 9, 11]);
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** Computer keyboard -> semitone offset from C4. */
const KEYMAP: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
  k: 12, o: 13, l: 14, p: 15, ';': 16,
};

export function buildKeybed(container: HTMLElement, marx: MarxophoneEngine): void {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h2>Marxophone</h2>
    <p class="sub">Hammer-strike additive voice: saw + 2.001x triangle shimmer + 3.98x chime,
    bandpassed noise transient, body-filter sweep, tube warmth.</p>
    <div class="sec">
      <div class="sec-title">Voice</div>
      <div class="controls">
        <div class="control"><label>Tuning system</label><select data-k="tuning"></select></div>
        <div class="control"><label>Cents offset <b data-k="centsVal">+0</b></label>
          <input data-k="cents" type="range" min="-100" max="100" value="0"></div>
        <div class="control"><label>Decay <b data-k="decayVal">0.70 s</b></label>
          <input data-k="decay" type="range" min="20" max="200" value="70"></div>
        <div class="control"><label>Spring-hammer bounce</label>
          <div class="row"><button data-k="bounce">Off</button>
          <input data-k="bounceRate" type="range" min="10" max="22" value="14" title="Bounce rate Hz"></div>
        </div>
      </div>
    </div>
    <div class="sec">
      <div class="sec-title">Keyboard <span class="kbd-hint">tap the keys · octave C4–B5</span></div>
      <div class="keybed" data-k="bed"></div>
      <p class="kbd-hint">Computer keys A W S E D F T G Y H U J K play C4–C5</p>
    </div>
  `;
  container.appendChild(wrap);
  const q = <T extends HTMLElement>(k: string): T => {
    const el = wrap.querySelector(`[data-k="${k}"]`);
    if (!el) throw new Error(`keybed: missing [data-k="${k}"]`);
    return el as T;
  };

  // --- voice controls ---
  const tuningSel = q<HTMLSelectElement>('tuning');
  for (const [value, label] of Object.entries(TUNING_LABELS)) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    tuningSel.appendChild(o);
  }
  let cents = 0;
  const applyTuning = () => marx.setTuning(tuningSel.value as TuningSystem, cents);
  tuningSel.addEventListener('change', applyTuning);
  q<HTMLInputElement>('cents').addEventListener('input', (e) => {
    cents = parseInt((e.target as HTMLInputElement).value, 10);
    q('centsVal').textContent = `${cents >= 0 ? '+' : ''}${cents}`;
    applyTuning();
  });
  q<HTMLInputElement>('decay').addEventListener('input', (e) => {
    const s = parseInt((e.target as HTMLInputElement).value, 10) / 100;
    q('decayVal').textContent = `${s.toFixed(2)} s`;
    marx.setDecay(s);
  });
  const bounceBtn = q<HTMLButtonElement>('bounce');
  let bounceOn = false;
  const applyBounce = () => {
    marx.setBounce(bounceOn, parseInt(q<HTMLInputElement>('bounceRate').value, 10));
    bounceBtn.textContent = bounceOn ? 'On' : 'Off';
  };
  bounceBtn.addEventListener('click', () => {
    bounceOn = !bounceOn;
    applyBounce();
  });
  q<HTMLInputElement>('bounceRate').addEventListener('input', applyBounce);

  // --- keys ---
  const bed = q('bed');
  const keyEls = new Map<number, HTMLElement>();
  const whites: number[] = [];
  for (let m = LOWEST; m <= HIGHEST; m++) {
    if (WHITE_STEPS.has(m % 12)) whites.push(m);
  }
  const whitesBox = document.createElement('div');
  whitesBox.className = 'keys-white';
  bed.appendChild(whitesBox);

  const strike = (midi: number) => {
    marx.noteOn(midi, 0.85);
    keyEls.get(midi)?.classList.add('struck', 'active');
  };
  const release = (midi: number) => {
    marx.noteOff(midi);
    keyEls.get(midi)?.classList.remove('struck', 'active');
  };

  for (const m of whites) {
    const key = document.createElement('div');
    key.className = 'key-white';
    key.innerHTML = `<div class="hammer"></div><div class="key-label">${noteName(m)}</div>`;
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      key.setPointerCapture(e.pointerId);
      strike(m);
    });
    key.addEventListener('pointerup', () => release(m));
    key.addEventListener('pointercancel', () => release(m));
    whitesBox.appendChild(key);
    keyEls.set(m, key);
  }
  // Black keys positioned over the white-key row.
  const whiteIndex = new Map(whites.map((m, i) => [m, i]));
  for (let m = LOWEST; m <= HIGHEST; m++) {
    if (WHITE_STEPS.has(m % 12)) continue;
    const prevWhite = m - 1;
    const wi = whiteIndex.get(prevWhite);
    if (wi === undefined) continue;
    const key = document.createElement('div');
    key.className = 'key-black';
    // Center on the boundary between white key wi and wi+1.
    key.style.left = `calc(${((wi + 1) / whites.length) * 100}% - 2.75%)`;
    key.style.width = '5.5%';
    key.innerHTML = `<div class="hammer"></div>`;
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      key.setPointerCapture(e.pointerId);
      strike(m);
    });
    key.addEventListener('pointerup', () => release(m));
    key.addEventListener('pointercancel', () => release(m));
    bed.appendChild(key);
    keyEls.set(m, key);
  }

  // Computer keyboard.
  const held = new Set<string>();
  window.addEventListener('keydown', (e) => {
    if (e.repeat || held.has(e.key)) return;
    const off = KEYMAP[e.key.toLowerCase()];
    if (off === undefined) return;
    held.add(e.key);
    strike(LOWEST + off);
  });
  window.addEventListener('keyup', (e) => {
    const off = KEYMAP[e.key.toLowerCase()];
    if (off === undefined) return;
    held.delete(e.key);
    release(LOWEST + off);
  });
}
