import { describe, expect, it } from 'vitest';
import { channelShift, mirrorIndex } from '../src/visuals.js';

describe('mirrorIndex', () => {
  it('mirrors the right half onto the left for even widths', () => {
    expect(mirrorIndex(0, 10)).toBe(0);
    expect(mirrorIndex(4, 10)).toBe(4);
    expect(mirrorIndex(5, 10)).toBe(4);
    expect(mirrorIndex(9, 10)).toBe(0);
  });
  it('keeps the center column on odd widths', () => {
    expect(mirrorIndex(5, 11)).toBe(5);
    expect(mirrorIndex(6, 11)).toBe(4);
    expect(mirrorIndex(10, 11)).toBe(0);
  });
  it('never indexes out of bounds', () => {
    for (const w of [1, 2, 7, 100, 101]) {
      for (let x = 0; x < w; x++) {
        const m = mirrorIndex(x, w);
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThan(w);
      }
    }
  });
});

describe('channelShift', () => {
  it('clamps to +-maxPx', () => {
    expect(channelShift(100, 48)).toBe(48);
    expect(channelShift(-100, 48)).toBe(-48);
    expect(channelShift(12, 48)).toBe(12);
  });
});
