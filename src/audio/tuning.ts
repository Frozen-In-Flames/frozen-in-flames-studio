/**
 * tuning.ts — Microtonal tuning systems and MIDI-note to frequency conversion.
 *
 * Pure functions only (no Web Audio). All formulas are standard and testable:
 *  - 12/19/24/31 equal divisions of the octave (EDO)
 *  - 5-limit just intonation (12 ratios)
 *  - Pythagorean tuning (12 ratios)
 *  - Cents offset
 *  - Standard MIDI note -> frequency (A4 = 440 Hz)
 *
 * Reference pitch: A4 = 440 Hz. C4 (MIDI 60) is derived from A4.
 */

export type TuningSystem =
  | 'edo12'
  | 'edo19'
  | 'edo24'
  | 'edo31'
  | 'just'
  | 'pythagorean';

export const TUNING_LABELS: Record<TuningSystem, string> = {
  edo12: '12-EDO (standard)',
  edo19: '19-EDO',
  edo24: '24-EDO (quarter-tone)',
  edo31: '31-EDO',
  just: 'Just intonation (5-limit)',
  pythagorean: 'Pythagorean',
};

/** 5-limit just intonation ratios for the 12 chromatic steps (C..B). */
export const JUST_RATIOS: readonly number[] = [
  1 / 1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5,
  15 / 8,
];

/** Pythagorean tuning ratios for the 12 chromatic steps (C..B). */
export const PYTHAGOREAN_RATIOS: readonly number[] = [
  1, 256 / 243, 9 / 8, 32 / 27, 81 / 64, 4 / 3, 729 / 512, 3 / 2, 128 / 81,
  27 / 16, 16 / 9, 243 / 128,
];

/** A4 reference in Hz. */
export const A4_HZ = 440;

/** C4 derived from A4: 440 * 2^(-9/12). */
export const C4_HZ: number = A4_HZ * Math.pow(2, -9 / 12);

/**
 * Standard MIDI note number -> frequency in Hz. MIDI 69 = A4 = 440 Hz.
 */
export function midiToFreq(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

/**
 * Frequency of `stepsFromC` equal-tempered steps above C4 in an `edo`-division octave.
 * `stepsFromC` may be fractional.
 */
export function edoFreq(edo: number, stepsFromC: number, refHz: number = C4_HZ): number {
  return refHz * Math.pow(2, stepsFromC / edo);
}

/**
 * Map a MIDI note number to a 0-11 chromatic key index with octave wrap,
 * such that MIDI 60 (C4) -> 0.
 */
export function noteToKeyIndex(midi: number): number {
  return ((Math.round(midi) - 60) % 12 + 12) % 12;
}

/**
 * Apply a cents offset to a frequency: f * 2^(cents/1200).
 */
export function centsOffset(freqHz: number, cents: number): number {
  return freqHz * Math.pow(2, cents / 1200);
}

/**
 * Frequency of a MIDI note under a given tuning system, with an optional
 * cents offset applied afterwards.
 *
 * For EDO systems the MIDI note number is interpreted directly as a step
 * count (12-EDO matches midiToFreq exactly). For just/Pythagorean, the
 * note's chromatic index selects the ratio and the octave is applied
 * relative to C4.
 */
export function freqForNote(
  midi: number,
  system: TuningSystem,
  cents = 0,
): number {
  const m = Math.round(midi);
  let f: number;
  switch (system) {
    case 'edo12':
      f = edoFreq(12, m - 60);
      break;
    case 'edo19':
      // Map the 12 chromatic steps onto 19-EDO by nearest 19-EDO degree.
      f = edoFreq(19, Math.round(((m - 60) * 19) / 12));
      break;
    case 'edo24':
      f = edoFreq(24, (m - 60) * 2);
      break;
    case 'edo31':
      f = edoFreq(31, Math.round(((m - 60) * 31) / 12));
      break;
    case 'just': {
      const idx = noteToKeyIndex(m);
      const octave = Math.floor((m - 60) / 12);
      f = C4_HZ * JUST_RATIOS[idx] * Math.pow(2, octave);
      break;
    }
    case 'pythagorean': {
      const idx = noteToKeyIndex(m);
      const octave = Math.floor((m - 60) / 12);
      f = C4_HZ * PYTHAGOREAN_RATIOS[idx] * Math.pow(2, octave);
      break;
    }
  }
  return cents === 0 ? f : centsOffset(f, cents);
}
