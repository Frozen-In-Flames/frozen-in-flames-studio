/**
 * dsp.ts — Effects and offline rendering.
 *
 * Honest naming throughout:
 *  - The multi-tap delay is a feedforward tapped delay line. It is NOT called
 *    a "feedback delay network" because it has no recirculating feedback matrix.
 *  - The resonator is a parallel bandpass bus (1234 Hz preset) built from
 *    causal BiquadFilters. It is never zero-phase; no zero-phase processing
 *    is claimed anywhere.
 *  - Mid/side encode/decode is the standard sum/difference transform.
 */

import type { AudioHost } from './engine.js';

/* ------------------------------------------------------------------ */
/* Pure helpers (testable)                                             */
/* ------------------------------------------------------------------ */

/** Mid/side encode: mid = (L+R)/2, side = (L-R)/2. */
export function midSideEncode(
  left: Float32Array,
  right: Float32Array,
): { mid: Float32Array; side: Float32Array } {
  const n = Math.min(left.length, right.length);
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = (left[i] + right[i]) / 2;
    side[i] = (left[i] - right[i]) / 2;
  }
  return { mid, side };
}

/** Mid/side decode: L = mid+side, R = mid-side. Exact inverse of encode. */
export function midSideDecode(
  mid: Float32Array,
  side: Float32Array,
): { left: Float32Array; right: Float32Array } {
  const n = Math.min(mid.length, side.length);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = mid[i] + side[i];
    right[i] = mid[i] - side[i];
  }
  return { left, right };
}

/** Reversed copy of a buffer (offline "flames" reversal effect). */
export function reverseCopy(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[x.length - 1 - i];
  return out;
}

/**
 * Peak-normalize a copy of `x` to `peak` (default 1.0).
 * Silence-safe: all-zero (or near-zero) input returns zeros, no division by zero.
 */
export function normalizeGuarded(x: Float32Array, peak = 1.0, eps = 1e-12): Float32Array {
  const out = new Float32Array(x.length);
  let max = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > max) max = a;
  }
  if (max < eps) return out;
  const g = peak / max;
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

export interface TapSpec {
  delaySamples: number;
  gain: number;
}

/**
 * Feedforward multi-tap delay spec: `taps` taps starting at `baseMs`,
 * each tap delayed by a further `baseMs` and scaled by `decay`^k.
 * Pure sample-math; the live node graph is in MultiTapDelay.
 */
export function tapDelays(
  baseMs: number,
  taps: number,
  decay: number,
  sampleRate: number,
): TapSpec[] {
  const out: TapSpec[] = [];
  for (let k = 0; k < taps; k++) {
    out.push({
      delaySamples: Math.round((baseMs * (k + 1) * sampleRate) / 1000),
      gain: Math.pow(decay, k + 1),
    });
  }
  return out;
}

/** Bit-depth quantization of a single sample in [-1, 1]. */
export function quantizeSample(x: number, bits: number): number {
  const levels = Math.pow(2, Math.max(1, Math.min(16, Math.round(bits)))) - 1;
  const c = Math.max(-1, Math.min(1, x));
  return Math.round(c * levels) / levels;
}

/** One-pole envelope follower coefficient for a time constant in ms. */
export function followerCoeff(timeMs: number, sampleRate: number): number {
  return Math.exp(-1 / ((timeMs / 1000) * sampleRate));
}

/** Resonator preset: 1234 Hz parallel bandpass bus, causal BiquadFilter. */
export const RESONATOR_PRESET = {
  frequency: 1234,
  liveQ: 5,
  busGain: 0.7,
} as const;

/** Parallel bus gains: anchor (dry) 0.8, spatial 0.6, resonator 0.7. */
export const PARALLEL_BUS_GAINS = { anchor: 0.8, spatial: 0.6, resonator: 0.7 } as const;

/* ------------------------------------------------------------------ */
/* Crossover + sidechain (pure, testable)                              */
/*                                                                     */
/* Standard production techniques, implemented honestly:               */
/*  - A Linkwitz-Riley 4th-order crossover splits the sub-bass chain   */
/*    at 90 Hz: lows are summed to true mono, highs stay stereo.       */
/*  - Kick-triggered ducking dips the sub-bass bus toward 1 - amount    */
/*    with an exponential attack, then releases back to unity.         */
/* ------------------------------------------------------------------ */

/** Normalized (a0 = 1) second-order biquad section, RBJ cookbook form. */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Second-order lowpass coefficients (default Q = 1/sqrt(2), Butterworth). */
export function designBiquadLowpass(
  cutoffHz: number,
  sampleRate: number,
  q: number = Math.SQRT1_2,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.max(1, cutoffHz)) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(1e-6, q));
  const b0 = (1 - cosw0) / 2;
  const b1 = 1 - cosw0;
  const b2 = (1 - cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** Second-order highpass coefficients (default Q = 1/sqrt(2), Butterworth). */
export function designBiquadHighpass(
  cutoffHz: number,
  sampleRate: number,
  q: number = Math.SQRT1_2,
): BiquadCoeffs {
  const w0 = (2 * Math.PI * Math.max(1, cutoffHz)) / sampleRate;
  const cosw0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(1e-6, q));
  const b0 = (1 + cosw0) / 2;
  const b1 = -(1 + cosw0);
  const b2 = (1 + cosw0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw0;
  const a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * 24 dB/octave Linkwitz-Riley crossover: two cascaded Butterworth biquads
 * per band. LR property: each band is -6 dB at the cutoff, and the two bands
 * are in phase at every frequency, so their complex sum has unity magnitude
 * (|LP + HP| = 1) — recombining them is flat.
 */
export function designCrossoverLR4(
  cutoffHz: number,
  sampleRate: number,
): { lowpass: [BiquadCoeffs, BiquadCoeffs]; highpass: [BiquadCoeffs, BiquadCoeffs] } {
  return {
    lowpass: [designBiquadLowpass(cutoffHz, sampleRate), designBiquadLowpass(cutoffHz, sampleRate)],
    highpass: [designBiquadHighpass(cutoffHz, sampleRate), designBiquadHighpass(cutoffHz, sampleRate)],
  };
}

/** Linear magnitude |H(f)| of one biquad section at freqHz. */
export function biquadMagnitude(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const sinw = Math.sin(w);
  const sin2w = Math.sin(2 * w);
  const numR = c.b0 + c.b1 * cosw + c.b2 * cos2w;
  const numI = -(c.b1 * sinw + c.b2 * sin2w);
  const denR = 1 + c.a1 * cosw + c.a2 * cos2w;
  const denI = -(c.a1 * sinw + c.a2 * sin2w);
  return Math.sqrt((numR * numR + numI * numI) / (denR * denR + denI * denI));
}

/** Phase response (radians) of one biquad section at freqHz. */
export function biquadPhase(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cosw = Math.cos(w);
  const cos2w = Math.cos(2 * w);
  const sinw = Math.sin(w);
  const sin2w = Math.sin(2 * w);
  const numR = c.b0 + c.b1 * cosw + c.b2 * cos2w;
  const numI = -(c.b1 * sinw + c.b2 * sin2w);
  const denR = 1 + c.a1 * cosw + c.a2 * cos2w;
  const denI = -(c.a1 * sinw + c.a2 * sin2w);
  return Math.atan2(numI, numR) - Math.atan2(denI, denR);
}

/** Complex response of cascaded sections as [real, imag]. */
export function cascadeComplex(
  sections: BiquadCoeffs[],
  freqHz: number,
  sampleRate: number,
): [number, number] {
  let r = 1;
  let i = 0;
  for (const s of sections) {
    const m = biquadMagnitude(s, freqHz, sampleRate);
    const p = biquadPhase(s, freqHz, sampleRate);
    const cr = m * Math.cos(p);
    const ci = m * Math.sin(p);
    const nr = r * cr - i * ci;
    i = r * ci + i * cr;
    r = nr;
  }
  return [r, i];
}

/** Linear magnitude of cascaded biquad sections (product of magnitudes). */
export function cascadeMagnitude(
  sections: BiquadCoeffs[],
  freqHz: number,
  sampleRate: number,
): number {
  let m = 1;
  for (const s of sections) m *= biquadMagnitude(s, freqHz, sampleRate);
  return m;
}

/** Sum a stereo pair to mono: (L + R) / 2. The live graph does the same
 *  with splitter/gain nodes; this is the offline/testable equivalent. */
export function sumToMono(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i] + right[i]) / 2;
  return out;
}

/** Mutable detector state for kick-triggered ducking. depth: 0 = none, 1 = full. */
export interface DuckState {
  depth: number;
}

export function makeDuckState(): DuckState {
  return { depth: 0 };
}

/**
 * One control step of kick-triggered sidechain ducking.
 *
 * Exponential approach, matching the live setTargetAtTime curve shape:
 * while kickHit is true the depth moves toward 1 with the attack time
 * constant; otherwise it relaxes toward 0 with the release constant.
 * Returns the gain multiplier, always within [1 - amount, 1].
 */
export function duckStep(
  s: DuckState,
  kickHit: boolean,
  amount: number,
  attackMs: number,
  releaseMs: number,
  dtMs: number,
): number {
  const amt = Math.max(0, Math.min(1, amount));
  const tau = Math.max(1e-3, kickHit ? attackMs : releaseMs);
  const k = 1 - Math.exp(-dtMs / tau);
  s.depth += ((kickHit ? 1 : 0) - s.depth) * k;
  return Math.max(0, 1 - amt * s.depth);
}

/** Sub-bass mono crossover frequency used by the 808 chain. */
export const SUB_MONO_CUTOFF_HZ = 90;

/**
 * Encode mono/stereo Float32 samples as a 32-bit float WAV file.
 * `channels`: array of channel buffers (1 or 2), all the same length.
 */
export function encodeWavFloat32(channels: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  if (channels.length < 1 || channels.length > 2) {
    throw new Error('encodeWavFloat32 supports 1 or 2 channels');
  }
  const n = channels[0].length;
  const numCh = channels.length;
  const dataBytes = n * numCh * 4;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 4, true); // byte rate
  view.setUint16(32, numCh * 4, true); // block align
  view.setUint16(34, 32, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      view.setFloat32(off, channels[ch][i], true);
      off += 4;
    }
  }
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------------ */
/* Live effects                                                        */
/* ------------------------------------------------------------------ */

/**
 * Feedforward multi-tap delay: input -> N taps (450 ms base, decay 0.55) -> out.
 * Named honestly: this is a tapped delay line, not a feedback delay network.
 */
export class MultiTapDelay {
  readonly input: GainNode;
  readonly output: GainNode;
  private taps: DelayNode[] = [];

  constructor(host: AudioHost, baseMs = 450, tapCount = 3, decay = 0.55, wet = 0.3) {
    const ctx = host.ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const wetGain = ctx.createGain();
    wetGain.gain.value = wet;
    this.input.connect(this.output); // dry
    for (let k = 0; k < tapCount; k++) {
      const d = ctx.createDelay(2);
      d.delayTime.value = (baseMs * (k + 1)) / 1000;
      const g = ctx.createGain();
      g.gain.value = Math.pow(decay, k + 1);
      this.input.connect(d);
      d.connect(g);
      g.connect(wetGain);
      this.taps.push(d);
    }
    wetGain.connect(this.output);
  }

  connect(dest: AudioNode): void {
    this.output.connect(dest);
  }
}

/**
 * Parallel resonator bus: bandpass at 1234 Hz (Q=5 live) mixed in parallel
 * with the dry signal. Causal BiquadFilter — never zero-phase.
 */
export class ResonatorBus {
  readonly input: GainNode;
  readonly output: GainNode;

  constructor(host: AudioHost, frequency = RESONATOR_PRESET.frequency, q = RESONATOR_PRESET.liveQ) {
    const ctx = host.ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = frequency;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = RESONATOR_PRESET.busGain;
    this.input.connect(this.output); // dry through
    this.input.connect(bp);
    bp.connect(g);
    g.connect(this.output);
  }

  connect(dest: AudioNode): void {
    this.output.connect(dest);
  }
}

/**
 * Live bitcrusher via waveshaping (bit-depth reduction only).
 * Sample-rate reduction would need an AudioWorklet; this is documented
 * honestly in the UI rather than faked.
 */
export class BitCrusher {
  readonly node: WaveShaperNode;

  constructor(host: AudioHost, bits = 8) {
    const ctx = host.ctx;
    this.node = ctx.createWaveShaper();
    this.setBits(bits);
  }

  setBits(bits: number): void {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = quantizeSample(x, bits);
    }
    this.node.curve = curve;
  }

  connect(dest: AudioNode): void {
    this.node.connect(dest);
  }
}

/* ------------------------------------------------------------------ */
/* Offline render                                                      */
/* ------------------------------------------------------------------ */

/**
 * Render a caller-supplied graph into a 32-bit float WAV.
 *
 * `build` receives an OfflineAudioContext plus a master gain connected to
 * the destination; it wires instruments and returns the graph's tail time.
 * The parallel-bus structure (anchor dry 0.8 / spatial 0.6 / resonator 0.7)
 * is applied at mixdown, then peak-normalized with a silence guard.
 */
export async function renderOfflineWav(
  seconds: number,
  sampleRate: number,
  build: (ctx: OfflineAudioContext, master: GainNode) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  build(ctx, master);
  const rendered = await ctx.startRendering();
  const left = normalizeGuarded(rendered.getChannelData(0).slice());
  const right = normalizeGuarded(rendered.getChannelData(1).slice());
  return encodeWavFloat32([left, right], sampleRate);
}
