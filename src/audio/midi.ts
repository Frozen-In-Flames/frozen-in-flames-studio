/**
 * midi.ts — MIDI file parsing, writing, and tick<->time conversion.
 *
 * Pure TypeScript (no Web Audio, no Web MIDI dependency for the core).
 * Supports Standard MIDI Files:
 *  - MThd header, format 0 and 1, MTrk track chunks
 *  - Variable-length quantity (VLQ) delta times
 *  - Running status
 *  - Note on (0x90; velocity 0 is treated as note-off), note off (0x80)
 *  - Control change (0xB0), program change (0xC0), pitch bend (0xE0)
 *  - Meta events: tempo (0x51), time signature (0x58), end of track (0x2F);
 *    other meta events and SysEx are skipped safely.
 *
 * Tick -> seconds uses the tempo map: seconds = sum over tempo segments of
 *   ticks * microsPerQuarter / (ppq * 1e6).
 */

export interface MidiNoteEvent {
  kind: 'noteOn' | 'noteOff';
  tick: number;
  channel: number;
  note: number;
  velocity: number;
  seconds?: number;
}

export interface MidiCcEvent {
  kind: 'cc';
  tick: number;
  channel: number;
  controller: number;
  value: number;
  seconds?: number;
}

export interface MidiProgramEvent {
  kind: 'program';
  tick: number;
  channel: number;
  program: number;
  seconds?: number;
}

export interface MidiPitchBendEvent {
  kind: 'pitchBend';
  tick: number;
  channel: number;
  value: number; // 14-bit, centered at 8192
  seconds?: number;
}

export type MidiEvent =
  | MidiNoteEvent
  | MidiCcEvent
  | MidiProgramEvent
  | MidiPitchBendEvent;

export interface TempoChange {
  tick: number;
  microsPerQuarter: number;
}

export interface ParsedMidi {
  /** Pulses (ticks) per quarter note. */
  ppq: number;
  /** All musical events from all tracks, merged and sorted by tick. */
  events: MidiEvent[];
  /** Tempo map in tick order; always starts at tick 0. */
  tempoMap: TempoChange[];
}

export const DEFAULT_MICROS_PER_QUARTER = 500000; // 120 BPM

/**
 * Read a variable-length quantity at `offset`.
 * Returns the value and the number of bytes consumed.
 */
export function readVLQ(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let i = offset;
  for (;;) {
    if (i >= data.length) throw new Error('VLQ overruns buffer');
    const b = data[i];
    value = (value << 7) | (b & 0x7f);
    i++;
    if ((b & 0x80) === 0) break;
    if (i - offset > 4) throw new Error('VLQ longer than 4 bytes');
  }
  return { value, length: i - offset };
}

/** Encode a non-negative integer as a VLQ. */
export function writeVLQ(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('VLQ value must be a non-negative integer');
  }
  const bytes: number[] = [value & 0x7f];
  let v = value >>> 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  // Set continuation bits on all but the last byte.
  for (let i = 0; i < bytes.length - 1; i++) bytes[i] |= 0x80;
  return bytes;
}

function readU16BE(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readU32BE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] * 0x1000000 +
      (data[offset + 1] << 16) +
      (data[offset + 2] << 8) +
      data[offset + 3]) >>>
    0
  );
}

function chunkTag(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

interface TrackParse {
  events: MidiEvent[];
  tempos: TempoChange[];
}

function parseTrack(data: Uint8Array, start: number, length: number): TrackParse {
  const events: MidiEvent[] = [];
  const tempos: TempoChange[] = [];
  const end = start + length;
  let offset = start;
  let tick = 0;
  let runningStatus = 0;

  while (offset < end) {
    const delta = readVLQ(data, offset);
    offset += delta.length;
    tick += delta.value;

    let status = data[offset];
    if (status < 0x80) {
      // Running status: reuse the previous status byte.
      if (runningStatus === 0) throw new Error('Running status with no prior status byte');
      status = runningStatus;
    } else {
      offset++;
      runningStatus = status;
    }

    if (status === 0xff) {
      // Meta event.
      const metaType = data[offset];
      offset++;
      const lenInfo = readVLQ(data, offset);
      offset += lenInfo.length;
      if (metaType === 0x51 && lenInfo.value === 3) {
        const micros = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
        tempos.push({ tick, microsPerQuarter: micros });
      }
      // Other meta events (track name, time signature, end of track, ...) are skipped.
      offset += lenInfo.value;
    } else if (status === 0xf0 || status === 0xf7) {
      // SysEx: length-delimited, skipped.
      const lenInfo = readVLQ(data, offset);
      offset += lenInfo.length + lenInfo.value;
      runningStatus = 0; // SysEx cancels running status.
    } else {
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (kind === 0x90 || kind === 0x80) {
        const note = data[offset];
        const velocity = data[offset + 1];
        offset += 2;
        if (kind === 0x90 && velocity > 0) {
          events.push({ kind: 'noteOn', tick, channel, note, velocity });
        } else {
          events.push({ kind: 'noteOff', tick, channel, note, velocity });
        }
      } else if (kind === 0xb0) {
        const controller = data[offset];
        const value = data[offset + 1];
        offset += 2;
        events.push({ kind: 'cc', tick, channel, controller, value });
      } else if (kind === 0xc0) {
        const program = data[offset];
        offset += 1;
        events.push({ kind: 'program', tick, channel, program });
      } else if (kind === 0xe0) {
        const lsb = data[offset];
        const msb = data[offset + 1];
        offset += 2;
        events.push({ kind: 'pitchBend', tick, channel, value: (msb << 7) | lsb });
      } else if (kind === 0xd0 || kind === 0xa0) {
        offset += kind === 0xd0 ? 1 : 2; // channel pressure / poly aftertouch: not modeled
      } else {
        throw new Error(`Unsupported MIDI status 0x${status.toString(16)}`);
      }
    }
  }

  return { events, tempos };
}

/**
 * Parse a Standard MIDI File from bytes.
 * Merged events carry `seconds` computed from the tempo map.
 */
export function parseMidiFile(bytes: Uint8Array): ParsedMidi {
  if (bytes.length < 14) throw new Error('Buffer too short for MThd');
  if (chunkTag(bytes, 0) !== 'MThd') throw new Error('Missing MThd header');
  const headerLen = readU32BE(bytes, 4);
  if (headerLen < 6) throw new Error('Bad MThd length');
  const format = readU16BE(bytes, 8);
  if (format !== 0 && format !== 1) throw new Error(`Unsupported SMF format ${format}`);
  const trackCount = readU16BE(bytes, 10);
  const division = readU16BE(bytes, 12);
  if (division & 0x8000) throw new Error('SMPTE time division not supported');
  const ppq = division;

  let offset = 8 + headerLen;
  const allEvents: MidiEvent[] = [];
  const allTempos: TempoChange[] = [];
  for (let t = 0; t < trackCount; t++) {
    if (offset + 8 > bytes.length) throw new Error('Truncated MTrk header');
    if (chunkTag(bytes, offset) !== 'MTrk') throw new Error('Missing MTrk header');
    const trackLen = readU32BE(bytes, offset + 4);
    const parsed = parseTrack(bytes, offset + 8, trackLen);
    allEvents.push(...parsed.events);
    allTempos.push(...parsed.tempos);
    offset += 8 + trackLen;
  }

  const tempoMap = buildTempoMap(allTempos);
  allEvents.sort((a, b) => a.tick - b.tick);
  for (const ev of allEvents) {
    ev.seconds = ticksToSeconds(ev.tick, ppq, tempoMap);
  }
  return { ppq, events: allEvents, tempoMap };
}

function buildTempoMap(tempos: TempoChange[]): TempoChange[] {
  const sorted = [...tempos].sort((a, b) => a.tick - b.tick);
  const map: TempoChange[] = [{ tick: 0, microsPerQuarter: DEFAULT_MICROS_PER_QUARTER }];
  for (const t of sorted) {
    if (t.tick === 0) {
      map[0] = t; // a tempo at tick 0 replaces the default
    } else if (t.tick > map[map.length - 1].tick) {
      map.push(t);
    }
  }
  return map;
}

/**
 * Convert an absolute tick to seconds using the tempo map.
 * tempoMap must be sorted by tick and start at tick 0.
 */
export function ticksToSeconds(tick: number, ppq: number, tempoMap: TempoChange[]): number {
  let seconds = 0;
  let lastTick = 0;
  let micros = tempoMap.length > 0 ? tempoMap[0].microsPerQuarter : DEFAULT_MICROS_PER_QUARTER;
  for (let i = 1; i < tempoMap.length && tempoMap[i].tick <= tick; i++) {
    seconds += ((tempoMap[i].tick - lastTick) * micros) / (ppq * 1e6);
    lastTick = tempoMap[i].tick;
    micros = tempoMap[i].microsPerQuarter;
  }
  seconds += ((tick - lastTick) * micros) / (ppq * 1e6);
  return seconds;
}

/**
 * Write a Standard MIDI File (format 0, single track) from events.
 * Events are sorted by tick; delta times are encoded as VLQs.
 * Returns the complete file bytes, ready to download as `.mid`.
 */
export function writeMidiFile(
  ppq: number,
  events: MidiEvent[],
  microsPerQuarter: number = DEFAULT_MICROS_PER_QUARTER,
): Uint8Array<ArrayBuffer> {
  const sorted = [...events].sort((a, b) => a.tick - b.tick);
  const track: number[] = [];

  // Tempo meta event at tick 0.
  track.push(0x00, 0xff, 0x51, 0x03, (microsPerQuarter >> 16) & 0xff, (microsPerQuarter >> 8) & 0xff, microsPerQuarter & 0xff);

  let lastTick = 0;
  const pushDelta = (tick: number) => {
    track.push(...writeVLQ(tick - lastTick));
    lastTick = tick;
  };

  for (const ev of sorted) {
    pushDelta(ev.tick);
    switch (ev.kind) {
      case 'noteOn':
        track.push(0x90 | (ev.channel & 0x0f), ev.note & 0x7f, ev.velocity & 0x7f);
        break;
      case 'noteOff':
        track.push(0x80 | (ev.channel & 0x0f), ev.note & 0x7f, ev.velocity & 0x7f);
        break;
      case 'cc':
        track.push(0xb0 | (ev.channel & 0x0f), ev.controller & 0x7f, ev.value & 0x7f);
        break;
      case 'program':
        track.push(0xc0 | (ev.channel & 0x0f), ev.program & 0x7f);
        break;
      case 'pitchBend':
        track.push(0xe0 | (ev.channel & 0x0f), ev.value & 0x7f, (ev.value >> 7) & 0x7f);
        break;
    }
  }

  // End of track.
  track.push(0x00, 0xff, 0x2f, 0x00);

  const header: number[] = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // header length 6
    0x00, 0x00, // format 0
    0x00, 0x01, // one track
    (ppq >> 8) & 0xff, ppq & 0xff,
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (track.length >>> 24) & 0xff,
    (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff,
    track.length & 0xff,
  ];
  return new Uint8Array([...header, ...track]);
}
