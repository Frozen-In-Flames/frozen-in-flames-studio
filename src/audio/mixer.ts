/**
 * mixer.ts — Stem model, stereo spatial mapping, collision detection.
 *
 * Honest stereo only: x position -> constant-power pan, z -> distance gain,
 * lowpass cutoff and reverb send. There is no HRTF, no binaural, no Atmos —
 * the implementation is StereoPannerNode and the docs say so.
 *
 * Field coordinates are clamped to [-10, 10] on x/y/z.
 */

import type { AudioHost } from './engine.js';

export type StemCategory = 'bass' | 'drums' | 'melody' | 'vocal' | 'fx';

export interface StemPosition {
  x: number;
  y: number;
  z: number;
}

export interface StemEQ {
  low: number; // dB, -12..+12
  mid: number;
  high: number;
}

export interface StemSubcomponents {
  transient: number;
  body: number;
  air: number;
  tail: number;
}

export interface Stem {
  id: string;
  name: string;
  category: StemCategory;
  position: StemPosition;
  color: string;
  muted: boolean;
  solo: boolean;
  /** Higher priority stems win when auto-masking resolves collisions. */
  priority: number;
  eq: StemEQ;
  sub: StemSubcomponents;
  presetName: string;
}

export const FIELD_MIN = -10;
export const FIELD_MAX = 10;
export const COLLISION_THRESHOLD = 3.5;
export const COLLISION_SEVERITY_CUTOFF = 0.4;

/* ------------------------------------------------------------------ */
/* Pure spatial mapping                                                */
/* ------------------------------------------------------------------ */

export function clampField(v: number): number {
  return Math.max(FIELD_MIN, Math.min(FIELD_MAX, v));
}

/** x in [-10, 10] -> pan in [-1, 1]. */
export function panForX(x: number): number {
  return clampField(x) / 10;
}

/**
 * Constant-power stereo gains for a pan in [-1, 1].
 * left = cos((pan+1) * PI/4), right = sin((pan+1) * PI/4).
 * Invariant: left^2 + right^2 = 1.
 */
export function stereoGains(pan: number): { left: number; right: number } {
  const p = Math.max(-1, Math.min(1, pan));
  const angle = ((p + 1) * Math.PI) / 4;
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/**
 * Distance gain from z. z=-10 (front) -> 1.0, z=+10 (back) -> 0.12.
 */
export function distanceGain(z: number): number {
  const t = (clampField(z) - FIELD_MIN) / (FIELD_MAX - FIELD_MIN); // 0..1
  return 1 - 0.88 * t;
}

/**
 * Lowpass cutoff from z/y: 800 Hz (far/low) -> 20000 Hz (near/high).
 */
export function cutoffFor(z: number, y: number): number {
  const t = (clampField(z) + clampField(y) - 2 * FIELD_MIN) / (2 * (FIELD_MAX - FIELD_MIN));
  return 800 * Math.pow(25, t); // 800 * 25^0 = 800, 800 * 25^1 = 20000
}

/** Reverb wet send from z: 0.05 (front) -> 0.85 (back). */
export function reverbWet(z: number): number {
  const t = (clampField(z) - FIELD_MIN) / (FIELD_MAX - FIELD_MIN);
  return 0.05 + 0.8 * t;
}

/* ------------------------------------------------------------------ */
/* Collision / masking (pure)                                          */
/* ------------------------------------------------------------------ */

export type FrequencyZone = 'Low-End Rumble' | 'Mid-Range Masking';

export interface Collision {
  a: string;
  b: string;
  distance: number;
  severity: number; // 0..1, = 1 - distance / COLLISION_THRESHOLD
  zone: FrequencyZone;
}

function stemDistance(a: StemPosition, b: StemPosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Pairwise collision detection. Severity = 1 - dist/3.5 for dist < 3.5. */
export function detectCollisions(stems: Stem[]): Collision[] {
  const out: Collision[] = [];
  for (let i = 0; i < stems.length; i++) {
    for (let j = i + 1; j < stems.length; j++) {
      const dist = stemDistance(stems[i].position, stems[j].position);
      if (dist < COLLISION_THRESHOLD) {
        const bassInvolved = stems[i].category === 'bass' || stems[j].category === 'bass';
        out.push({
          a: stems[i].id,
          b: stems[j].id,
          distance: dist,
          severity: 1 - dist / COLLISION_THRESHOLD,
          zone: bassInvolved ? 'Low-End Rumble' : 'Mid-Range Masking',
        });
      }
    }
  }
  return out.sort((p, q) => q.severity - p.severity);
}

/**
 * Push colliding stems apart along the line connecting them until every
 * pair is at least COLLISION_THRESHOLD apart (or iterations run out).
 * Returns new stem objects; input is not mutated.
 */
export function autoScatter(stems: Stem[], iterations = 24): Stem[] {
  const moved: Stem[] = stems.map((s) => ({
    ...s,
    position: { ...s.position },
    eq: { ...s.eq },
    sub: { ...s.sub },
  }));
  for (let k = 0; k < iterations; k++) {
    let any = false;
    for (let i = 0; i < moved.length; i++) {
      for (let j = i + 1; j < moved.length; j++) {
        const a = moved[i].position;
        const b = moved[j].position;
        const dist = stemDistance(a, b);
        if (dist < COLLISION_THRESHOLD && dist > 1e-6) {
          any = true;
          const push = ((COLLISION_THRESHOLD - dist) / 2) * 0.6;
          const ux = (b.x - a.x) / dist;
          const uy = (b.y - a.y) / dist;
          const uz = (b.z - a.z) / dist;
          a.x = clampField(a.x - ux * push);
          a.y = clampField(a.y - uy * push);
          a.z = clampField(a.z - uz * push);
          b.x = clampField(b.x + ux * push);
          b.y = clampField(b.y + uy * push);
          b.z = clampField(b.z + uz * push);
        }
      }
    }
    if (!any) break;
  }
  // The relaxation above converges asymptotically, so finish with an exact
  // pass that guarantees the contract: no pair closer than the threshold.
  for (let pass = 0; pass < 8; pass++) {
    let clean = true;
    for (let i = 0; i < moved.length; i++) {
      for (let j = i + 1; j < moved.length; j++) {
        const a = moved[i].position;
        const b = moved[j].position;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist >= COLLISION_THRESHOLD) continue;
        clean = false;
        if (dist < 1e-6) {
          dx = 1;
          dy = 0;
          dz = 0;
          dist = 1;
        }
        const need = COLLISION_THRESHOLD + 1e-3 - dist;
        const ux = dx / dist;
        const uy = dy / dist;
        const uz = dz / dist;
        a.x = clampField(a.x - (ux * need) / 2);
        a.y = clampField(a.y - (uy * need) / 2);
        a.z = clampField(a.z - (uz * need) / 2);
        b.x = clampField(b.x + (ux * need) / 2);
        b.y = clampField(b.y + (uy * need) / 2);
        b.z = clampField(b.z + (uz * need) / 2);
      }
    }
    if (clean) break;
  }
  return moved;
}

/**
 * Auto-masking: for collisions with severity > 0.4, push the LOWER-priority
 * stem back in +z so it sits behind the priority stem.
 * Returns new stem objects; input is not mutated.
 */
export function autoMask(stems: Stem[]): Stem[] {
  const moved: Stem[] = stems.map((s) => ({ ...s, position: { ...s.position }, eq: { ...s.eq }, sub: { ...s.sub } }));
  for (const c of detectCollisions(moved)) {
    if (c.severity <= COLLISION_SEVERITY_CUTOFF) continue;
    const a = moved.find((s) => s.id === c.a);
    const b = moved.find((s) => s.id === c.b);
    if (!a || !b) continue;
    const loser = a.priority <= b.priority ? a : b;
    loser.position.z = clampField(loser.position.z + 2.5 * c.severity);
  }
  return moved;
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export interface SpatialPreset {
  name: string;
  positions: Record<string, StemPosition>;
}

export const SPATIAL_PRESETS: SpatialPreset[] = [
  {
    name: 'Vocal Up Front',
    positions: {
      vocal: { x: 0, y: 2, z: -8 },
      melody: { x: -4, y: 1, z: -3 },
      drums: { x: 3, y: -1, z: -2 },
      bass: { x: 0, y: -3, z: 0 },
      fx: { x: 7, y: 5, z: 6 },
    },
  },
  {
    name: 'Lo-Fi Snare Tight',
    positions: {
      vocal: { x: -2, y: 0, z: -4 },
      melody: { x: 4, y: 2, z: -1 },
      drums: { x: 0, y: -2, z: -6 },
      bass: { x: -3, y: -4, z: 2 },
      fx: { x: 6, y: 4, z: 4 },
    },
  },
  {
    name: 'Deep Mono Sub',
    positions: {
      vocal: { x: 1, y: 3, z: -7 },
      melody: { x: -5, y: 0, z: 3 },
      drums: { x: 5, y: -3, z: 3 },
      bass: { x: 0, y: -5, z: -9 },
      fx: { x: 0, y: 6, z: 8 },
    },
  },
  {
    name: 'Cinematic Cloud',
    positions: {
      vocal: { x: 0, y: 0, z: -5 },
      melody: { x: -7, y: 4, z: 2 },
      drums: { x: 7, y: -4, z: 2 },
      bass: { x: 0, y: -6, z: 5 },
      fx: { x: 0, y: 7, z: 9 },
    },
  },
];

let stemCounter = 0;

export function makeStem(name: string, category: StemCategory, color: string): Stem {
  stemCounter++;
  return {
    id: `stem-${stemCounter}`,
    name,
    category,
    position: { x: 0, y: 0, z: 0 },
    color,
    muted: false,
    solo: false,
    priority: 5,
    eq: { low: 0, mid: 0, high: 0 },
    sub: { transient: 1, body: 1, air: 1, tail: 1 },
    presetName: 'Custom',
  };
}

/* ------------------------------------------------------------------ */
/* Live mixer engine                                                   */
/* ------------------------------------------------------------------ */

interface StemNodes {
  input: GainNode;
  low: BiquadFilterNode;
  mid: BiquadFilterNode;
  high: BiquadFilterNode;
  panner: StereoPannerNode;
  cutoff: BiquadFilterNode;
  dry: GainNode;
  send: GainNode;
}

export class MixerEngine {
  private host: AudioHost;
  private stems = new Map<string, { stem: Stem; nodes: StemNodes }>();

  constructor(host: AudioHost) {
    this.host = host;
  }

  /** The input node other engines connect their voices to for a stem. */
  stemInput(id: string): GainNode | null {
    return this.stems.get(id)?.nodes.input ?? null;
  }

  addStem(stem: Stem): void {
    if (this.stems.has(stem.id)) return;
    const ctx = this.host.ctx;
    const input = ctx.createGain();
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 220;
    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1200;
    mid.Q.value = 0.9;
    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 5200;
    const panner = ctx.createStereoPanner();
    const cutoff = ctx.createBiquadFilter();
    cutoff.type = 'lowpass';
    const dry = ctx.createGain();
    const send = ctx.createGain();

    input.connect(low);
    low.connect(mid);
    mid.connect(high);
    high.connect(panner);
    panner.connect(cutoff);
    cutoff.connect(dry);
    dry.connect(this.host.bus);
    // Reverb send taps post-EQ, pre-pan for a stable space.
    high.connect(send);
    send.connect(this.host.convolver);

    this.stems.set(stem.id, { stem, nodes: { input, low, mid, high, panner, cutoff, dry, send } });
    this.applyStem(stem.id);
  }

  removeStem(id: string): void {
    const entry = this.stems.get(id);
    if (!entry) return;
    entry.nodes.input.disconnect();
    entry.nodes.send.disconnect();
    entry.nodes.dry.disconnect();
    this.stems.delete(id);
  }

  updateStem(stem: Stem): void {
    const entry = this.stems.get(stem.id);
    if (!entry) return;
    entry.stem = stem;
    this.applyStem(stem.id);
  }

  private applyStem(id: string): void {
    const entry = this.stems.get(id);
    if (!entry || !this.host.ctx) return;
    const { stem, nodes } = entry;
    const t = this.host.ctx.currentTime;
    const anySolo = [...this.stems.values()].some((e) => e.stem.solo);
    const audible = !stem.muted && (!anySolo || stem.solo);
    // StereoPannerNode implements equal-power panning natively; the
    // constant-power law in stereoGains() is the documented pure equivalent
    // used by tests and UI metering.
    nodes.panner.pan.setTargetAtTime(panForX(stem.position.x), t, 0.02);
    nodes.dry.gain.setTargetAtTime(audible ? distanceGain(stem.position.z) : 0, t, 0.02);
    nodes.cutoff.frequency.setTargetAtTime(cutoffFor(stem.position.z, stem.position.y), t, 0.02);
    nodes.send.gain.setTargetAtTime(audible ? reverbWet(stem.position.z) : 0, t, 0.02);
    nodes.low.gain.setTargetAtTime(stem.eq.low, t, 0.02);
    nodes.mid.gain.setTargetAtTime(stem.eq.mid, t, 0.02);
    nodes.high.gain.setTargetAtTime(stem.eq.high, t, 0.02);
  }

  getStemIds(): string[] {
    return [...this.stems.keys()];
  }
}
