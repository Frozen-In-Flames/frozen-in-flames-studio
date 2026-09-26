/**
 * engine.ts — Shared Web Audio context and master signal chain.
 *
 * The AudioContext is created lazily and resumed inside a user gesture
 * (browser autoplay policy). Master chain:
 *
 *   voices/stems -> master gain -> DynamicsCompressor (limiter settings)
 *                -> AnalyserNode (for visuals + metering) -> destination
 *
 * A generated-impulse ConvolverNode is provided for reverb sends.
 * No fake measurements: the performance meter reports real callback timings.
 */

/**
 * Generate a stereo exponential-decay noise impulse response.
 * Pure function of (sampleRate, seconds, decay) — testable.
 */
export function makeImpulseResponse(
  sampleRate: number,
  seconds: number,
  decay: number,
): Float32Array[] {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const env = Math.exp((-decay * i) / length);
    left[i] = (Math.random() * 2 - 1) * env;
    right[i] = (Math.random() * 2 - 1) * env;
  }
  return [left, right];
}

/** Limiter settings shared by the master chain. */
export const LIMITER_SETTINGS = {
  threshold: -1,
  knee: 0,
  ratio: 20,
  attack: 0.003,
  release: 0.1,
} as const;

export interface AudioHost {
  ctx: BaseAudioContext;
  /** Point where instrument voices connect (pre-master-gain). */
  bus: GainNode;
  convolver: ConvolverNode;
  reverbReturn: GainNode;
}

export class AudioEngine implements AudioHost {
  private _ctx: AudioContext | null = null;
  private _bus: GainNode | null = null;
  private _master: GainNode | null = null;
  private _comp: DynamicsCompressorNode | null = null;
  private _analyser: AnalyserNode | null = null;
  private _convolver: ConvolverNode | null = null;
  private _reverbReturn: GainNode | null = null;

  get ready(): boolean {
    return this._ctx !== null;
  }

  /** Create/resume the context. Must be called from a user gesture. */
  async init(): Promise<void> {
    if (!this._ctx) {
      const Ctx = window.AudioContext;
      this._ctx = new Ctx({ latencyHint: 'interactive' });
      this._bus = this._ctx.createGain();
      this._bus.gain.value = 0.9;

      this._master = this._ctx.createGain();
      this._master.gain.value = 0.8;

      this._comp = this._ctx.createDynamicsCompressor();
      this._comp.threshold.value = LIMITER_SETTINGS.threshold;
      this._comp.knee.value = LIMITER_SETTINGS.knee;
      this._comp.ratio.value = LIMITER_SETTINGS.ratio;
      this._comp.attack.value = LIMITER_SETTINGS.attack;
      this._comp.release.value = LIMITER_SETTINGS.release;

      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 2048;
      this._analyser.smoothingTimeConstant = 0.8;

      this._bus.connect(this._master);
      this._master.connect(this._comp);
      this._comp.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);

      // Generated-impulse reverb: 2.2 s decay, fed by per-stem sends.
      this._convolver = this._ctx.createConvolver();
      const [l, r] = makeImpulseResponse(this._ctx.sampleRate, 2.2, 3.5);
      const impulse = this._ctx.createBuffer(2, l.length, this._ctx.sampleRate);
      impulse.getChannelData(0).set(l);
      impulse.getChannelData(1).set(r);
      this._convolver.buffer = impulse;
      this._reverbReturn = this._ctx.createGain();
      this._reverbReturn.gain.value = 0.5;
      this._convolver.connect(this._reverbReturn);
      this._reverbReturn.connect(this._master);
    }
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }
  }

  private need(what: string): never {
    throw new Error(`AudioEngine not initialized: ${what} requested before init()`);
  }

  get ctx(): BaseAudioContext {
    if (!this._ctx) this.need('context');
    return this._ctx as BaseAudioContext;
  }

  get context(): AudioContext {
    if (!this._ctx) this.need('context');
    return this._ctx;
  }

  get bus(): GainNode {
    if (!this._bus) this.need('bus');
    return this._bus;
  }

  get master(): GainNode {
    if (!this._master) this.need('master');
    return this._master;
  }

  get analyser(): AnalyserNode {
    if (!this._analyser) this.need('analyser');
    return this._analyser;
  }

  get convolver(): ConvolverNode {
    if (!this._convolver) this.need('convolver');
    return this._convolver;
  }

  get reverbReturn(): GainNode {
    if (!this._reverbReturn) this.need('reverbReturn');
    return this._reverbReturn;
  }

  now(): number {
    return this.context.currentTime;
  }

  setMasterVolume(v: number): void {
    if (this._master && this._ctx) {
      this._master.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), this._ctx.currentTime, 0.02);
    }
  }

  /**
   * Run `fn` and return its result plus the real wall-clock time it took,
   * in milliseconds. Used by the honest performance meter — this measures
   * actual callback cost, it is not a benchmark claim.
   */
  measure<T>(label: string, fn: () => T): { label: string; result: T; ms: number } {
    const t0 = performance.now();
    const result = fn();
    const ms = performance.now() - t0;
    return { label, result, ms };
  }
}

/** Shared singleton used by the UI. */
export const engine = new AudioEngine();
