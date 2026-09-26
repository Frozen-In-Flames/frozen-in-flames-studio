/**
 * visuals.ts — "Frozen In Flames" canvas renderer.
 *
 * Effects (ported from the artist's audiovisual notes):
 *  - Bilateral mirror: the left half of the frame is flipped onto the right.
 *    Odd widths are handled: the center column is drawn unmirrored.
 *  - Chromatic displacement: red channel shifted +N px, blue channel -N px.
 *  - Audio-reactive: analyser frequency data drives displacement intensity
 *    and a slow pulse in the mirror seam.
 *
 * The base frame is procedural (ice-blue / flame-orange gradient field with
 * drifting sine bands), so the renderer works with no image assets.
 */

/** Source x for output column x in a mirrored frame of `width`. */
export function mirrorIndex(x: number, width: number): number {
  const half = Math.floor(width / 2);
  if (x < half) return x;
  if (width % 2 === 1 && x === half) return half; // center column stays
  return width - 1 - x;
}

/** Clamp a channel shift so it never exceeds `maxPx`. */
export function channelShift(amount: number, maxPx: number): number {
  return Math.max(-maxPx, Math.min(maxPx, amount));
}

export class FrozenFlamesRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frame: HTMLCanvasElement;
  private fctx: CanvasRenderingContext2D;
  private red: HTMLCanvasElement;
  private blue: HTMLCanvasElement;
  private aberration = 12;
  private running = false;
  private raf = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.frame = document.createElement('canvas');
    const fctx = this.frame.getContext('2d');
    if (!fctx) throw new Error('2D canvas context unavailable');
    this.fctx = fctx;
    this.red = document.createElement('canvas');
    this.blue = document.createElement('canvas');
  }

  setAberration(px: number): void {
    this.aberration = Math.max(0, Math.min(48, px));
  }

  start(analyser: AnalyserNode | null): void {
    this.stop();
    this.running = true;
    const freq = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const loop = (tms: number) => {
      if (!this.running) return;
      let energy = 0.35;
      if (analyser && freq) {
        analyser.getByteFrequencyData(freq);
        let sum = 0;
        const bins = Math.min(freq.length, 256);
        for (let i = 0; i < bins; i++) sum += freq[i];
        energy = sum / (bins * 255);
      }
      this.render(tms / 1000, energy);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private sizeOffscreen(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (const c of [this.frame, this.red, this.blue]) {
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
    }
  }

  /** Procedural base frame: ice field below, flame bands above, drifting. */
  private drawBase(t: number): void {
    const w = this.frame.width;
    const h = this.frame.height;
    const g = this.fctx;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1a0b2e');
    grad.addColorStop(0.42, '#7a2a12');
    grad.addColorStop(0.55, '#0e2a4a');
    grad.addColorStop(1, '#9fd8ff');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    // Drifting flame bands (warm) and ice bands (cool).
    for (let b = 0; b < 7; b++) {
      const yBase = h * (0.12 + b * 0.11);
      const warm = b % 2 === 0;
      g.strokeStyle = warm ? `rgba(255,${110 + b * 12},40,0.5)` : `rgba(140,210,255,0.45)`;
      g.lineWidth = 3 + (b % 3) * 2;
      g.beginPath();
      for (let x = 0; x <= w; x += 6) {
        const y = yBase + Math.sin(x * 0.02 + t * (0.9 + b * 0.22) + b * 1.7) * (8 + b * 3);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }

    // Ember particles rising.
    g.fillStyle = 'rgba(255,170,80,0.8)';
    for (let p = 0; p < 40; p++) {
      const px = (p * 97.3 + t * (12 + p)) % w;
      const py = h - ((p * 57.7 + t * (24 + (p % 5) * 9)) % h);
      const r = 1 + (p % 3);
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** Isolate one color channel of `src` into `dst` via multiply compositing. */
  private isolateChannel(src: HTMLCanvasElement, dst: HTMLCanvasElement, channel: 'red' | 'blue'): void {
    const w = src.width;
    const h = src.height;
    dst.width = w;
    dst.height = h;
    const dctx = dst.getContext('2d');
    if (!dctx) return;
    dctx.globalCompositeOperation = 'source-over';
    dctx.drawImage(src, 0, 0);
    dctx.globalCompositeOperation = 'multiply';
    dctx.fillStyle = channel === 'red' ? '#ff0000' : '#0000ff';
    dctx.fillRect(0, 0, w, h);
    dctx.globalCompositeOperation = 'source-over';
  }

  private render(t: number, energy: number): void {
    this.sizeOffscreen();
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;

    this.drawBase(t);

    // --- Bilateral mirror: left half flipped onto the right. ---
    const half = Math.floor(w / 2);
    const odd = w % 2 === 1;
    // Copy the left half aside first so the flip reads clean pixels.
    const left = document.createElement('canvas');
    left.width = half;
    left.height = h;
    const lctx = left.getContext('2d');
    if (lctx) {
      lctx.drawImage(this.frame, 0, 0, half, h, 0, 0, half, h);
      this.fctx.save();
      this.fctx.translate(w, 0);
      this.fctx.scale(-1, 1);
      this.fctx.drawImage(left, odd ? 1 : 0, 0);
      this.fctx.restore();
      if (odd) {
        // Center column drawn unmirrored.
        this.fctx.drawImage(this.frame, half, 0, 1, h, half, 0, 1, h);
      }
    }

    // --- Chromatic displacement, driven by audio energy. ---
    const ab = channelShift(this.aberration * (0.35 + energy * 1.6), 48);
    this.isolateChannel(this.frame, this.red, 'red');
    this.isolateChannel(this.frame, this.blue, 'blue');

    this.ctx.clearRect(0, 0, w, h);
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.drawImage(this.frame, 0, 0);
    this.ctx.globalCompositeOperation = 'lighter';
    this.ctx.globalAlpha = 0.85;
    this.ctx.drawImage(this.red, ab, 0);
    this.ctx.drawImage(this.blue, -ab, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';

    // Mirror seam pulse.
    const seamX = odd ? half : half - 0.5;
    this.ctx.strokeStyle = `rgba(160,220,255,${0.25 + energy * 0.5})`;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    this.ctx.moveTo(seamX, 0);
    this.ctx.lineTo(seamX, h);
    this.ctx.stroke();
  }
}
