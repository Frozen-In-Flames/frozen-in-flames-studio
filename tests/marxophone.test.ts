import { describe, expect, it } from 'vitest';
import {
  HammerEnvelope,
  bounceVelocity,
  chooseVoiceToSteal,
  makeTubeCurve,
  polyblep,
  velocityCurve,
  type VoiceSlot,
} from '../src/audio/marxophone.js';

describe('makeTubeCurve', () => {
  const curve = makeTubeCurve(1024, 2.5);
  it('is odd-symmetric', () => {
    for (const i of [0, 1, 100, 511]) {
      expect(curve[i]).toBeCloseTo(-curve[curve.length - 1 - i], 6);
    }
  });
  it('is monotonically increasing', () => {
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    }
  });
  it('is bounded in [-1, 1]', () => {
    for (let i = 0; i < curve.length; i += 37) {
      expect(Math.abs(curve[i])).toBeLessThanOrEqual(1);
    }
  });
  it('passes through zero', () => {
    expect(curve[511]).toBeCloseTo(0, 2);
    expect(curve[512]).toBeCloseTo(0, 2);
  });
});

describe('bounceVelocity', () => {
  it('starts at 0.75', () => {
    expect(bounceVelocity(0)).toBeCloseTo(0.75, 12);
  });
  it('stays within [0.6, 0.9]', () => {
    for (let i = 0; i < 200; i++) {
      const v = bounceVelocity(i);
      expect(v).toBeGreaterThanOrEqual(0.6);
      expect(v).toBeLessThanOrEqual(0.9);
    }
  });
});

describe('polyblep', () => {
  it('is zero away from discontinuities', () => {
    expect(polyblep(0.5, 0.01)).toBe(0);
  });
  it('is bounded', () => {
    for (let p = 0; p < 1; p += 0.001) {
      expect(Math.abs(polyblep(p, 0.02))).toBeLessThanOrEqual(1.01);
    }
  });
});

describe('velocityCurve', () => {
  it('maps 0->0 and 1->1', () => {
    expect(velocityCurve(0)).toBe(0);
    expect(velocityCurve(1)).toBeCloseTo(1, 12);
  });
  it('clamps out-of-range input', () => {
    expect(velocityCurve(-0.5)).toBe(0);
    expect(velocityCurve(2)).toBeCloseTo(1, 12);
  });
});

describe('HammerEnvelope', () => {
  it('is silent before note-on', () => {
    const e = new HammerEnvelope();
    e.noteOn(1);
    expect(e.level(0.5)).toBe(0);
  });
  it('attacks from 0 to 1', () => {
    const e = new HammerEnvelope(0.004, 0.7, 0, 0.25);
    e.noteOn(0);
    expect(e.level(0)).toBe(0);
    expect(e.level(0.002)).toBeCloseTo(0.5, 6);
    expect(e.level(0.004)).toBeCloseTo(1, 6);
  });
  it('release starts from the CURRENT level, not sustain', () => {
    const e = new HammerEnvelope(0.004, 0.7, 0, 0.25);
    e.noteOn(0);
    // Release mid-attack: current level is ~0.5, sustain is 0.
    e.noteOff(0.002);
    expect(e.level(0.002)).toBeCloseTo(0.5, 6);
    // ...and it decays from there, not from 1 or 0.
    const justAfter = e.level(0.01);
    expect(justAfter).toBeLessThan(0.5);
    expect(justAfter).toBeGreaterThan(0);
  });
  it('release from decay continues smoothly downward', () => {
    const e = new HammerEnvelope(0.004, 0.7, 0, 0.25);
    e.noteOn(0);
    const atOff = 0.2;
    const levelAtOff = e.level(atOff);
    e.noteOff(atOff);
    expect(e.level(atOff)).toBeCloseTo(levelAtOff, 9);
    expect(e.level(atOff + 0.05)).toBeLessThan(levelAtOff);
  });
  it('decays toward zero over time', () => {
    const e = new HammerEnvelope(0.004, 0.7, 0, 0.25);
    e.noteOn(0);
    expect(e.level(5)).toBeLessThan(0.01);
  });
});

describe('chooseVoiceToSteal', () => {
  const slot = (over: Partial<VoiceSlot>): VoiceSlot => ({
    active: true,
    releasing: false,
    level: 0.5,
    midi: 60,
    startedAt: 0,
    ...over,
  });
  it('prefers a releasing voice', () => {
    const slots = [slot({ releasing: false, level: 0.9 }), slot({ releasing: true, level: 0.9 })];
    expect(chooseVoiceToSteal(slots)).toBe(1);
  });
  it('otherwise steals the quietest voice', () => {
    const slots = [slot({ level: 0.8 }), slot({ level: 0.1 }), slot({ level: 0.5 })];
    expect(chooseVoiceToSteal(slots)).toBe(1);
  });
  it('breaks level ties by oldest start', () => {
    const slots = [slot({ level: 0.3, startedAt: 5 }), slot({ level: 0.3, startedAt: 2 })];
    expect(chooseVoiceToSteal(slots)).toBe(1);
  });
});
