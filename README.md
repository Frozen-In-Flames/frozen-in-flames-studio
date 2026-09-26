# Frozen In Flames Studio

**Frozen In Flames — Lucid Triangulation Records** · © 2026 Aries Hilton · Apache-2.0

A browser-based music studio built with TypeScript, Vite, native Web Audio, and
hand-written CSS. Zero runtime dependencies.

## What it does

- **Marxophone** — hammer-strike additive voice (saw fundamental + 2.001× triangle
  shimmer + 3.98× chime), 15 ms filtered-noise hammer transient, body lowpass sweep,
  tube waveshaper, exponential decay, optional spring-hammer bounce retrigger,
  16-voice pool with release-priority stealing. Tunings: 12/19/24/31 EDO, 5-limit
  just intonation, Pythagorean, cents offset.
- **808 Studio** — sine sub-bass with pitch envelope, click transient, saturation,
  24 dB/oct lowpass, 16-step sweep from a start cutoff (20–200 Hz) up to 1200 Hz over
  4 bars, plus kick / snare / hat synthesis and a chaotic-modulation helper.
  The sub-bass chain runs through a 90 Hz Linkwitz-Riley crossover (lows summed
  to mono, highs stereo) with kick-triggered sidechain ducking.
- **Spatial mixer** — draggable stereo stem field. X = pan, Z = distance
  (gain + lowpass + reverb send follow). Per-stem 3-band EQ, mute/solo, collision
  detection with Low-End Rumble / Mid-Range Masking labels, auto-scatter,
  priority-based auto-masking, four spatial presets. Stereo only.
- **Sequencer** — 16-step, 25 ms lookahead timer, absolute-time scheduling, demo
  patterns for bass / drums / melody / chords / full mix, paired note-on/note-off
  for every sequenced note, and an honest scheduler-cost readout measured from real
  callback timings.
- **MIDI** — import Standard MIDI Files (Type 0/1, running status, tempo maps) and
  play them through the marxophone; export the 808 sweep as real MIDI
  (CC74 automation) or a demo bass line.
- **Export** — render the full-mix demo offline faster than real time and download
  a 32-bit float WAV (peak-normalized with a silence guard).
- **Visual field** — procedural bilateral-mirror field with RGB channel
  displacement, intensity driven by the live analyser. Canvas 2D.

## Honest engineering notes

- Stereo only. No HRTF, binaural, Atmos, surround, or ambisonics anywhere.
- The multi-tap delay is a feedforward tapped delay line — it is not called a
  feedback delay network.
- The resonator is a parallel bandpass bus of causal BiquadFilters — never
  zero-phase.
- No AI / neural / quantum labels; the chaotic modulator is a documented
  deterministic logistic map.
- The performance meter reports measured callback cost, not a benchmark claim.

## Develop

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck + production build
npm run test     # vitest
npm run preview  # serve the production build
```

## Layout

```
src/
  audio/        # engine, tuning, midi, marxophone, eight08, mixer, dsp, sequencer
  ui/           # keybed, panel808, mixerview, panels (transport + MIDI/export)
  visuals.ts    # analyser-reactive visual field (pure helpers + renderer)
  main.ts       # bootstrap: audio init on user gesture, tab wiring
tests/          # 100 vitest tests covering the audio/logic layer
```

The UI layer imports only from `src/audio/*` and `src/visuals.ts`.
