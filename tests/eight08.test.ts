import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_BARS,
  AUTOMATION_END_HZ,
  AUTOMATION_MIN_HZ,
  AUTOMATION_STEPS,
  automationStepDur,
  automationSteps,
  automationToMidi,
  cc74ToHz,
  hzToCc74,
  logisticMap,
} from '../src/audio/eight08.js';
import { parseMidiFile } from '../src/audio/midi.js';

describe('automationSteps', () => {
  it('produces 16 steps from start to 1200 Hz', () => {
    const steps = automationSteps(40);
    expect(steps).toHaveLength(AUTOMATION_STEPS);
    expect(steps[0]).toBe(40);
    expect(steps[steps.length - 1]).toBe(AUTOMATION_END_HZ);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    }
  });
  it('is evenly spaced', () => {
    const steps = automationSteps(20);
    const d = steps[1] - steps[0];
    for (let i = 2; i < steps.length; i++) {
      expect(steps[i] - steps[i - 1]).toBeCloseTo(d, 9);
    }
  });
});

describe('Hz <-> CC74 mapping', () => {
  it('maps documented endpoints', () => {
    expect(hzToCc74(AUTOMATION_MIN_HZ)).toBe(0);
    expect(hzToCc74(AUTOMATION_END_HZ)).toBe(127);
    expect(cc74ToHz(0)).toBe(AUTOMATION_MIN_HZ);
    expect(cc74ToHz(127)).toBe(AUTOMATION_END_HZ);
  });
  it('clamps out-of-range Hz', () => {
    expect(hzToCc74(5)).toBe(0);
    expect(hzToCc74(5000)).toBe(127);
  });
  it('round-trips within half a CC step', () => {
    for (const hz of [40, 200, 600, 1000]) {
      const back = cc74ToHz(hzToCc74(hz));
      expect(Math.abs(back - hz)).toBeLessThan((AUTOMATION_END_HZ - AUTOMATION_MIN_HZ) / 127);
    }
  });
});

describe('automationStepDur', () => {
  it('16 steps span 4 bars at the given BPM', () => {
    const bpm = 140;
    const total = automationStepDur(bpm) * AUTOMATION_STEPS;
    expect(total).toBeCloseTo((60 / bpm) * 4 * AUTOMATION_BARS, 9);
  });
  it('halves when BPM doubles', () => {
    expect(automationStepDur(140)).toBeCloseTo(automationStepDur(70) / 2, 9);
  });
});

describe('logisticMap', () => {
  it('computes r*x*(1-x)', () => {
    expect(logisticMap(0.5)).toBeCloseTo(3.9 * 0.25, 12);
  });
  it('stays bounded in [0, 1]', () => {
    let x = 0.3;
    for (let i = 0; i < 500; i++) {
      x = logisticMap(x);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});

describe('automationToMidi', () => {
  it('writes a parseable file with 16 CC74 events and paired note on/off', () => {
    const bytes = automationToMidi({ note: 36, bpm: 140, startCutoff: 40, resonance: 64 });
    const parsed = parseMidiFile(bytes);
    const on = parsed.events.filter((e) => e.kind === 'noteOn');
    const off = parsed.events.filter((e) => e.kind === 'noteOff');
    const ccs = parsed.events.filter((e) => e.kind === 'cc');
    expect(on).toHaveLength(1);
    expect(off).toHaveLength(1);
    expect(on[0].tick).toBe(0);
    expect(off[0].tick).toBeGreaterThan(0);
    expect(ccs).toHaveLength(16);
    for (const cc of ccs) {
      if (cc.kind !== 'cc') continue;
      expect(cc.controller).toBe(74);
      expect(cc.value).toBeGreaterThanOrEqual(0);
      expect(cc.value).toBeLessThanOrEqual(127);
    }
    // CC values rise with the sweep.
    const vals = ccs.map((c) => (c.kind === 'cc' ? c.value : -1));
    expect(vals[vals.length - 1]).toBeGreaterThan(vals[0]);
  });
});
