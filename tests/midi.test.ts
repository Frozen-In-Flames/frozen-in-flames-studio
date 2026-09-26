import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MICROS_PER_QUARTER,
  parseMidiFile,
  readVLQ,
  ticksToSeconds,
  writeMidiFile,
  writeVLQ,
  type MidiEvent,
  type TempoChange,
} from '../src/audio/midi.js';

describe('VLQ', () => {
  it.each([
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x81, 0x00]],
    [255, [0x81, 0x7f]],
    [0x1fffff, [0xff, 0xff, 0x7f]],
    [0x0fffffff, [0xff, 0xff, 0xff, 0x7f]],
  ])('encodes %i', (value, bytes) => {
    expect(writeVLQ(value)).toEqual(bytes);
  });
  it('round-trips through readVLQ', () => {
    for (const v of [0, 1, 127, 128, 480, 8192, 0xffffff]) {
      const bytes = new Uint8Array(writeVLQ(v));
      const { value, length } = readVLQ(bytes, 0);
      expect(value).toBe(v);
      expect(length).toBe(bytes.length);
    }
  });
  it('rejects negative values', () => {
    expect(() => writeVLQ(-1)).toThrow();
  });
});

/** Build a minimal MIDI file by hand: tempo + note on + running-status note off + CC. */
function handBuiltMidi(): Uint8Array {
  const bytes: number[] = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, // MThd, len 6
    0x00, 0x00, // format 0
    0x00, 0x01, // 1 track
    0x01, 0xe0, // ppq 480
    0x4d, 0x54, 0x72, 0x6b, // MTrk
  ];
  const track: number[] = [
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // tempo 500000
    0x00, 0x90, 0x3c, 0x64, // note on ch0 60 vel 100
    0x83, 0x60, 0x3c, 0x00, // delta 480, running status: note on vel 0 -> note off
    0x00, 0xb0, 0x4a, 0x40, // cc74 = 64
    0x00, 0xff, 0x2f, 0x00, // end of track
  ];
  const len = track.length;
  bytes.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  return new Uint8Array([...bytes, ...track]);
}

describe('parseMidiFile', () => {
  it('parses a hand-built file with running status', () => {
    const parsed = parseMidiFile(handBuiltMidi());
    expect(parsed.ppq).toBe(480);
    expect(parsed.events).toHaveLength(3);
    const [on, off, cc] = parsed.events;
    expect(on).toMatchObject({ kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 });
    // velocity-0 note-on under running status becomes note-off
    expect(off).toMatchObject({ kind: 'noteOff', tick: 480, channel: 0, note: 60 });
    expect(cc).toMatchObject({ kind: 'cc', tick: 480, controller: 74, value: 64 });
    // tick -> seconds at 120 BPM: 480 ticks = 0.5 s
    expect(on.seconds).toBeCloseTo(0, 9);
    expect(off.seconds).toBeCloseTo(0.5, 9);
  });

  it('handles multi-track format 1 and merges in tick order', () => {
    const trackA = [0x00, 0x90, 0x3c, 0x64, 0x83, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00];
    const trackB = [0x81, 0x70, 0x90, 0x40, 0x50, 0x00, 0xff, 0x2f, 0x00]; // note on at tick 240
    const parts: number[] = [
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x01, 0x00, 0x02, 0x01, 0xe0,
    ];
    for (const t of [trackA, trackB]) {
      parts.push(0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, t.length, ...t);
    }
    const parsed = parseMidiFile(new Uint8Array(parts));
    expect(parsed.events.map((e) => e.tick)).toEqual([0, 240, 480]);
  });

  it('parses an empty track without events', () => {
    const bytes = new Uint8Array([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0,
      0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x04, 0x00, 0xff, 0x2f, 0x00,
    ]);
    const parsed = parseMidiFile(bytes);
    expect(parsed.events).toHaveLength(0);
    expect(parsed.tempoMap).toEqual([{ tick: 0, microsPerQuarter: DEFAULT_MICROS_PER_QUARTER }]);
  });

  it('rejects a bad header', () => {
    expect(() => parseMidiFile(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('ticksToSeconds', () => {
  const map: TempoChange[] = [
    { tick: 0, microsPerQuarter: 500000 },
    { tick: 480, microsPerQuarter: 250000 },
  ];
  it('converts with tempo changes', () => {
    expect(ticksToSeconds(0, 480, map)).toBeCloseTo(0, 9);
    expect(ticksToSeconds(480, 480, map)).toBeCloseTo(0.5, 9);
    expect(ticksToSeconds(960, 480, map)).toBeCloseTo(0.75, 9); // 0.5 + 480 ticks @ 250000
  });
});

describe('writeMidiFile round-trip', () => {
  it('parse(write(events)) deep-equals the original events', () => {
    const events: MidiEvent[] = [
      { kind: 'noteOn', tick: 0, channel: 0, note: 36, velocity: 110 },
      { kind: 'cc', tick: 120, channel: 0, controller: 74, value: 40 },
      { kind: 'cc', tick: 240, channel: 0, controller: 74, value: 90 },
      { kind: 'noteOff', tick: 480, channel: 0, note: 36, velocity: 0 },
      { kind: 'program', tick: 0, channel: 1, program: 5 },
      { kind: 'pitchBend', tick: 60, channel: 0, value: 8192 },
    ];
    const bytes = writeMidiFile(480, events, 500000);
    const parsed = parseMidiFile(bytes);
    expect(parsed.ppq).toBe(480);
    const strip = (evs: MidiEvent[]) => evs.map(({ seconds: _s, ...rest }) => rest);
    expect(strip(parsed.events)).toEqual(
      strip([...events].sort((a, b) => a.tick - b.tick)),
    );
    // spot-check the file header
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('MThd');
    expect(String.fromCharCode(bytes[14], bytes[15], bytes[16], bytes[17])).toBe('MTrk');
  });
});
