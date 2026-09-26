/**
 * ui/mixerview.ts — Draggable 2D stem field with inspector, collision
 * warnings, auto-scatter / auto-mask, and spatial presets.
 *
 * Stereo only: x -> pan, z -> distance gain / lowpass / reverb send.
 */

import {
  MixerEngine,
  SPATIAL_PRESETS,
  autoMask,
  autoScatter,
  clampField,
  detectCollisions,
  makeStem,
  type Stem,
  type StemCategory,
} from '../audio/mixer.js';

const FIELD_W = 640;
const FIELD_H = 400;

const CATEGORY_COLORS: Record<StemCategory, string> = {
  bass: '#fb923c',
  drums: '#f85149',
  melody: '#7dd3fc',
  vocal: '#e8f6ff',
  fx: '#b392f0',
};

function toPx(x: number, y: number): { px: number; py: number } {
  return { px: ((x + 10) / 20) * FIELD_W, py: ((10 - y) / 20) * FIELD_H };
}
function toField(px: number, py: number): { x: number; y: number } {
  return { x: clampField((px / FIELD_W) * 20 - 10), y: clampField(10 - (py / FIELD_H) * 20) };
}

export function buildMixerView(
  container: HTMLElement,
  mixer: MixerEngine,
  initial: { name: string; category: StemCategory }[],
): { getStems: () => Stem[] } {
  let stems: Stem[] = initial.map((s) => makeStem(s.name, s.category, CATEGORY_COLORS[s.category]));
  let selected: string | null = stems[0]?.id ?? null;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <h2>SPATIAL MIXER</h2>
    <p class="sub">Stereo field: drag stems. X = pan, Z (depth slider) = distance —
    gain, lowpass and reverb send follow. Honest stereo; no surround processing.</p>
    <div class="row">
      <select data-k="preset"></select>
      <button data-k="scatter">Auto-scatter</button>
      <button data-k="mask">Auto-mask</button>
      <select data-k="addCat"></select>
      <button data-k="add">Add stem</button>
    </div>
    <div class="mixer-layout">
      <div>
        <canvas class="frame" data-k="field" width="${FIELD_W}" height="${FIELD_H}"></canvas>
        <div data-k="collisions"></div>
      </div>
      <div class="inspector" data-k="inspector"></div>
    </div>
  `;
  container.appendChild(wrap);
  const q = <T extends HTMLElement>(k: string): T => {
    const el = wrap.querySelector(`[data-k="${k}"]`);
    if (!el) throw new Error(`mixerview: missing [data-k="${k}"]`);
    return el as T;
  };

  const field = q<HTMLCanvasElement>('field');
  const rawCtx = field.getContext('2d');
  if (!rawCtx) throw new Error('2D canvas unavailable');
  const fctx: CanvasRenderingContext2D = rawCtx;

  // Register live nodes.
  for (const s of stems) mixer.addStem(s);

  const presetSel = q<HTMLSelectElement>('preset');
  for (const p of SPATIAL_PRESETS) {
    const o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name;
    presetSel.appendChild(o);
  }
  const addCat = q<HTMLSelectElement>('addCat');
  for (const c of Object.keys(CATEGORY_COLORS) as StemCategory[]) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    addCat.appendChild(o);
  }

  const refresh = () => {
    for (const s of stems) mixer.updateStem(s);
    drawField();
    drawCollisions();
    drawInspector();
  };

  presetSel.addEventListener('change', () => {
    const p = SPATIAL_PRESETS.find((x) => x.name === presetSel.value);
    if (!p) return;
    for (const s of stems) {
      const pos = p.positions[s.category];
      if (pos) s.position = { ...pos };
    }
    refresh();
  });
  q('scatter').addEventListener('click', () => {
    stems = autoScatter(stems);
    refresh();
  });
  q('mask').addEventListener('click', () => {
    stems = autoMask(stems);
    refresh();
  });
  q('add').addEventListener('click', () => {
    const cat = addCat.value as StemCategory;
    const s = makeStem(`${cat} ${stems.length + 1}`, cat, CATEGORY_COLORS[cat]);
    stems.push(s);
    mixer.addStem(s);
    selected = s.id;
    refresh();
  });

  // --- drag handling ---
  let dragId: string | null = null;
  const posOf = (e: PointerEvent) => {
    const r = field.getBoundingClientRect();
    return toField(
      ((e.clientX - r.left) / r.width) * FIELD_W,
      ((e.clientY - r.top) / r.height) * FIELD_H,
    );
  };
  field.addEventListener('pointerdown', (e) => {
    const { x, y } = posOf(e);
    let best: Stem | null = null;
    let bestD = 1.6;
    for (const s of stems) {
      const d = Math.hypot(s.position.x - x, s.position.y - y);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      dragId = best.id;
      selected = best.id;
      field.setPointerCapture(e.pointerId);
      refresh();
    }
  });
  field.addEventListener('pointermove', (e) => {
    if (!dragId) return;
    const s = stems.find((x) => x.id === dragId);
    if (!s) return;
    const { x, y } = posOf(e);
    s.position.x = x;
    s.position.y = y;
    mixer.updateStem(s);
    drawField();
    drawCollisions();
  });
  const endDrag = () => {
    dragId = null;
    drawCollisions();
    drawInspector();
  };
  field.addEventListener('pointerup', endDrag);
  field.addEventListener('pointercancel', endDrag);

  function drawField(): void {
    fctx.clearRect(0, 0, FIELD_W, FIELD_H);
    // Grid.
    fctx.strokeStyle = '#232b36';
    fctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const gx = (i / 10) * FIELD_W;
      const gy = (i / 10) * FIELD_H;
      fctx.beginPath(); fctx.moveTo(gx, 0); fctx.lineTo(gx, FIELD_H); fctx.stroke();
      fctx.beginPath(); fctx.moveTo(0, gy); fctx.lineTo(FIELD_W, gy); fctx.stroke();
    }
    fctx.fillStyle = '#8b949e';
    fctx.font = '10px monospace';
    fctx.fillText('L', 6, 14);
    fctx.fillText('R', FIELD_W - 14, 14);
    // Stems. Radius/alpha encode depth z (front = bigger).
    for (const s of stems) {
      const { px, py } = toPx(s.position.x, s.position.y);
      const depthT = (s.position.z + 10) / 20;
      const r = 16 - depthT * 7;
      fctx.globalAlpha = s.muted ? 0.3 : 1 - depthT * 0.35;
      fctx.beginPath();
      fctx.arc(px, py, r, 0, Math.PI * 2);
      fctx.fillStyle = s.color;
      fctx.fill();
      if (s.id === selected) {
        fctx.strokeStyle = '#7dd3fc';
        fctx.lineWidth = 2;
        fctx.stroke();
      }
      fctx.globalAlpha = 1;
      fctx.fillStyle = '#0d1117';
      fctx.font = '9px monospace';
      fctx.textAlign = 'center';
      fctx.fillText(s.name.slice(0, 8), px, py + 3);
      fctx.textAlign = 'left';
    }
  }

  function drawCollisions(): void {
    const box = q('collisions');
    box.innerHTML = '';
    const cols = detectCollisions(stems);
    if (cols.length === 0) {
      box.innerHTML = '<p class="note">No stem collisions — the field is clear.</p>';
      return;
    }
    for (const c of cols.slice(0, 6)) {
      const a = stems.find((s) => s.id === c.a);
      const b = stems.find((s) => s.id === c.b);
      const div = document.createElement('div');
      div.className = 'collision';
      div.innerHTML =
        `<b>${a?.name ?? c.a}</b> × <b>${b?.name ?? c.b}</b> — ${c.zone} ` +
        `(severity ${(c.severity * 100).toFixed(0)}%) ` +
        `<span class="sev" style="width:${(c.severity * 120).toFixed(0)}px"></span>`;
      box.appendChild(div);
    }
  }

  function sliderRow(label: string, min: number, max: number, step: number, value: number,
    onInput: (v: number) => void): HTMLElement {
    const div = document.createElement('div');
    div.innerHTML = `<label style="font-size:11px;color:#8b949e;font-family:monospace">${label} <b></b></label>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = `${min}`;
    input.max = `${max}`;
    input.step = `${step}`;
    input.value = `${value}`;
    input.style.width = '100%';
    input.style.accentColor = '#58a6ff';
    const val = div.querySelector('b') as HTMLElement;
    val.textContent = `${value}`;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = `${v}`;
      onInput(v);
    });
    div.appendChild(input);
    return div;
  }

  function drawInspector(): void {
    const box = q('inspector');
    box.innerHTML = '';
    const s = stems.find((x) => x.id === selected);
    const title = document.createElement('h3');
    title.textContent = s ? `Inspector — ${s.name}` : 'Inspector';
    box.appendChild(title);
    if (!s) {
      box.appendChild(document.createTextNode('Select a stem in the field.'));
      return;
    }
    box.appendChild(sliderRow('X (pan)', -10, 10, 0.5, s.position.x, (v) => {
      s.position.x = v; mixer.updateStem(s); drawField();
    }));
    box.appendChild(sliderRow('Y (height)', -10, 10, 0.5, s.position.y, (v) => {
      s.position.y = v; mixer.updateStem(s); drawField();
    }));
    box.appendChild(sliderRow('Z (depth)', -10, 10, 0.5, s.position.z, (v) => {
      s.position.z = v; mixer.updateStem(s); drawField(); drawCollisions();
    }));
    box.appendChild(sliderRow('EQ low dB', -12, 12, 0.5, s.eq.low, (v) => {
      s.eq.low = v; mixer.updateStem(s);
    }));
    box.appendChild(sliderRow('EQ mid dB', -12, 12, 0.5, s.eq.mid, (v) => {
      s.eq.mid = v; mixer.updateStem(s);
    }));
    box.appendChild(sliderRow('EQ high dB', -12, 12, 0.5, s.eq.high, (v) => {
      s.eq.high = v; mixer.updateStem(s);
    }));
    const row = document.createElement('div');
    row.className = 'row';
    const mute = document.createElement('button');
    mute.textContent = s.muted ? 'Unmute' : 'Mute';
    mute.addEventListener('click', () => { s.muted = !s.muted; refresh(); });
    const solo = document.createElement('button');
    solo.textContent = s.solo ? 'Unsolo' : 'Solo';
    solo.addEventListener('click', () => { s.solo = !s.solo; refresh(); });
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      mixer.removeStem(s.id);
      stems = stems.filter((x) => x.id !== s.id);
      selected = stems[0]?.id ?? null;
      refresh();
    });
    row.append(mute, solo, remove);
    box.appendChild(row);
    const tags = document.createElement('div');
    tags.innerHTML =
      `<span class="stem-tag">${s.category}</span> ` +
      `<span class="stem-tag">priority ${s.priority}</span>`;
    box.appendChild(tags);
  }

  // Apply the default preset positions, then paint.
  presetSel.value = SPATIAL_PRESETS[0].name;
  presetSel.dispatchEvent(new Event('change'));
  refresh();
  return { getStems: () => stems };
}
