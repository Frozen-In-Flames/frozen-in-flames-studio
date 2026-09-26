/**
 * ui/panels.ts — Transport strip (sequencer play/stop, BPM, pattern select,
 * playhead, honest performance readout) and the MIDI/WAV panel
 * (MIDI import + playback, MIDI export, offline 32-bit WAV render).
 */

import type { AudioEngine, AudioHost } from '../audio/engine.js';
import { makeImpulseResponse } from '../audio/engine.js';
import { EightOhEight } from '../audio/eight08.js';
import { MarxophoneEngine } from '../audio/marxophone.js';
import {
  DEMO_BASS,
  DEMO_CHORDS,
  DEMO_DRUMS,
  DEMO_MELODY,
  STEPS,
  Sequencer,
  stepDur,
  type Pattern,
  type StepNote,
  type VoiceTag,
} from '../audio/sequencer.js';
import { parseMidiFile, writeMidiFile, type MidiEvent, type ParsedMidi } from '../audio/midi.js';
import { renderOfflineWav } from '../audio/dsp.js';

export type PatternName = 'bass' | 'drums' | 'melody' | 'chords' | 'full';

export function tagPattern(pattern: Pattern, voice: VoiceTag): Pattern {
  return pattern.map((step) => (step ? step.map((n) => ({ ...n, voice })) : null));
}

export function mergePatterns(...patterns: Pattern[]): Pattern {
  return Array.from({ length: STEPS }, (_, i) => {
    const notes: StepNote[] = [];
    for (const p of patterns) {
      const s = p[i];
      if (s) notes.push(...s);
    }
    return notes.length > 0 ? notes : null;
  });
}

export interface TransportDeps {
  engine: AudioEngine;
  /** 808 bass voice. */
  kit: EightOhEight;
  /** Kick/snare/hat drum voice. */
  drumsKit: EightOhEight;
  marx: MarxophoneEngine;
  getBpm: () => number;
  onBpmChange: (bpm: number) => void;
}

export function buildTransport(
  container: HTMLElement,
  deps: TransportDeps,
): { setPerf: (ms: number) => void; markStep: (step: number) => void } {
  const { engine, kit, drumsKit, marx, getBpm, onBpmChange } = deps;
  const wrap = document.createElement('div');
  wrap.className = 'transport';
  wrap.innerHTML = `
    <div class="group">
      <button class="primary" data-k="play">Play</button>
      <button data-k="stop">Stop</button>
    </div>
    <div class="group"><label>BPM</label>
      <input data-k="bpm" type="range" min="60" max="180" value="140" style="accent-color:#58a6ff">
      <label data-k="bpmVal">140</label></div>
    <div class="group"><label>PATTERN</label><select data-k="pattern">
      <option value="bass">808 Bass</option>
      <option value="drums">Drums</option>
      <option value="melody">Marxophone Melody</option>
      <option value="chords">Marxophone Chords</option>
      <option value="full" selected>Full mix</option>
    </select></div>
    <div class="playhead" data-k="playhead"></div>
    <div class="perf" data-k="perf">scheduler: — ms/step</div>
  `;
  container.appendChild(wrap);
  const q = <T extends HTMLElement>(k: string): T => {
    const el = wrap.querySelector(`[data-k="${k}"]`);
    if (!el) throw new Error(`transport: missing [data-k="${k}"]`);
    return el as T;
  };

  const playhead = q('playhead');
  const dots: HTMLElement[] = [];
  for (let i = 0; i < STEPS; i++) {
    const d = document.createElement('span');
    playhead.appendChild(d);
    dots.push(d);
  }

  let lastMs = 0;
  let count = 0;
  let avgMs = 0;
  const perfEl = q('perf');

  const patternFor = (name: PatternName): Pattern => {
    switch (name) {
      case 'bass': return tagPattern(DEMO_BASS, 'bass808');
      case 'drums': return tagPattern(DEMO_DRUMS, 'drums');
      case 'melody': return tagPattern(DEMO_MELODY, 'keys');
      case 'chords': return tagPattern(DEMO_CHORDS, 'keys');
      case 'full':
        return mergePatterns(
          tagPattern(DEMO_BASS, 'bass808'),
          tagPattern(DEMO_DRUMS, 'drums'),
          tagPattern(DEMO_MELODY, 'keys'),
        );
    }
  };

  const seq = new Sequencer(
    {
      onStep: (_step, time, notes) => {
        // Honest performance meter: measure the real scheduling cost.
        const { ms } = engine.measure('schedule', () => {
          const d = stepDur(getBpm());
          for (const n of notes) {
            const vel = n.velocity ?? 0.8;
            const len = (n.len ?? 1) * d;
            if (n.voice === 'bass808') {
              kit.trigger(n.midi, { when: time, velocity: vel, lengthBeats: len / d });
            } else if (n.voice === 'drums') {
              if (n.midi === 36) {
                drumsKit.kick(time, vel);
                kit.duckAt(time); // kick-triggered sidechain on the sub-bass bus
              } else if (n.midi === 40) drumsKit.snare(time, vel);
              else drumsKit.hat(time, vel);
            } else {
              marx.noteOn(n.midi, vel, time);
              marx.noteOff(n.midi, time + len * 0.9);
            }
          }
        });
        lastMs = ms;
        count++;
        avgMs += (ms - avgMs) / count;
        perfEl.textContent = `scheduler: ${lastMs.toFixed(2)} ms/step (avg ${avgMs.toFixed(2)})`;
      },
      onScheduled: (step) => {
        for (const dd of dots) dd.classList.remove('now');
        dots[step].classList.add('now');
      },
    },
    () => engine.now(),
    { bpm: getBpm(), pattern: patternFor('full') },
  );

  const playBtn = q<HTMLButtonElement>('play');
  const stopBtn = q<HTMLButtonElement>('stop');
  playBtn.addEventListener('click', () => {
    seq.setBpm(getBpm());
    seq.start();
    playBtn.disabled = true;
    stopBtn.disabled = false;
  });
  const stopAll = () => {
    seq.stop();
    kit.stopAll();
    drumsKit.stopAll();
    marx.panic();
    for (const dd of dots) dd.classList.remove('now');
    playBtn.disabled = false;
    stopBtn.disabled = true;
  };
  stopBtn.addEventListener('click', stopAll);
  stopBtn.disabled = true;

  q<HTMLInputElement>('bpm').addEventListener('input', (e) => {
    const bpm = parseInt((e.target as HTMLInputElement).value, 10);
    q('bpmVal').textContent = `${bpm}`;
    onBpmChange(bpm);
    seq.setBpm(bpm);
  });
  q<HTMLSelectElement>('pattern').addEventListener('change', (e) => {
    seq.setPattern(patternFor((e.target as HTMLSelectElement).value as PatternName));
  });

  // Browser-reported audio latencies stay off the perf readout:
  // only the measured scheduler cost above is shown.

  return {
    setPerf: (ms: number) => {
      perfEl.textContent = `scheduler: ${ms.toFixed(2)} ms/step`;
    },
    markStep: (step: number) => {
      for (const dd of dots) dd.classList.remove('now');
      dots[step]?.classList.add('now');
    },
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export interface MidiPanelDeps {
  marx: MarxophoneEngine;
  getBpm: () => number;
}

export function buildMidiPanel(container: HTMLElement, deps: MidiPanelDeps): void {
  const { marx, getBpm } = deps;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h2>MIDI &amp; EXPORT</h2>
    <p class="sub">Import a Standard MIDI File and play it through the marxophone,
    or export your work as MIDI / 32-bit WAV.</p>
    <div class="row">
      <label class="stem-tag">Import .mid <input data-k="file" type="file" accept=".mid,.midi" style="display:none"></label>
      <button data-k="playImp" disabled>Play imported</button>
      <button data-k="stopImp" disabled>Stop</button>
      <span data-k="info" style="font-size:12px;color:#8b949e"></span>
    </div>
    <div class="row">
      <button data-k="expBass">Export bass pattern (.mid)</button>
      <button data-k="expWav">Render mix to 32-bit WAV (offline)</button>
      <span data-k="wavInfo" style="font-size:12px;color:#8b949e"></span>
    </div>
    <p class="note">WAV export renders the full-mix demo (808 bass + drums + marxophone melody)
    with an <code>OfflineAudioContext</code> — faster than real time — then peak-normalizes
    with a silence guard and writes 32-bit float WAV.</p>
  `;
  container.appendChild(wrap);
  const q = <T extends HTMLElement>(k: string): T => {
    const el = wrap.querySelector(`[data-k="${k}"]`);
    if (!el) throw new Error(`midipanel: missing [data-k="${k}"]`);
    return el as T;
  };

  let imported: ParsedMidi | null = null;
  let timeouts: ReturnType<typeof setTimeout>[] = [];
  const fileInput = q<HTMLInputElement>('file');
  const info = q('info');
  const playImp = q<HTMLButtonElement>('playImp');
  const stopImp = q<HTMLButtonElement>('stopImp');

  q('file').parentElement?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      imported = parseMidiFile(bytes);
      const dur = imported.events.length > 0
        ? (imported.events[imported.events.length - 1].seconds ?? 0)
        : 0;
      info.textContent =
        `${f.name}: ${imported.events.length} events, ${imported.ppq} ppq, ~${dur.toFixed(1)} s`;
      playImp.disabled = false;
    } catch (err) {
      info.textContent = `Could not parse: ${(err as Error).message}`;
      imported = null;
      playImp.disabled = true;
    }
  });

  const stopImported = () => {
    for (const t of timeouts) clearTimeout(t);
    timeouts = [];
    marx.panic();
    stopImp.disabled = true;
  };
  playImp.addEventListener('click', () => {
    if (!imported) return;
    stopImported();
    const t0 = performance.now();
    for (const ev of imported.events) {
      const at = t0 + (ev.seconds ?? 0) * 1000 - performance.now();
      if (ev.kind === 'noteOn') {
        timeouts.push(setTimeout(() => marx.noteOn(ev.note, ev.velocity / 127), Math.max(0, at)));
      } else if (ev.kind === 'noteOff') {
        timeouts.push(setTimeout(() => marx.noteOff(ev.note), Math.max(0, at)));
      }
    }
    stopImp.disabled = false;
  });
  stopImp.addEventListener('click', stopImported);

  q('expBass').addEventListener('click', () => {
    const events: MidiEvent[] = [];
    const ppq = 480;
    DEMO_BASS.forEach((step, i) => {
      if (!step) return;
      for (const n of step) {
        const tick = i * (ppq / 4);
        events.push({ kind: 'noteOn', tick, channel: 0, note: n.midi, velocity: Math.round((n.velocity ?? 0.8) * 127) });
        events.push({ kind: 'noteOff', tick: tick + ppq / 4, channel: 0, note: n.midi, velocity: 0 });
      }
    });
    const bytes = writeMidiFile(ppq, events, Math.round(60_000_000 / getBpm()));
    downloadBlob(new Blob([bytes], { type: 'audio/midi' }), 'frozen-in-flames-bass.mid');
  });

  q('expWav').addEventListener('click', async () => {
    const wavInfo = q('wavInfo');
    wavInfo.textContent = 'Rendering…';
    try {
      const sampleRate = 44100;
      const bpm = getBpm();
      const d = stepDur(bpm);
      const seconds = d * 32 + 2;
      const wav = await renderOfflineWav(seconds, sampleRate, (ctx, master) => {
        const bus = ctx.createGain();
        bus.gain.value = 0.9;
        bus.connect(master);
        const convolver = ctx.createConvolver();
        const [l, r] = makeImpulseResponse(sampleRate, 2.2, 3.5);
        const imp = ctx.createBuffer(2, l.length, sampleRate);
        imp.getChannelData(0).set(l);
        imp.getChannelData(1).set(r);
        convolver.buffer = imp;
        const revRet = ctx.createGain();
        revRet.gain.value = 0.5;
        convolver.connect(revRet);
        revRet.connect(master);
        const host: AudioHost = { ctx, bus, convolver, reverbReturn: revRet };
        const okit = new EightOhEight(host);
        const omarx = new MarxophoneEngine(host, { decay: 0.7 });
        for (let s = 0; s < 32; s++) {
          const t = 0.1 + s * d;
          const b = DEMO_BASS[s % STEPS];
          if (b) for (const nn of b) okit.trigger(nn.midi, { when: t, velocity: nn.velocity, lengthBeats: 0.5 });
          const dr = DEMO_DRUMS[s % STEPS];
          if (dr) {
            for (const nn of dr) {
              if (nn.midi === 36) {
                okit.kick(t, nn.velocity);
                okit.duckAt(t); // same kick-triggered sidechain as the live transport
              } else if (nn.midi === 40) okit.snare(t, nn.velocity);
              else okit.hat(t, nn.velocity);
            }
          }
          const m = DEMO_MELODY[s % STEPS];
          if (m) {
            for (const nn of m) {
              omarx.noteOn(nn.midi, nn.velocity ?? 0.7, t);
              omarx.noteOff(nn.midi, t + (nn.len ?? 1) * d * 0.9);
            }
          }
        }
      });
      downloadBlob(new Blob([wav], { type: 'audio/wav' }), 'frozen-in-flames-mix.wav');
      wavInfo.textContent = `Done — ${(wav.length / 1024).toFixed(0)} KB, 32-bit float, ${sampleRate} Hz.`;
    } catch (err) {
      wavInfo.textContent = `Render failed: ${(err as Error).message}`;
    }
  });
}
