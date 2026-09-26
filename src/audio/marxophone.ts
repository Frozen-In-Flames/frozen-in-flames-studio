/**
 * marxophone.ts — Hammer-strike additive voice engine.
 *
 * Voice architecture (from the instrument spec):
 *  - sawtooth at f + triangle at 2.001f (steel shimmer) + sine at 3.98f (chime)
 *  - 15 ms bandpass-filtered noise burst (3200 Hz, Q=3) as the hammer transient
 *  - body lowpass sweeping min(12000, 6f) -> 1.5f exponentially over the decay
 *  - exponential decay 0.2–2.0 s (default 0.7 s)
 *  - spring-hammer bounce mode: retrigger at 10–22 Hz while held,
 *    velocity V = 0.75 + 0.15 * sin(bounceCount * 0.8)
 *  - tube waveshaper (1024-point rational-function curve)
 *
 * Voice-management correctness (the two most audible bug classes are fixed here):
 *  1. A voice is NEVER returned to the pool on note-off. It stays allocated
 *     until its release envelope completes, then is freed.
 *  2. Release always starts from the CURRENT envelope level, never from
 *     sustain — releasing mid-attack/decay does not click.
 *  3. Stealing prefers voices already in release, then the quietest voice.
 */

import type { AudioHost } from './engine.js';
import { freqForNote, type TuningSystem } from './tuning.js';

/* ------------------------------------------------------------------ */
/* Pure helpers (testable)                                             */
/* ------------------------------------------------------------------ */

/**
 * Tube-style waveshaper curve: y = (1+k)*x / (1+k*|x|).
 * Odd, monotonically increasing, bounded in (-1, 1). 1024 points is plenty.
 */
export function makeTubeCurve(points = 1024, drive = 2.5): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    curve[i] = ((1 + drive) * x) / (1 + drive * Math.abs(x));
  }
  return curve;
}

/** Spring-hammer bounce velocity modulation. */
export function bounceVelocity(bounceCount: number): number {
  return 0.75 + 0.15 * Math.sin(bounceCount * 0.8);
}

/**
 * PolyBLEP correction for a naive saw/square oscillator.
 * phase in [0,1), dt = freq/sampleRate. Returns the correction to add.
 */
export function polyblep(phase: number, dt: number): number {
  if (phase < dt) {
    const t = phase / dt;
    return t + t - t * t - 1;
  }
  if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

/** Nonlinear velocity mapping: gentle expansion of the low end. */
export function velocityCurve(v: number): number {
  const c = Math.max(0, Math.min(1, v));
  return Math.pow(c, 1.4);
}

/**
 * Percussive hammer envelope with release-from-current-level.
 * All times in seconds; `level(at)` is pure math.
 */
export class HammerEnvelope {
  private onTime = 0;
  private offTime: number | null = null;
  private offLevel = 0;
  private sounded = false;

  constructor(
    private attackT = 0.004,
    private decayT = 0.7,
    private sustain = 0.0,
    private releaseT = 0.25,
  ) {}

  noteOn(at: number): void {
    this.onTime = at;
    this.offTime = null;
    this.sounded = true;
  }

  /** Capture the CURRENT level — release never restarts from sustain. */
  noteOff(at: number): void {
    if (!this.sounded) return;
    this.offLevel = this.level(at);
    this.offTime = at;
  }

  level(at: number): number {
    if (!this.sounded || at < this.onTime) return 0;
    if (this.offTime !== null && at >= this.offTime) {
      const tau = Math.max(1e-4, this.releaseT / 5);
      return this.offLevel * Math.exp(-(at - this.offTime) / tau);
    }
    const t = at - this.onTime;
    if (t < this.attackT) return t / this.attackT;
    const tau = Math.max(1e-4, this.decayT / 5);
    return this.sustain + (1 - this.sustain) * Math.exp(-(t - this.attackT) / tau);
  }

  get released(): boolean {
    return this.offTime !== null;
  }
}

export interface VoiceSlot {
  active: boolean;
  releasing: boolean;
  /** Current output level estimate (0..1), used for steal priority. */
  level: number;
  midi: number;
  startedAt: number;
}

/**
 * Choose which voice slot to steal. Priority:
 *  1. a voice already in release (its tail is nearly gone),
 *  2. otherwise the quietest active voice,
 *  3. ties broken by oldest start time.
 * Returns the slot index. Slots must be non-empty.
 */
export function chooseVoiceToSteal(slots: VoiceSlot[]): number {
  let best = 0;
  for (let i = 1; i < slots.length; i++) {
    const a = slots[i];
    const b = slots[best];
    if (a.releasing && !b.releasing) {
      best = i;
    } else if (a.releasing === b.releasing) {
      if (a.level < b.level - 1e-9 || (Math.abs(a.level - b.level) < 1e-9 && a.startedAt < b.startedAt)) {
        best = i;
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Live engine                                                         */
/* ------------------------------------------------------------------ */

export interface MarxophoneOptions {
  maxVoices?: number;
  decay?: number;
  tuning?: TuningSystem;
  cents?: number;
  bounce?: boolean;
  bounceRate?: number;
}

interface LiveVoice {
  slot: VoiceSlot;
  oscs: OscillatorNode[];
  noise: AudioBufferSourceNode | null;
  voiceGain: GainNode;
  shaper: WaveShaperNode;
  out: GainNode;
  envelope: HammerEnvelope;
  bounceTimer: ReturnType<typeof setInterval> | null;
  bounceCount: number;
  freeTimer: ReturnType<typeof setTimeout> | null;
}

const NOISE_BURST_SECONDS = 0.015;

export class MarxophoneEngine {
  private host: AudioHost;
  private voices: LiveVoice[] = [];
  private maxVoices: number;
  private decay: number;
  private tuning: TuningSystem;
  private cents: number;
  private bounce: boolean;
  private bounceRate: number;
  private tubeCurve: Float32Array<ArrayBuffer>;
  private noiseBuffer: AudioBuffer | null = null;
  /**
   * False when rendering offline: wall-clock timers (bounce intervals,
   * pool-free timeouts) are not armed, so faster-than-real-time renders
   * are not disturbed.
   */
  private realtime: boolean;

  constructor(host: AudioHost, opts: MarxophoneOptions = {}) {
    this.host = host;
    this.maxVoices = opts.maxVoices ?? 16;
    this.decay = opts.decay ?? 0.7;
    this.tuning = opts.tuning ?? 'edo12';
    this.cents = opts.cents ?? 0;
    this.bounce = opts.bounce ?? false;
    this.bounceRate = opts.bounceRate ?? 14;
    this.tubeCurve = makeTubeCurve(1024, 2.5);
    this.realtime =
      typeof OfflineAudioContext === 'undefined' || !(host.ctx instanceof OfflineAudioContext);
  }

  setDecay(seconds: number): void {
    this.decay = Math.max(0.2, Math.min(2.0, seconds));
  }

  setTuning(system: TuningSystem, cents = 0): void {
    this.tuning = system;
    this.cents = cents;
  }

  setBounce(on: boolean, rateHz = 14): void {
    this.bounce = on;
    this.bounceRate = Math.max(10, Math.min(22, rateHz));
  }

  private ensureNoise(ctx: BaseAudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const len = Math.max(1, Math.floor(ctx.sampleRate * NOISE_BURST_SECONDS));
      this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  private freeSlot(voice: LiveVoice): void {
    try {
      for (const o of voice.oscs) o.stop();
      voice.noise?.stop();
    } catch {
      /* already stopped */
    }
    voice.out.disconnect();
    voice.slot.active = false;
    voice.slot.releasing = false;
    voice.slot.level = 0;
  }

  private retireVoice(voice: LiveVoice, now: number): void {
    // Fast-fade the stolen voice so the steal itself doesn't click, then
    // release its nodes after the fade. The new voice gets a fresh shell —
    // the pool may briefly hold extra retiring voices, which is bounded and
    // honest (a steal is rare and short).
    if (voice.bounceTimer) {
      clearInterval(voice.bounceTimer);
      voice.bounceTimer = null;
    }
    if (voice.freeTimer) {
      clearTimeout(voice.freeTimer);
      voice.freeTimer = null;
    }
    voice.slot.active = false;
    voice.slot.releasing = false;
    voice.slot.level = 0;
    try {
      voice.voiceGain.gain.cancelScheduledValues(now);
      voice.voiceGain.gain.setTargetAtTime(0, now, 0.008);
      const stopAt = now + 0.08;
      for (const o of voice.oscs) {
        try {
          o.stop(stopAt);
        } catch {
          /* already stopped */
        }
      }
      try {
        voice.noise?.stop(stopAt);
      } catch {
        /* already stopped */
      }
    } catch {
      /* nodes already gone */
    }
    const { out } = voice;
    // In offline renders the nodes are simply garbage-collected after the
    // render — disconnecting now would cut scheduled audio, so don't.
    if (this.realtime) {
      setTimeout(() => {
        try {
          out.disconnect();
        } catch {
          /* already disconnected */
        }
      }, 200);
    }
  }

  private findSlotForSteal(): LiveVoice {
    const slots = this.voices.map((v) => v.slot);
    return this.voices[chooseVoiceToSteal(slots)];
  }

  /**
   * Strike a note. `when` schedules at an absolute audio-clock time
   * (for the sequencer / offline render); default is immediate.
   */
  noteOn(midi: number, velocity = 0.8, when?: number): void {
    const ctx = this.host.ctx;
    const now = when ?? ctx.currentTime;
    const vel = velocityCurve(velocity);
    const freq = freqForNote(midi, this.tuning, this.cents);

    let voice: LiveVoice;
    const free = this.voices.find((v) => !v.slot.active);
    if (free) {
      voice = free;
    } else if (this.voices.length < this.maxVoices) {
      voice = this.createVoiceShell();
      this.voices.push(voice);
    } else {
      this.retireVoice(this.findSlotForSteal(), now);
      voice = this.createVoiceShell();
      this.voices.push(voice);
    }

    // --- build the graph ---
    const out = ctx.createGain();
    out.gain.value = 0.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.tubeCurve;
    shaper.oversample = '2x';
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = 'lowpass';
    bodyFilter.Q.value = 0.8;
    const startCutoff = Math.min(12000, 6 * freq);
    const endCutoff = Math.max(40, 1.5 * freq);
    bodyFilter.frequency.setValueAtTime(startCutoff, now);
    bodyFilter.frequency.exponentialRampToValueAtTime(endCutoff, now + this.decay);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0, now);
    voiceGain.gain.linearRampToValueAtTime(vel, now + 0.004);
    voiceGain.gain.setTargetAtTime(0, now + 0.004, Math.max(1e-3, this.decay / 5));

    const mk = (type: OscillatorType, mult: number, g: number): OscillatorNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(bodyFilter);
      o.start(now);
      return o;
    };
    const oscs = [mk('sawtooth', 1, 0.5), mk('triangle', 2.001, 0.28), mk('sine', 3.98, 0.22)];

    // Hammer transient: 15 ms noise burst, bandpass 3200 Hz Q=3.
    const noise = ctx.createBufferSource();
    noise.buffer = this.ensureNoise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    bp.Q.value = 3;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.6 * vel, now);
    ng.gain.setTargetAtTime(0, now, 0.004);
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(bodyFilter);
    noise.start(now);

    bodyFilter.connect(voiceGain);
    voiceGain.connect(shaper);
    shaper.connect(out);
    out.connect(this.host.bus);

    const envelope = new HammerEnvelope(0.004, this.decay, 0, 0.25);
    envelope.noteOn(now);

    voice.oscs = oscs;
    voice.noise = noise;
    voice.voiceGain = voiceGain;
    voice.shaper = shaper;
    voice.out = out;
    voice.envelope = envelope;
    voice.bounceCount = 0;
    voice.slot.active = true;
    voice.slot.releasing = false;
    voice.slot.midi = midi;
    voice.slot.level = vel;
    voice.slot.startedAt = now;

    // Spring-hammer bounce: periodic retrigger bumps while the key is held.
    // Wall-clock intervals are only meaningful in real time.
    if (this.bounce && this.realtime) {
      voice.bounceTimer = setInterval(() => {
        if (!voice.slot.active || voice.slot.releasing) return;
        voice.bounceCount++;
        const bump = bounceVelocity(voice.bounceCount) * vel * 0.5;
        const t = ctx.currentTime;
        voice.voiceGain.gain.cancelScheduledValues(t);
        voice.voiceGain.gain.setTargetAtTime(bump, t, 0.01);
        voice.voiceGain.gain.setTargetAtTime(0, t + 0.01, Math.max(1e-3, this.decay / 5));
      }, 1000 / this.bounceRate);
    } else {
      voice.bounceTimer = null;
    }
    voice.freeTimer = null;
  }

  noteOff(midi: number, when?: number): void {
    const ctx = this.host.ctx;
    const now = when ?? ctx.currentTime;
    for (const voice of this.voices) {
      if (!voice.slot.active || voice.slot.releasing || voice.slot.midi !== midi) continue;
      // Capture current level BEFORE scheduling release — no restart from sustain.
      voice.envelope.noteOff(now);
      voice.slot.releasing = true;
      voice.slot.level = 0.05;
      if (voice.bounceTimer) {
        clearInterval(voice.bounceTimer);
        voice.bounceTimer = null;
      }
      const releaseT = 0.25;
      voice.voiceGain.gain.cancelScheduledValues(now);
      voice.voiceGain.gain.setTargetAtTime(0, now, Math.max(1e-3, releaseT / 5));
      // Return to the pool ONLY after the release tail has completed.
      // Offline: skip the wall-clock timer; nodes are collected after render.
      if (this.realtime) {
        voice.freeTimer = setTimeout(() => this.freeSlot(voice), releaseT * 5 * 1000 + 120);
      }
    }
  }

  /** Silence everything immediately. */
  panic(): void {
    for (const voice of this.voices) {
      if (voice.bounceTimer) clearInterval(voice.bounceTimer);
      if (voice.freeTimer) clearTimeout(voice.freeTimer);
      if (voice.slot.active) this.freeSlot(voice);
    }
  }

  private createVoiceShell(): LiveVoice {
    return {
      slot: { active: false, releasing: false, level: 0, midi: -1, startedAt: 0 },
      oscs: [],
      noise: null,
      voiceGain: null as unknown as GainNode,
      shaper: null as unknown as WaveShaperNode,
      out: null as unknown as GainNode,
      envelope: new HammerEnvelope(),
      bounceTimer: null,
      bounceCount: 0,
      freeTimer: null,
    };
  }
}
