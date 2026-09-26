import { describe, expect, it } from 'vitest';
import {
  PARALLEL_BUS_GAINS,
  RESONATOR_PRESET,
  biquadMagnitude,
  cascadeComplex,
  cascadeMagnitude,
  designBiquadHighpass,
  designBiquadLowpass,
  designCrossoverLR4,
  duckStep,
  encodeWavFloat32,
  followerCoeff,
  makeDuckState,
  midSideDecode,
  midSideEncode,
  normalizeGuarded,
  quantizeSample,
  reverseCopy,
  sumToMono,
  tapDelays,
} from '../src/audio/dsp.js';

describe('mid/side', () => {
  it('round-trips exactly', () => {
    const left = new Float32Array([0.5, -0.25, 0.1, -0.9, 0.0]);
    const right = new Float32Array([-0.5, 0.75, 0.1, 0.2, 1.0]);
    const { mid, side } = midSideEncode(left, right);
    expect(mid[0]).toBeCloseTo(0, 9);
    expect(side[0]).toBeCloseTo(0.5, 9);
    const { left: l2, right: r2 } = midSideDecode(mid, side);
    for (let i = 0; i < left.length; i++) {
      expect(l2[i]).toBeCloseTo(left[i], 6);
      expect(r2[i]).toBeCloseTo(right[i], 6);
    }
  });
  it('encodes dual-mono to mid-only', () => {
    const x = new Float32Array([0.3, 0.3]);
    const { mid, side } = midSideEncode(x, x);
    expect(side[0]).toBeCloseTo(0, 9);
    // Precision 6: mid is (0.3f + 0.3f) / 2 and 0.3 is not exact in float32.
    expect(mid[0]).toBeCloseTo(0.3, 6);
  });
});

describe('reverseCopy', () => {
  it('reverses and does not mutate', () => {
    const x = new Float32Array([1, 2, 3, 4]);
    expect(Array.from(reverseCopy(x))).toEqual([4, 3, 2, 1]);
    expect(Array.from(x)).toEqual([1, 2, 3, 4]);
  });
});

describe('normalizeGuarded', () => {
  it('peak-normalizes', () => {
    const out = normalizeGuarded(new Float32Array([0.5, -0.25, 0.1]));
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(-0.5, 6);
  });
  it('returns zeros for silent input (no division by zero)', () => {
    const out = normalizeGuarded(new Float32Array(8));
    expect(out.every((v) => v === 0)).toBe(true);
    expect(out.some((v) => Number.isNaN(v))).toBe(false);
  });
});

describe('tapDelays', () => {
  it('places taps at multiples of the base delay with decaying gain', () => {
    const taps = tapDelays(450, 3, 0.55, 1000);
    expect(taps).toHaveLength(3);
    expect(taps[0]).toEqual({ delaySamples: 450, gain: 0.55 });
    expect(taps[1]).toEqual({ delaySamples: 900, gain: 0.55 * 0.55 });
    expect(taps[2].delaySamples).toBe(1350);
    expect(taps[2].gain).toBeCloseTo(Math.pow(0.55, 3), 12);
  });
});

describe('encodeWavFloat32', () => {
  it('writes a valid 32-bit float WAV header', () => {
    const ch = new Float32Array([0.5, -0.5]);
    const wav = encodeWavFloat32([ch, ch], 48000);
    const tag = (o: number) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(12)).toBe('fmt ');
    expect(tag(36)).toBe('data');
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(3); // IEEE float
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(32);
    expect(wav.length).toBe(44 + 2 * 2 * 4);
    expect(view.getFloat32(44, true)).toBeCloseTo(0.5, 6);
  });
  it('rejects 3 channels', () => {
    expect(() => encodeWavFloat32([new Float32Array(4), new Float32Array(4), new Float32Array(4)], 44100)).toThrow();
  });
});

describe('quantizeSample', () => {
  it('reduces to the requested bit depth', () => {
    expect(quantizeSample(0.6, 1)).toBe(1);
    expect(quantizeSample(-0.6, 1)).toBe(-1);
    expect(quantizeSample(0.1, 1)).toBe(0);
  });
  it('is bounded in [-1, 1]', () => {
    for (let x = -1; x <= 1; x += 0.07) {
      const q = quantizeSample(x, 4);
      expect(q).toBeGreaterThanOrEqual(-1);
      expect(q).toBeLessThanOrEqual(1);
    }
  });
});

describe('followerCoeff', () => {
  it('is in (0, 1) and faster for shorter times', () => {
    const fast = followerCoeff(1, 48000);
    const slow = followerCoeff(100, 48000);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(1);
    // One-pole form y = c*y + (1-c)*x: a shorter time constant gives a
    // SMALLER coefficient (less memory), i.e. faster tracking.
    expect(fast).toBeLessThan(slow);
  });
});

describe('resonator preset + bus gains', () => {
  it('documents the 1234 Hz preset', () => {
    expect(RESONATOR_PRESET.frequency).toBe(1234);
  });
  it('parallel bus gains leave headroom', () => {
    const { anchor, spatial, resonator } = PARALLEL_BUS_GAINS;
    expect(anchor).toBe(0.8);
    expect(spatial).toBe(0.6);
    expect(resonator).toBe(0.7);
  });
});

describe('biquad design', () => {
  const sr = 48000;
  const db = (m: number) => 20 * Math.log10(Math.max(1e-12, m));

  it('Butterworth lowpass is -3.01 dB at fc, ~0 dB at DC, deep stopband', () => {
    const c = designBiquadLowpass(1000, sr);
    expect(db(biquadMagnitude(c, 1000, sr))).toBeCloseTo(-3.0103, 1);
    expect(db(biquadMagnitude(c, 10, sr))).toBeCloseTo(0, 1);
    expect(db(biquadMagnitude(c, 10000, sr))).toBeLessThan(-30);
  });

  it('Butterworth highpass mirrors the lowpass', () => {
    const c = designBiquadHighpass(1000, sr);
    expect(db(biquadMagnitude(c, 1000, sr))).toBeCloseTo(-3.0103, 1);
    expect(db(biquadMagnitude(c, 10000, sr))).toBeCloseTo(0, 1);
    expect(db(biquadMagnitude(c, 100, sr))).toBeLessThan(-30);
  });

  it('LR4 crossover: each band -6.02 dB at fc (90 Hz)', () => {
    const xo = designCrossoverLR4(90, sr);
    expect(db(cascadeMagnitude(xo.lowpass, 90, sr))).toBeCloseTo(-6.0206, 1);
    expect(db(cascadeMagnitude(xo.highpass, 90, sr))).toBeCloseTo(-6.0206, 1);
  });

  it('LR4 crossover sums in phase to unity: |LP + HP| = 1', () => {
    const xo = designCrossoverLR4(90, sr);
    for (const f of [20, 45, 90, 180, 360, 1000, 5000, 12000]) {
      const [lr, li] = cascadeComplex(xo.lowpass, f, sr);
      const [hr, hi] = cascadeComplex(xo.highpass, f, sr);
      const sumR = lr + hr;
      const sumI = li + hi;
      expect(Math.sqrt(sumR * sumR + sumI * sumI)).toBeCloseTo(1, 2);
    }
  });

  it('LR4 crossover passes its own band flat far from fc', () => {
    const xo = designCrossoverLR4(90, sr);
    expect(db(cascadeMagnitude(xo.lowpass, 9, sr))).toBeCloseTo(0, 1);
    expect(db(cascadeMagnitude(xo.highpass, 9000, sr))).toBeCloseTo(0, 1);
  });
});

describe('sumToMono', () => {
  it('averages the pair without mutating', () => {
    const l = new Float32Array([1, 2, 3]);
    const r = new Float32Array([3, 1, -1]);
    expect(Array.from(sumToMono(l, r))).toEqual([2, 1.5, 1]);
    expect(Array.from(l)).toEqual([1, 2, 3]);
  });
  it('dual-mono input comes back unchanged', () => {
    const x = new Float32Array([0.4, -0.7]);
    const out = sumToMono(x, x);
    // Precision 6: 0.4 and -0.7 are not exact in float32.
    expect(out[0]).toBeCloseTo(0.4, 6);
    expect(out[1]).toBeCloseTo(-0.7, 6);
  });
  it('uses the shorter length', () => {
    const out = sumToMono(new Float32Array([1, 2, 3]), new Float32Array([1, 1]));
    expect(out.length).toBe(2);
  });
});

describe('duckStep (kick-triggered sidechain)', () => {
  const step = (s: { depth: number }, hit: boolean) => duckStep(s, hit, 0.6, 5, 120, 1);

  it('ducks toward 1 - amount on kick, monotonically, bounded', () => {
    const s = makeDuckState();
    let prev = 1;
    let g = 1;
    for (let i = 0; i < 300; i++) {
      g = step(s, true);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      expect(g).toBeGreaterThanOrEqual(0.4 - 1e-9);
      prev = g;
    }
    expect(g).toBeCloseTo(0.4, 2);
  });

  it('releases back to unity after the kick, monotonically', () => {
    const s = makeDuckState();
    for (let i = 0; i < 300; i++) step(s, true);
    let prev = 0;
    let g = 0;
    for (let i = 0; i < 3000; i++) {
      g = step(s, false);
      expect(g).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(g).toBeLessThanOrEqual(1 + 1e-12);
      prev = g;
    }
    expect(g).toBeCloseTo(1, 2);
  });

  it('amount 0 never ducks; amount 1 ducks to silence', () => {
    const s0 = makeDuckState();
    for (let i = 0; i < 50; i++) expect(duckStep(s0, true, 0, 5, 120, 1)).toBe(1);
    const s1 = makeDuckState();
    let g = 1;
    for (let i = 0; i < 300; i++) g = duckStep(s1, true, 1, 5, 120, 1);
    expect(g).toBeCloseTo(0, 2);
  });
});
