/**
 * eight08.ts — 808 sub-bass voice, procedural drums, and filter automation.
 *
 * 808 voice: sine oscillator with pitch envelope + click transient +
 * saturation, through a 24 dB/octave lowpass (two cascaded biquads).
 * ADSR (0.05 / 0.2 / 0.9 / 0.5) follows the source parameter model.
 *
 * Sub-bass chain: 808 voices run through a 24 dB/oct Linkwitz-Riley
 * crossover at 90 Hz — lows summed to true mono, highs stereo — then a
 * kick-triggered sidechain duck (see duckAt/setSidechain). Kick/snare/hat
 * stay dry on the host bus; the kick is the ducking trigger.
 *
 * Filter automation mapping (ONE honest, documented mapping):
 *  - The UI cutoff slider is in Hz: 20–200 Hz (default 40 Hz).
 *  - The 16-step sweep renders startHz -> 1200 Hz over 4 bars.
 *  - MIDI export scales the same sweep to CC74 as
 *      cc = round(127 * (hz - 20) / (1200 - 20)), clamped to 0..127.
 *  - Resonance is filter Q = ccValue / 10 and is labeled as such in the UI;
 *    this app does not emit live MIDI CC, so it is not labeled "CC 71".
 */

import type { AudioHost } from './engine.js';
import { midiToFreq } from './tuning.js';
import { writeMidiFile, type MidiEvent } from './midi.js';
import { polyblep } from './marxophone.js';
import { SUB_MONO_CUTOFF_HZ } from './dsp.js';

export const AUTOMATION_STEPS = 16;
export const AUTOMATION_END_HZ = 1200;
export const AUTOMATION_MIN_HZ = 20;
export const AUTOMATION_BARS = 4;

export interface SidechainParams {
  /** Duck depth 0..1: the bus dips toward (1 - amount) on each kick. Default 0.5. */
  amount: number;
  /** Attack time constant in ms. Default 5. */
  attackMs: number;
  /** Release time constant in ms. Default 120. */
  releaseMs: number;
}

export interface EightOhEightParams {
  /** MIDI note 24–48 (default 36 = C1). */
  note: number;
  /** 60–180 (default 140). */
  bpm: number;
  /** Sweep start cutoff in Hz, 20–200 (default 40). */
  startCutoff: number;
  /** Resonance as raw 0–127 value; Q = value / 10 (default 64). */
  resonance: number;
  velocity?: number;
}

/** 16 cutoff values interpolating startHz -> endHz (linear in Hz). */
export function automationSteps(
  startHz: number,
  endHz: number = AUTOMATION_END_HZ,
  steps: number = AUTOMATION_STEPS,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < steps; i++) {
    out.push(startHz + ((endHz - startHz) * i) / (steps - 1));
  }
  return out;
}

/** Hz (20–1200) -> MIDI CC74 (0–127), clamped. Inverse of cc74ToHz. */
export function hzToCc74(hz: number): number {
  const c = Math.round((127 * (hz - AUTOMATION_MIN_HZ)) / (AUTOMATION_END_HZ - AUTOMATION_MIN_HZ));
  return Math.max(0, Math.min(127, c));
}

/** MIDI CC74 (0–127) -> Hz (20–1200). Inverse of hzToCc74. */
export function cc74ToHz(cc: number): number {
  const c = Math.max(0, Math.min(127, Math.round(cc)));
  return AUTOMATION_MIN_HZ + ((AUTOMATION_END_HZ - AUTOMATION_MIN_HZ) * c) / 127;
}

/** Seconds per automation step: 4 bars of 4/4 at `bpm`, divided into 16 steps. */
export function automationStepDur(bpm: number, bars = AUTOMATION_BARS, steps = AUTOMATION_STEPS): number {
  return ((60 / bpm) * 4 * bars) / steps;
}

/**
 * Logistic map x_{n+1} = r * x_n * (1 - x_n), the "chaotic LFO" source.
 * Honest name: it is deterministic chaos, not AI, not quantum anything.
 * Stays in [0, 1] for x in [0, 1] and r in [0, 4].
 */
export function logisticMap(x: number, r = 3.9): number {
  return r * x * (1 - x);
}

/**
 * Render the 16-step filter sweep as a real Type-0 MIDI file:
 * one sustained note plus CC74 automation events using the documented Hz<->CC map.
 */
export function automationToMidi(params: EightOhEightParams, ppq = 480): Uint8Array<ArrayBuffer> {
  const note = Math.max(24, Math.min(48, Math.round(params.note)));
  const events: MidiEvent[] = [];
  const totalTicks = ppq * 4 * AUTOMATION_BARS; // 4/4 bars
  const steps = automationSteps(params.startCutoff);
  events.push({ kind: 'noteOn', tick: 0, channel: 0, note, velocity: Math.round((params.velocity ?? 0.85) * 127) });
  for (let i = 0; i < steps.length; i++) {
    events.push({
      kind: 'cc',
      tick: Math.round((totalTicks * i) / steps.length),
      channel: 0,
      controller: 74,
      value: hzToCc74(steps[i]),
    });
  }
  events.push({ kind: 'noteOff', tick: totalTicks, channel: 0, note, velocity: 0 });
  const micros = Math.round(60_000_000 / params.bpm);
  return writeMidiFile(ppq, events, micros);
}

/* ------------------------------------------------------------------ */

export class EightOhEight {
  private host: AudioHost;
  private active: OscillatorNode[] = [];
  /**
   * Sub-bass chain: 808 voices connect to subInput, which splits through a
   * 24 dB/oct Linkwitz-Riley crossover at 90 Hz. The low band is summed to
   * true mono (dual-mono L/R); the high band stays stereo. Both bands rejoin
   * at bassBus, then pass through duckGain (kick-triggered sidechain) to the
   * host bus. Kick/snare/hat connect straight to the host bus: the kick is
   * the ducking trigger and stays dry.
   */
  private subInput: GainNode;
  private bassBus: GainNode;
  private duckGain: GainNode;
  private sidechain: SidechainParams = { amount: 0.5, attackMs: 5, releaseMs: 120 };

  constructor(host: AudioHost) {
    this.host = host;
    const ctx = host.ctx;
    this.subInput = ctx.createGain();
    this.bassBus = ctx.createGain();
    this.duckGain = ctx.createGain();

    // 24 dB/oct crossover = two cascaded biquads per band (matches the
    // pure designCrossoverLR4 spec in dsp.ts, evaluated there by tests).
    const q = Math.SQRT1_2;
    const mkLp = () => {
      const a = ctx.createBiquadFilter();
      a.type = 'lowpass';
      a.frequency.value = SUB_MONO_CUTOFF_HZ;
      a.Q.value = q;
      const b = ctx.createBiquadFilter();
      b.type = 'lowpass';
      b.frequency.value = SUB_MONO_CUTOFF_HZ;
      b.Q.value = q;
      a.connect(b);
      return { input: a, output: b };
    };
    const mkHp = () => {
      const a = ctx.createBiquadFilter();
      a.type = 'highpass';
      a.frequency.value = SUB_MONO_CUTOFF_HZ;
      a.Q.value = q;
      const b = ctx.createBiquadFilter();
      b.type = 'highpass';
      b.frequency.value = SUB_MONO_CUTOFF_HZ;
      b.Q.value = q;
      a.connect(b);
      return { input: a, output: b };
    };
    const low = mkLp();
    const high = mkHp();

    // True mono low band: split L/R, sum at half gain each (unity for
    // dual-mono content), force the sum node to 1 channel so downstream
    // up-mixes by duplication — the content is mono either way.
    const splitter = ctx.createChannelSplitter(2);
    const sumL = ctx.createGain();
    sumL.gain.value = 0.5;
    const sumR = ctx.createGain();
    sumR.gain.value = 0.5;
    const monoSum = ctx.createGain();
    monoSum.channelCount = 1;
    monoSum.channelCountMode = 'explicit';
    low.output.connect(splitter);
    splitter.connect(sumL, 0);
    splitter.connect(sumR, 1);
    sumL.connect(monoSum);
    sumR.connect(monoSum);
    monoSum.connect(this.bassBus);
    high.output.connect(this.bassBus);

    this.subInput.connect(low.input);
    this.subInput.connect(high.input);
    this.bassBus.connect(this.duckGain);
    this.duckGain.connect(host.bus);
  }

  /** Set kick-triggered sidechain ducking on the sub-bass bus. */
  setSidechain(params: Partial<SidechainParams>): void {
    this.sidechain = {
      amount: Math.max(0, Math.min(1, params.amount ?? this.sidechain.amount)),
      attackMs: Math.max(0.5, params.attackMs ?? this.sidechain.attackMs),
      releaseMs: Math.max(5, params.releaseMs ?? this.sidechain.releaseMs),
    };
  }

  /**
   * Dip the sub-bass bus for one kick hit: exponential approach toward
   * (1 - amount) with the attack time constant, then back to unity after
   * ~90 ms with the release constant. Same curve shape as duckStep in dsp.ts.
   */
  duckAt(when?: number): void {
    const amt = this.sidechain.amount;
    if (amt <= 0) return;
    const ctx = this.host.ctx;
    const t = when ?? ctx.currentTime;
    const attack = Math.max(0.002, this.sidechain.attackMs / 1000);
    const release = Math.max(0.01, this.sidechain.releaseMs / 1000);
    const g = this.duckGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(1 - amt, t, attack);
    g.setTargetAtTime(1, t + 0.09, release);
  }

  private track(node: OscillatorNode): OscillatorNode {
    this.active.push(node);
    node.onended = () => {
      const i = this.active.indexOf(node);
      if (i >= 0) this.active.splice(i, 1);
    };
    return node;
  }

  /** 24 dB/oct lowpass = two cascaded biquads. Returns [input, output]. */
  private lowpass24(cutoff: number, q: number): { input: BiquadFilterNode; output: BiquadFilterNode } {
    const ctx = this.host.ctx;
    const a = ctx.createBiquadFilter();
    a.type = 'lowpass';
    a.frequency.value = cutoff;
    a.Q.value = q;
    const b = ctx.createBiquadFilter();
    b.type = 'lowpass';
    b.frequency.value = cutoff;
    b.Q.value = 0.7;
    a.connect(b);
    return { input: a, output: b };
  }

  private saturationCurve(): Float32Array<ArrayBuffer> {
    const n = 256;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(1.6 * x);
    }
    return c;
  }

  /**
   * Trigger a single 808 hit. Options mirror the UI parameter model.
   * `when` schedules in the future (for the sequencer); default = now.
   */
  trigger(
    midi: number,
    opts: { velocity?: number; cutoff?: number; q?: number; when?: number; lengthBeats?: number } = {},
  ): void {
    const ctx = this.host.ctx;
    const t = opts.when ?? ctx.currentTime;
    const f0 = midiToFreq(midi);
    const vel = Math.max(0, Math.min(1.2, opts.velocity ?? 0.9));

    const osc = this.track(ctx.createOscillator());
    osc.type = 'sine';
    // Pitch envelope: start an octave up, settle to the target in ~80 ms.
    osc.frequency.setValueAtTime(Math.max(20, f0 * 2), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f0), t + 0.08);

    // Click transient: a 6 ms band-limited square blip built with PolyBLEP.
    const clickLen = Math.max(1, Math.floor(ctx.sampleRate * 0.006));
    const clickBuf = ctx.createBuffer(1, clickLen, ctx.sampleRate);
    const cd = clickBuf.getChannelData(0);
    const dt = f0 / ctx.sampleRate;
    let phase = 0;
    for (let i = 0; i < clickLen; i++) {
      const naive = phase < 0.5 ? 1 : -1;
      cd[i] = 0.35 * (naive + polyblep(phase, dt));
      phase = (phase + dt) % 1;
    }
    const click = ctx.createBufferSource();
    click.buffer = clickBuf;

    const { input: lpIn, output: lpOut } = this.lowpass24(opts.cutoff ?? 800, opts.q ?? 1);
    const sat = ctx.createWaveShaper();
    sat.curve = this.saturationCurve();

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(vel, t + 0.05); // attack
    amp.gain.linearRampToValueAtTime(vel * 0.9, t + 0.25); // decay -> sustain
    const holdEnd = t + Math.max(0.3, (opts.lengthBeats ?? 1) * 0.4);
    amp.gain.setValueAtTime(vel * 0.9, holdEnd);
    amp.gain.linearRampToValueAtTime(0, holdEnd + 0.5); // release

    osc.connect(lpIn);
    click.connect(lpIn);
    lpOut.connect(sat);
    sat.connect(amp);
    amp.connect(this.subInput); // sub-bass chain: mono crossover + sidechain
    osc.start(t);
    osc.stop(holdEnd + 0.6);
    click.start(t);
  }

  /**
   * The signature 16-step filter sweep: hold one sub-bass note for 4 bars
   * while the lowpass cutoff ramps startHz -> 1200 Hz in 16 steps.
   */
  sweep(params: EightOhEightParams): void {
    const ctx = this.host.ctx;
    const t0 = ctx.currentTime + 0.05;
    const stepDur = automationStepDur(params.bpm);
    const steps = automationSteps(params.startCutoff);
    const q = Math.max(0.5, Math.min(12.7, params.resonance / 10));
    const f0 = midiToFreq(Math.max(24, Math.min(48, Math.round(params.note))));
    const vel = Math.max(0, Math.min(1.2, params.velocity ?? 0.9));

    const osc = this.track(ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t0);

    const { input: lpIn, output: lpOut } = this.lowpass24(steps[0], q);
    for (let i = 0; i < steps.length; i++) {
      lpIn.frequency.setValueAtTime(steps[i], t0 + i * stepDur);
    }
    const sat = ctx.createWaveShaper();
    sat.curve = this.saturationCurve();
    const amp = ctx.createGain();
    const total = stepDur * steps.length;
    amp.gain.setValueAtTime(0, t0);
    amp.gain.linearRampToValueAtTime(vel, t0 + 0.05);
    amp.gain.setValueAtTime(vel * 0.9, t0 + total);
    amp.gain.linearRampToValueAtTime(0, t0 + total + 0.5);

    osc.connect(lpIn);
    lpOut.connect(sat);
    sat.connect(amp);
    amp.connect(this.subInput); // sub-bass chain: mono crossover + sidechain
    osc.start(t0);
    osc.stop(t0 + total + 0.6);
  }

  /** Procedural kick: sine pitch drop 150 -> 45 Hz with fast decay. */
  kick(when?: number, velocity = 1): void {
    const ctx = this.host.ctx;
    const t = when ?? ctx.currentTime;
    const osc = this.track(ctx.createOscillator());
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.11);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(velocity, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(amp);
    amp.connect(this.host.bus);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  /** Procedural snare: 190 Hz body + noise burst through a bandpass. */
  snare(when?: number, velocity = 0.8): void {
    const ctx = this.host.ctx;
    const t = when ?? ctx.currentTime;
    const osc = this.track(ctx.createOscillator());
    osc.type = 'triangle';
    osc.frequency.value = 190;
    const oamp = ctx.createGain();
    oamp.gain.setValueAtTime(0.5 * velocity, t);
    oamp.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    const nlen = Math.floor(ctx.sampleRate * 0.18);
    const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nbuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.9;
    const namp = ctx.createGain();
    namp.gain.setValueAtTime(0.6 * velocity, t);
    namp.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

    osc.connect(oamp);
    oamp.connect(this.host.bus);
    noise.connect(bp);
    bp.connect(namp);
    namp.connect(this.host.bus);
    osc.start(t);
    osc.stop(t + 0.15);
    noise.start(t);
  }

  /** Procedural hat: short highpassed noise burst. */
  hat(when?: number, velocity = 0.5, open = false): void {
    const ctx = this.host.ctx;
    const t = when ?? ctx.currentTime;
    const dur = open ? 0.3 : 0.05;
    const nlen = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const nbuf = ctx.createBuffer(1, nlen, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = nbuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.4 * velocity, t);
    amp.gain.exponentialRampToValueAtTime(0.001, t + dur);
    noise.connect(hp);
    hp.connect(amp);
    amp.connect(this.host.bus);
    noise.start(t);
  }

  stopAll(): void {
    const t = this.host.ctx.currentTime;
    for (const o of [...this.active]) {
      try {
        o.stop(t);
      } catch {
        /* already stopped */
      }
    }
    this.active = [];
  }
}
