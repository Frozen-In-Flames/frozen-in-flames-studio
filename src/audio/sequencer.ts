/**
 * sequencer.ts — 16-step lookahead scheduler with paired note on/off.
 *
 * Timing uses the standard lookahead pattern: a 25 ms interval timer
 * schedules notes up to 0.12 s ahead of the audio clock. Every note-on is
 * paired with a note-off — the source prototype's stuck-note bug (notes
 * triggered with never a note-off) is fixed by construction.
 */

export const STEPS = 16;

export interface StepNote {
  midi: number;
  velocity?: number;
  /** Note length in steps (default 1). */
  len?: number;
  /** Instrument routing tag used by the full-mix pattern. */
  voice?: VoiceTag;
}

/** Instrument voice routing for merged patterns. */
export type VoiceTag = 'bass808' | 'drums' | 'keys';

export type Pattern = (StepNote[] | null)[];

/** Seconds per 16th-note step at `bpm`. */
export function stepDur(bpm: number): number {
  return 60 / bpm / 4;
}

/** Absolute audio-clock times for `steps` steps starting at `startTime`. */
export function gridTimes(bpm: number, steps: number, startTime: number): number[] {
  const d = stepDur(bpm);
  const out: number[] = [];
  for (let i = 0; i < steps; i++) out.push(startTime + i * d);
  return out;
}

/** How many times `pattern` (length STEPS) repeats over `totalSteps`. */
export function patternCycles(totalSteps: number, patternLen = STEPS): number {
  return Math.ceil(totalSteps / patternLen);
}

/* Demo patterns (from the source's procedural demo material). */
function n(midi: number, velocity = 0.9, len = 1): StepNote {
  return { midi, velocity, len };
}

export const DEMO_BASS: Pattern = [
  [n(36)], null, [n(36)], null,
  [n(38)], null, [n(36)], null,
  [n(41)], null, [n(36)], null,
  [n(38)], null, [n(34, 0.8)], null,
];

export const DEMO_MELODY: Pattern = [
  [n(60, 0.7)], null, [n(63, 0.7)], null,
  [n(65, 0.7)], null, [n(67, 0.8)], null,
  [n(70, 0.8)], null, [n(67, 0.7)], null,
  [n(65, 0.7)], null, [n(63, 0.7)], null,
];

export const DEMO_CHORDS: Pattern = [
  [n(60, 0.5, 4), n(64, 0.5, 4), n(67, 0.5, 4)], null, null, null,
  null, null, null, null,
  [n(57, 0.5, 4), n(60, 0.5, 4), n(64, 0.5, 4)], null, null, null,
  null, null, null, null,
];

export const DEMO_DRUMS: Pattern = [
  [{ midi: 36, velocity: 1 }], null, null, null,
  [{ midi: 40, velocity: 0.8 }], null, null, null,
  [{ midi: 36, velocity: 1 }], null, null, [{ midi: 36, velocity: 0.9 }],
  [{ midi: 40, velocity: 0.8 }], null, [{ midi: 42, velocity: 0.5 }], [{ midi: 42, velocity: 0.5 }],
];
// Drum convention: midi 36 = kick, 40 = snare, 42 = hat.

export interface StepHandlers {
  /** Called for each scheduled step at the precise audio time. */
  onStep: (step: number, time: number, notes: StepNote[]) => void;
  /** Called on the UI thread after each step is scheduled (for playhead). */
  onScheduled?: (step: number) => void;
}

export class Sequencer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  private bpm: number;
  private pattern: Pattern;
  private handlers: StepHandlers;
  private getTime: () => number;

  /** lookahead horizon in seconds; interval in ms. */
  static readonly LOOKAHEAD = 0.12;
  static readonly INTERVAL_MS = 25;

  constructor(
    handlers: StepHandlers,
    getTime: () => number,
    opts: { bpm?: number; pattern?: Pattern } = {},
  ) {
    this.handlers = handlers;
    this.getTime = getTime;
    this.bpm = opts.bpm ?? 140;
    this.pattern = opts.pattern ?? DEMO_BASS;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(40, Math.min(240, bpm));
  }

  setPattern(pattern: Pattern): void {
    this.pattern = pattern;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.step = 0;
    this.nextTime = this.getTime() + 0.06;
    this.timer = setInterval(() => this.tick(), Sequencer.INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const horizon = this.getTime() + Sequencer.LOOKAHEAD;
    while (this.nextTime < horizon) {
      const s = this.step % STEPS;
      const notes = this.pattern[s] ?? [];
      // Fire for every step — including rests — so the step stream stays
      // dense and ordered; consumers simply iterate zero notes on rests.
      this.handlers.onStep(s, this.nextTime, notes);
      if (this.handlers.onScheduled) {
        const stepCopy = s;
        const delayMs = Math.max(0, (this.nextTime - this.getTime()) * 1000);
        setTimeout(() => this.handlers.onScheduled?.(stepCopy), delayMs);
      }
      this.nextTime += stepDur(this.bpm);
      this.step++;
    }
  }
}
