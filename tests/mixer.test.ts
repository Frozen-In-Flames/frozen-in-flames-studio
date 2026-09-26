import { describe, expect, it } from 'vitest';
import {
  COLLISION_THRESHOLD,
  autoMask,
  autoScatter,
  cutoffFor,
  detectCollisions,
  distanceGain,
  makeStem,
  panForX,
  reverbWet,
  stereoGains,
} from '../src/audio/mixer.js';

describe('panForX / stereoGains', () => {
  it('maps field edges to full pan and clamps', () => {
    expect(panForX(-10)).toBe(-1);
    expect(panForX(0)).toBe(0);
    expect(panForX(10)).toBe(1);
    expect(panForX(-25)).toBe(-1);
    expect(panForX(25)).toBe(1);
  });
  it('obeys the constant-power law L^2 + R^2 = 1', () => {
    for (const pan of [-1, -0.7, -0.25, 0, 0.33, 0.8, 1]) {
      const { left, right } = stereoGains(pan);
      expect(left * left + right * right).toBeCloseTo(1, 12);
    }
  });
  it('hard-pans correctly', () => {
    expect(stereoGains(-1)).toMatchObject({ left: 1, right: 0 });
    expect(stereoGains(1).left).toBeCloseTo(0, 12);
    expect(stereoGains(1).right).toBeCloseTo(1, 12);
    const c = stereoGains(0);
    expect(c.left).toBeCloseTo(Math.SQRT1_2, 12);
    expect(c.right).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('distanceGain', () => {
  it('is 1.0 at front, 0.12 at back', () => {
    expect(distanceGain(-10)).toBeCloseTo(1, 12);
    expect(distanceGain(10)).toBeCloseTo(0.12, 12);
  });
  it('decreases monotonically with z', () => {
    expect(distanceGain(-5)).toBeGreaterThan(distanceGain(0));
    expect(distanceGain(0)).toBeGreaterThan(distanceGain(5));
  });
});

describe('cutoffFor', () => {
  it('spans 800 Hz to 20 kHz at the corners', () => {
    expect(cutoffFor(-10, -10)).toBeCloseTo(800, 6);
    expect(cutoffFor(10, 10)).toBeCloseTo(20000, 0);
  });
});

describe('reverbWet', () => {
  it('spans 0.05 to 0.85', () => {
    expect(reverbWet(-10)).toBeCloseTo(0.05, 12);
    expect(reverbWet(10)).toBeCloseTo(0.85, 12);
  });
});

describe('detectCollisions', () => {
  it('finds a head-on collision with severity 1', () => {
    const a = makeStem('A', 'melody', '#fff');
    const b = makeStem('B', 'melody', '#fff');
    const cols = detectCollisions([a, b]);
    expect(cols).toHaveLength(1);
    expect(cols[0].severity).toBeCloseTo(1, 9);
    expect(cols[0].zone).toBe('Mid-Range Masking');
  });
  it('labels bass involvement as Low-End Rumble', () => {
    const a = makeStem('A', 'bass', '#fff');
    const b = makeStem('B', 'melody', '#fff');
    b.position.x = 1;
    const cols = detectCollisions([a, b]);
    expect(cols[0].zone).toBe('Low-End Rumble');
  });
  it('ignores pairs at or beyond the threshold', () => {
    const a = makeStem('A', 'melody', '#fff');
    const b = makeStem('B', 'melody', '#fff');
    b.position.x = COLLISION_THRESHOLD;
    expect(detectCollisions([a, b])).toHaveLength(0);
  });
  it('computes severity = 1 - dist/3.5', () => {
    const a = makeStem('A', 'melody', '#fff');
    const b = makeStem('B', 'melody', '#fff');
    b.position.x = 1.75;
    const cols = detectCollisions([a, b]);
    expect(cols[0].severity).toBeCloseTo(0.5, 9);
  });
});

describe('autoScatter', () => {
  it('separates a colliding pair beyond the threshold', () => {
    const a = makeStem('A', 'melody', '#fff');
    const b = makeStem('B', 'melody', '#fff');
    b.position.x = 0.5;
    const scattered = autoScatter([a, b]);
    expect(detectCollisions(scattered)).toHaveLength(0);
  });
  it('does not mutate the input', () => {
    const a = makeStem('A', 'melody', '#fff');
    const before = a.position.x;
    autoScatter([a]);
    expect(a.position.x).toBe(before);
  });
});

describe('autoMask', () => {
  it('pushes the lower-priority stem back in +z on severe collisions', () => {
    const a = makeStem('A', 'melody', '#fff');
    a.priority = 9;
    const b = makeStem('B', 'melody', '#fff');
    b.priority = 1;
    b.position.x = 0.5; // severity ~0.857 > 0.4
    const masked = autoMask([a, b]);
    const loser = masked.find((s) => s.id === b.id);
    expect(loser?.position.z).toBeGreaterThan(0);
    const winner = masked.find((s) => s.id === a.id);
    expect(winner?.position.z).toBe(0);
  });
  it('leaves mild collisions alone', () => {
    const a = makeStem('A', 'melody', '#fff');
    const b = makeStem('B', 'melody', '#fff');
    b.position.x = 3.0; // severity ~0.143 < 0.4
    const masked = autoMask([a, b]);
    expect(masked.find((s) => s.id === b.id)?.position.z).toBe(0);
  });
});
