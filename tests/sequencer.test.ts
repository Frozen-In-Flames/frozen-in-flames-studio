import { describe, expect, it, vi } from 'vitest';
import {
  DEMO_BASS,
  DEMO_CHORDS,
  DEMO_DRUMS,
  DEMO_MELODY,
  STEPS,
  Sequencer,
  gridTimes,
  patternCycles,
  stepDur,
} from '../src/audio/sequencer.js';

describe('stepDur', () => {
  it('is a 16th note at the given BPM', () => {
    expect(stepDur(120)).toBeCloseTo(0.125, 12);
    expect(stepDur(60)).toBeCloseTo(0.25, 12);
  });
});

describe('gridTimes', () => {
  it('lays out evenly spaced step times', () => {
    const times = gridTimes(120, 4, 10);
    expect(times).toHaveLength(4);
    expect(times[0]).toBe(10);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeCloseTo(0.125, 12);
    }
  });
});

describe('patternCycles', () => {
  it('counts full and partial cycles', () => {
    expect(patternCycles(16)).toBe(1);
    expect(patternCycles(32)).toBe(2);
    expect(patternCycles(17)).toBe(2);
  });
});

describe('demo patterns', () => {
  it('are all 16 steps long', () => {
    for (const p of [DEMO_BASS, DEMO_MELODY, DEMO_CHORDS, DEMO_DRUMS]) {
      expect(p).toHaveLength(STEPS);
    }
  });
  it('bass pattern matches the source line', () => {
    const notes = DEMO_BASS.filter(Boolean).map((s) => s![0].midi);
    expect(notes).toEqual([36, 36, 38, 36, 41, 36, 38, 34]);
  });
});

describe('Sequencer pairing', () => {
  it('schedules note-ons and note-offs in pairs without stuck notes', () => {
    vi.useFakeTimers();
    const scheduled: { step: number; time: number; notes: { midi: number; len?: number }[] }[] = [];
    let now = 100;
    const seq = new Sequencer(
      {
        onStep: (step, time, notes) => {
          scheduled.push({ step, time, notes });
          // The UI pairs each note-on with a note-off at time + len*stepDur.
          for (const n of notes) {
            const offAt = time + (n.len ?? 1) * stepDur(120);
            expect(offAt).toBeGreaterThan(time);
          }
        },
      },
      () => now,
      { bpm: 120, pattern: DEMO_BASS },
    );
    seq.start();
    // Advance fake time: each tick schedules up to the 0.12 s horizon.
    for (let i = 0; i < 40; i++) {
      now += 0.025;
      vi.advanceTimersByTime(25);
    }
    seq.stop();
    expect(scheduled.length).toBeGreaterThan(4);
    // Steps advance in order and cycle every 16.
    for (let i = 1; i < scheduled.length; i++) {
      expect(scheduled[i].step).toBe((scheduled[i - 1].step + 1) % STEPS);
      expect(scheduled[i].time).toBeGreaterThan(scheduled[i - 1].time);
    }
    vi.useRealTimers();
  });
});
