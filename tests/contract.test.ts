import { describe, expect, it } from 'vitest';
import {
  buildContractSidecar,
  exportContractBundle,
  parseMidiFile,
  writeContractMidiFile,
  writeMidiFile,
  type ContractPart,
  type MidiEvent,
} from '../src/audio/midi.js';

const parts: ContractPart[] = [
  {
    name: 'Lead',
    channel: 0,
    events: [
      { kind: 'program', tick: 0, channel: 0, program: 80 },
      { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
      { kind: 'noteOff', tick: 480, channel: 0, note: 60, velocity: 0 },
      { kind: 'noteOn', tick: 960, channel: 0, note: 62, velocity: 90 },
      { kind: 'noteOff', tick: 1440, channel: 0, note: 62, velocity: 0 },
    ],
  },
  {
    name: 'Drums',
    channel: 0, // deliberately wrong in the source; a drum part must land on 9
    drums: true,
    events: [
      { kind: 'noteOn', tick: 0, channel: 0, note: 36, velocity: 127 },
      { kind: 'noteOff', tick: 120, channel: 0, note: 36, velocity: 0 },
    ],
  },
];

const tempoMap = [
  { tick: 0, microsPerQuarter: 500000 }, // 120 BPM
  { tick: 960, microsPerQuarter: 1000000 }, // 60 BPM
];

/** Raw per-track scan of an SMF, independent of parseMidiFile. */
function scanTracks(bytes: Uint8Array) {
  const u16 = (o: number) => (bytes[o] << 8) | bytes[o + 1];
  const u32 = (o: number) =>
    (bytes[o] * 0x1000000 + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3]) >>> 0;
  const format = u16(8);
  const ntrk = u16(10);
  const division = u16(12);
  let pos = 14;
  const tracks: { name: string | null; metas: { tick: number; type: number; data: number[] }[]; noteChannels: Set<number> }[] = [];
  for (let t = 0; t < ntrk; t++) {
    expect(String.fromCharCode(...bytes.subarray(pos, pos + 4))).toBe('MTrk');
    const len = u32(pos + 4);
    pos += 8;
    const end = pos + len;
    let tick = 0;
    let running = 0;
    const track = { name: null as string | null, metas: [] as { tick: number; type: number; data: number[] }[], noteChannels: new Set<number>() };
    const readV = () => {
      let v = 0;
      for (;;) { const b = bytes[pos++]; v = (v << 7) | (b & 127); if (!(b & 128)) break; }
      return v;
    };
    while (pos < end) {
      tick += readV();
      let status = bytes[pos];
      if (status & 0x80) { pos++; running = status; } else { status = running; }
      if (status === 0xff) {
        const type = bytes[pos++];
        const mlen = readV();
        const data = [...bytes.subarray(pos, pos + mlen)];
        track.metas.push({ tick, type, data });
        if (type === 0x03 && tick === 0) track.name = String.fromCharCode(...data);
        pos += mlen;
        running = 0;
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readV();
        running = 0;
      } else {
        const kind = status & 0xf0;
        const channel = status & 0x0f;
        pos++;
        const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[pos++];
        if (kind === 0x90 && d2 > 0) track.noteChannels.add(channel);
      }
    }
    tracks.push(track);
    pos = end;
  }
  return { format, ntrk, division, tracks };
}

describe('fif-smf-1 contract export (D1)', () => {
  it('writes format 1 with a Tempo conductor, 0x51 and 0x58 at tick 0, named tracks, drums on channel 9', () => {
    const bytes = writeContractMidiFile(parts, { tempoMap });
    const { format, ntrk, division, tracks } = scanTracks(bytes);
    expect(format).toBe(1);
    expect(ntrk).toBe(3);
    expect(division).toBe(480);
    const conductor = tracks[0];
    expect(conductor.name).toBe('Tempo');
    const tempos = conductor.metas.filter((m) => m.type === 0x51);
    expect(tempos.map((m) => m.tick)).toEqual([0, 960]);
    const timesig = conductor.metas.find((m) => m.type === 0x58);
    expect(timesig?.tick).toBe(0);
    expect(timesig?.data.slice(0, 2)).toEqual([4, 2]); // 4/4
    expect(tracks.map((t) => t.name)).toEqual(['Tempo', 'Lead', 'Drums']);
    expect([...tracks[1].noteChannels]).toEqual([0]);
    expect([...tracks[2].noteChannels]).toEqual([9]);
  });

  it('parses back through the Studio reader with correct notes, tempo map and seconds', () => {
    const bytes = writeContractMidiFile(parts, { tempoMap });
    const parsed = parseMidiFile(bytes);
    expect(parsed.ppq).toBe(480);
    expect(parsed.tempoMap).toEqual(tempoMap);
    expect(parsed.trackNames).toEqual(['Tempo', 'Lead', 'Drums']);
    const strip = (evs: MidiEvent[]) => evs.map(({ seconds: _s, ...rest }) => rest);
    const expected: MidiEvent[] = [
      { kind: 'program', tick: 0, channel: 0, program: 80 },
      { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
      { kind: 'noteOn', tick: 0, channel: 9, note: 36, velocity: 127 },
      { kind: 'noteOff', tick: 120, channel: 9, note: 36, velocity: 0 },
      { kind: 'noteOff', tick: 480, channel: 0, note: 60, velocity: 0 },
      { kind: 'noteOn', tick: 960, channel: 0, note: 62, velocity: 90 },
      { kind: 'noteOff', tick: 1440, channel: 0, note: 62, velocity: 0 },
    ];
    expect(strip(parsed.events)).toEqual(
      strip([...expected].sort((a, b) => a.tick - b.tick)),
    );
    // Tick 960 is the tempo change point: 2 quarters at 120 BPM = 1 second.
    const late = parsed.events.find((e) => e.kind === 'noteOn' && e.tick === 960);
    expect(late?.seconds).toBeCloseTo(1, 9);
  });

  it('rejects a melodic part on drum channel 9 and a multi-channel part', () => {
    expect(() =>
      writeContractMidiFile([
        { name: 'Bad', channel: 9, events: [{ kind: 'noteOn', tick: 0, channel: 9, note: 60, velocity: 1 }] },
      ]),
    ).toThrow(/drum channel 9/);
    expect(() =>
      writeContractMidiFile([
        {
          name: 'Wide', channel: 0,
          events: [
            { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 1 },
            { kind: 'noteOn', tick: 0, channel: 1, note: 62, velocity: 1 },
          ],
        },
      ]),
    ).toThrow(/more than one channel/);
  });

  it('leaves the format 0 default export unchanged', () => {
    const bytes = writeMidiFile(480, [
      { kind: 'noteOn', tick: 0, channel: 0, note: 60, velocity: 100 },
    ]);
    expect((bytes[8] << 8) | bytes[9]).toBe(0); // format 0
    expect((bytes[10] << 8) | bytes[11]).toBe(1); // one track
    const parsed = parseMidiFile(bytes);
    expect(parsed.trackNames).toEqual([null]);
  });

  it('builds the sidecar manifest with ears_report null when no report was run', () => {
    const bundle = exportContractBundle(parts, { tempoMap });
    expect(bundle.sidecar).toEqual({
      contract: 'fif-smf-1',
      midi: 'score.mid',
      tempo_bpm: 120,
      tempo_map: [
        { tick: 0, bpm: 120 },
        { tick: 960, bpm: 60 },
      ],
      meter: '4/4',
      ears_report: null,
      provenance: { tool: 'frozen-in-flames-studio', version: '1.0.0' },
    });
    expect(JSON.parse(bundle.sidecarJson)).toEqual(bundle.sidecar);
    // The bundle midi is the contract file itself.
    expect(parseMidiFile(bundle.midi).trackNames).toEqual(['Tempo', 'Lead', 'Drums']);
    expect(buildContractSidecar({}).tempo_bpm).toBe(120);
  });
});
