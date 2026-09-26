import { describe, expect, it } from 'vitest';
import {
  A4_HZ,
  C4_HZ,
  JUST_RATIOS,
  PYTHAGOREAN_RATIOS,
  centsOffset,
  edoFreq,
  freqForNote,
  midiToFreq,
  noteToKeyIndex,
} from '../src/audio/tuning.js';

describe('midiToFreq', () => {
  it('maps MIDI 69 to 440 Hz', () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 10);
  });
  it('maps MIDI 60 to ~261.63 Hz', () => {
    expect(midiToFreq(60)).toBeCloseTo(261.6256, 3);
  });
  it('is an octave per 12 semitones', () => {
    expect(midiToFreq(81) / midiToFreq(69)).toBeCloseTo(2, 10);
  });
  it('A4_HZ constant is 440', () => {
    expect(A4_HZ).toBe(440);
  });
});

describe('edoFreq', () => {
  it.each([12, 19, 24, 31])('closes the octave for %i-EDO', (edo) => {
    expect(edoFreq(edo, edo) / edoFreq(edo, 0)).toBeCloseTo(2, 10);
  });
  it('12-EDO matches midiToFreq', () => {
    expect(edoFreq(12, 9)).toBeCloseTo(midiToFreq(69), 10); // C4 + 9 steps = A4
  });
});

describe('ratio tables', () => {
  it('just intonation has 12 ratios with unison and fifth', () => {
    expect(JUST_RATIOS).toHaveLength(12);
    expect(JUST_RATIOS[0]).toBe(1);
    expect(JUST_RATIOS[7]).toBeCloseTo(3 / 2, 12);
    expect(JUST_RATIOS[4]).toBeCloseTo(5 / 4, 12);
  });
  it('pythagorean has 12 ratios with unison and fifth', () => {
    expect(PYTHAGOREAN_RATIOS).toHaveLength(12);
    expect(PYTHAGOREAN_RATIOS[0]).toBe(1);
    expect(PYTHAGOREAN_RATIOS[7]).toBeCloseTo(3 / 2, 12);
  });
});

describe('centsOffset', () => {
  it('1200 cents is an octave up', () => {
    expect(centsOffset(440, 1200)).toBeCloseTo(880, 8);
  });
  it('-1200 cents is an octave down', () => {
    expect(centsOffset(440, -1200)).toBeCloseTo(220, 8);
  });
  it('0 cents is identity', () => {
    expect(centsOffset(440, 0)).toBe(440);
  });
});

describe('noteToKeyIndex', () => {
  it('maps MIDI 60 to 0 with octave wrap', () => {
    expect(noteToKeyIndex(60)).toBe(0);
    expect(noteToKeyIndex(72)).toBe(0);
    expect(noteToKeyIndex(48)).toBe(0);
    expect(noteToKeyIndex(61)).toBe(1);
    expect(noteToKeyIndex(59)).toBe(11);
  });
});

describe('freqForNote', () => {
  it('12-EDO A4 is 440 Hz', () => {
    expect(freqForNote(69, 'edo12')).toBeCloseTo(440, 8);
  });
  it('just intonation fifth above C4 is 3/2', () => {
    expect(freqForNote(67, 'just') / C4_HZ).toBeCloseTo(3 / 2, 10);
  });
  it('pythagorean fifth above C4 is 3/2', () => {
    expect(freqForNote(67, 'pythagorean') / C4_HZ).toBeCloseTo(3 / 2, 10);
  });
  it('19/24/31-EDO close the octave', () => {
    expect(freqForNote(72, 'edo19') / freqForNote(60, 'edo19')).toBeGreaterThan(1.9);
    expect(freqForNote(72, 'edo19') / freqForNote(60, 'edo19')).toBeLessThan(2.1);
    expect(freqForNote(72, 'edo24') / freqForNote(60, 'edo24')).toBeCloseTo(2, 6);
    expect(freqForNote(72, 'edo31') / freqForNote(60, 'edo31')).toBeGreaterThan(1.9);
    expect(freqForNote(72, 'edo31') / freqForNote(60, 'edo31')).toBeLessThan(2.1);
  });
  it('applies cents offset', () => {
    expect(freqForNote(69, 'edo12', 100)).toBeCloseTo(440 * Math.pow(2, 100 / 1200), 8);
  });
});
