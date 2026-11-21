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
  /** Track name meta (0x03) per track, in file order; null when unnamed. */
  trackNames: (string | null)[];
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
  trackName: string | null;
}

function parseTrack(data: Uint8Array, start: number, length: number): TrackParse {
  const events: MidiEvent[] = [];
  const tempos: TempoChange[] = [];
  let trackName: string | null = null;
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
      if (metaType === 0x03 && trackName === null) {
        trackName = String.fromCharCode(...data.subarray(offset, offset + lenInfo.value));
      }
      // Other meta events (time signature, end of track, ...) are skipped.
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

  return { events, tempos, trackName };
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
  const trackNames: (string | null)[] = [];
  for (let t = 0; t < trackCount; t++) {
    if (offset + 8 > bytes.length) throw new Error('Truncated MTrk header');
    if (chunkTag(bytes, offset) !== 'MTrk') throw new Error('Missing MTrk header');
    const trackLen = readU32BE(bytes, offset + 4);
    const parsed = parseTrack(bytes, offset + 8, trackLen);
    allEvents.push(...parsed.events);
    allTempos.push(...parsed.tempos);
    trackNames.push(parsed.trackName);
    offset += 8 + trackLen;
  }

  const tempoMap = buildTempoMap(allTempos);
  allEvents.sort((a, b) => a.tick - b.tick);
  for (const ev of allEvents) {
    ev.seconds = ticksToSeconds(ev.tick, ppq, tempoMap);
  }
  return { ppq, events: allEvents, tempoMap, trackNames };
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

/* ------------------------------------------------------------------ */
/* fif-smf-1 contract export (D1)                                      */
/*                                                                     */
/* The default export above stays format 0. A contract bundle expands  */
/* to format 1 at bundle time: a dedicated conductor track named       */
/* "Tempo" carrying 0x51 tempo and 0x58 time signature at tick 0, one  */
/* named track per part, channel index 9 reserved for GM drums, plus   */
/* a sidecar.json manifest.                                            */
/* ------------------------------------------------------------------ */

export const FIF_SMF_CONTRACT_ID = 'fif-smf-1';
export const DRUM_CHANNEL = 9;

export interface ContractPart {
  /** Track name, written as meta 0x03 at tick 0. */
  name: string;
  /** The single channel this part plays on. Drum parts are forced to 9. */
  channel: number;
  /** True for a General MIDI drum part (channel index 9). */
  drums?: boolean;
  events: MidiEvent[];
}

export interface ContractTimeSignature {
  numerator: number;
  /** Denominator as a note value: 4 means a quarter note. */
  denominator: number;
}

export interface ContractExportOptions {
  /** Division of the contract file. The contract fixes this at 480. */
  ppq?: number;
  /** Full tempo map for the conductor. Defaults to a single tempo. */
  tempoMap?: TempoChange[];
  /** Single tempo used when tempoMap is not given. */
  microsPerQuarter?: number;
  /** Meter for the 0x58 meta and the sidecar. Default 4/4. */
  timeSignature?: ContractTimeSignature;
}

export interface ContractBundleOptions extends ContractExportOptions {
  /** File name the sidecar points at. Default "score.mid". */
  midiFileName?: string;
  /** Provenance tool name. Default "frozen-in-flames-studio". */
  tool?: string;
  /** Provenance tool version. Default "1.0.0". */
  version?: string;
  /** Path of a fif-ears report run on the bundle, or null. Default null. */
  earsReport?: string | null;
}

export interface ContractSidecar {
  contract: typeof FIF_SMF_CONTRACT_ID;
  midi: string;
  tempo_bpm: number;
  tempo_map: { tick: number; bpm: number }[];
  meter: string;
  ears_report: string | null;
  provenance: { tool: string; version: string };
}

export interface ContractBundle {
  midi: Uint8Array<ArrayBuffer>;
  sidecar: ContractSidecar;
  /** sidecar serialized for writing next to the .mid as sidecar.json. */
  sidecarJson: string;
}

const microsToBpm = (micros: number): number =>
  Math.round((60000000 / micros) * 1000) / 1000;

function normalizeContractTempoMap(options: ContractExportOptions): TempoChange[] {
  const fallback = options.microsPerQuarter ?? DEFAULT_MICROS_PER_QUARTER;
  const sorted = [...(options.tempoMap ?? [])].sort((a, b) => a.tick - b.tick);
  if (sorted.length === 0) return [{ tick: 0, microsPerQuarter: fallback }];
  if (sorted[0].tick > 0) sorted.unshift({ tick: 0, microsPerQuarter: fallback });
  return sorted;
}

interface OrderedBytes { tick: number; order: number; bytes: number[] }

function buildContractTrack(events: OrderedBytes[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const out: number[] = [];
  let lastTick = 0;
  for (const ev of sorted) {
    out.push(...writeVLQ(ev.tick - lastTick), ...ev.bytes);
    lastTick = ev.tick;
  }
  out.push(0x00, 0xff, 0x2f, 0x00); // end of track
  return out;
}

function trackChunk(track: number[]): number[] {
  return [
    0x4d, 0x54, 0x72, 0x6b, // MTrk
    (track.length >>> 24) & 0xff,
    (track.length >>> 16) & 0xff,
    (track.length >>> 8) & 0xff,
    track.length & 0xff,
    ...track,
  ];
}

function nameMeta(name: string): number[] {
  const bytes = [...name].map((c) => c.charCodeAt(0) & 0xff);
  return [0xff, 0x03, ...writeVLQ(bytes.length), ...bytes];
}

function eventBytes(ev: MidiEvent, channel: number): number[] {
  switch (ev.kind) {
    case 'noteOn':
      return [0x90 | channel, ev.note & 0x7f, ev.velocity & 0x7f];
    case 'noteOff':
      return [0x80 | channel, ev.note & 0x7f, ev.velocity & 0x7f];
    case 'cc':
      return [0xb0 | channel, ev.controller & 0x7f, ev.value & 0x7f];
    case 'program':
      return [0xc0 | channel, ev.program & 0x7f];
    case 'pitchBend':
      return [0xe0 | channel, ev.value & 0x7f, (ev.value >> 7) & 0x7f];
  }
}

/**
 * Write a fif-smf-1 contract file: SMF format 1, one conductor track
 * named "Tempo" (0x51 tempo map and 0x58 time signature at tick 0),
 * then one track per part, each named at tick 0. Drum parts are written
 * on channel index 9; a melodic part on channel index 9 is an error,
 * as is a part whose events span more than one channel.
 */
export function writeContractMidiFile(
  parts: ContractPart[],
  options: ContractExportOptions = {},
): Uint8Array<ArrayBuffer> {
  const ppq = options.ppq ?? 480;
  const meter = options.timeSignature ?? { numerator: 4, denominator: 4 };
  const tempoMap = normalizeContractTempoMap(options);

  const conductor: OrderedBytes[] = [
    { tick: 0, order: -3, bytes: nameMeta('Tempo') },
    {
      tick: 0, order: -2,
      bytes: [0xff, 0x58, 0x04, meter.numerator & 0xff, Math.round(Math.log2(meter.denominator)) & 0xff, 24, 8],
    },
  ];
  tempoMap.forEach((t, i) => {
    conductor.push({
      tick: t.tick, order: -1 + i * 0.001,
      bytes: [0xff, 0x51, 0x03, (t.microsPerQuarter >> 16) & 0xff, (t.microsPerQuarter >> 8) & 0xff, t.microsPerQuarter & 0xff],
    });
  });

  const tracks: number[][] = [trackChunk(buildContractTrack(conductor))];
  for (const part of parts) {
    const channel = part.drums ? DRUM_CHANNEL : part.channel & 0x0f;
    if (!part.drums && channel === DRUM_CHANNEL) {
      throw new Error(`fif-smf-1: melodic part "${part.name}" may not use drum channel 9`);
    }
    const events: OrderedBytes[] = [{ tick: 0, order: -1, bytes: nameMeta(part.name) }];
    for (const ev of part.events) {
      if (!part.drums && ev.channel !== part.channel) {
        throw new Error(`fif-smf-1: part "${part.name}" spans more than one channel`);
      }
      events.push({ tick: ev.tick, order: 0, bytes: eventBytes(ev, channel) });
    }
    tracks.push(trackChunk(buildContractTrack(events)));
  }

  const header: number[] = [
    0x4d, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // header length 6
    0x00, 0x01, // format 1
    (tracks.length >> 8) & 0xff, tracks.length & 0xff,
    (ppq >> 8) & 0xff, ppq & 0xff,
  ];
  return new Uint8Array([...header, ...tracks.flat()]);
}

/** Build the fif-smf-1 sidecar manifest for a contract bundle. */
export function buildContractSidecar(options: ContractBundleOptions = {}): ContractSidecar {
  const tempoMap = normalizeContractTempoMap(options);
  const meter = options.timeSignature ?? { numerator: 4, denominator: 4 };
  return {
    contract: FIF_SMF_CONTRACT_ID,
    midi: options.midiFileName ?? 'score.mid',
    tempo_bpm: microsToBpm(tempoMap[0].microsPerQuarter),
    tempo_map: tempoMap.map((t) => ({ tick: t.tick, bpm: microsToBpm(t.microsPerQuarter) })),
    meter: `${meter.numerator}/${meter.denominator}`,
    ears_report: options.earsReport ?? null,
    provenance: {
      tool: options.tool ?? 'frozen-in-flames-studio',
      version: options.version ?? '1.0.0',
    },
  };
}

/**
 * Export a contract bundle: the format 1 contract .mid bytes plus the
 * sidecar manifest (object form and JSON text for sidecar.json). The
 * existing format 0 export (writeMidiFile) is untouched and remains
 * the default single file export.
 */
export function exportContractBundle(
  parts: ContractPart[],
  options: ContractBundleOptions = {},
): ContractBundle {
  const sidecar = buildContractSidecar(options);
  return {
    midi: writeContractMidiFile(parts, options),
    sidecar,
    sidecarJson: JSON.stringify(sidecar, null, 2),
  };
}
