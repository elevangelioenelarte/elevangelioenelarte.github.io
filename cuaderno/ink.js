// Motor de tinta: dibujo con Apple Pencil (presión, rechazo de palma) sobre canvas.
// Los trazos se guardan en unidades de página (ancho 1000, alto 1414) para que sean independientes del tamaño.
export const PAGE_W = 1000;
export const PAGE_H = 1414;

const darkMQ = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };
const DARK_INK = { '#1f1b14': '#ece5d6', '#1d4ed8': '#7aa2ff', '#b91c1c': '#f87171', '#15803d': '#4ade80', '#b45309': '#fbbf24' };
export function displayColor(color) { return darkMQ.matches ? (DARK_INK[color] || color) : color; }

function widthFor(stroke, p) {
  if (stroke.tool === 'highlighter') return stroke.width * 7;
  const pr = typeof p === 'number' && p > 0 ? p : 0.5;
  return stroke.width * (0.55 + pr * 0.9);
}

export function drawStroke(ctx, stroke, scale) {
  const pts = stroke.points;
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = displayColor(stroke.color);
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = darkMQ.matches ? 0.5 : 0.32;
    ctx.globalCompositeOperation = darkMQ.matches ? 'screen' : 'multiply';
    ctx.lineCap = 'butt';
  }
  if (pts.length === 1) {
    const [x, y, p] = pts[0];
    ctx.beginPath();
    ctx.fillStyle = displayColor(stroke.color);
    ctx.arc(x * scale, y * scale, (widthFor(stroke, p) * scale) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  for (let i = 1; i < pts.length; i++) drawSegment(ctx, stroke, i, scale);
  ctx.restore();
}

// Dibuja el tramo que termina en el punto i (curva suave por puntos medios)
function drawSegment(ctx, stroke, i, scale) {
  const pts = stroke.points;
  const p0 = pts[i - 1], p1 = pts[i];
  const prev = pts[i - 2] || p0;
  const next = pts[i + 1] || p1;
  const m0 = [(prev[0] + p0[0]) / 2, (prev[1] + p0[1]) / 2];
  const m1 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  ctx.lineWidth = Math.max(0.6, widthFor(stroke, p1[2]) * scale);
  ctx.beginPath();
  if (i === 1) { ctx.moveTo(p0[0] * scale, p0[1] * scale); ctx.lineTo(m1[0] * scale, m1[1] * scale); }
  else { ctx.moveTo(m0[0] * scale, m0[1] * scale); ctx.quadraticCurveTo(p0[0] * scale, p0[1] * scale, m1[0] * scale, m1[1] * scale); }
  if (i === pts.length - 1) { ctx.moveTo(m1[0] * scale, m1[1] * scale); ctx.lineTo(p1[0] * scale, p1[1] * scale); }
  ctx.stroke();
}

export function renderStrokes(ctx, strokes, scale) {
  for (const s of strokes) drawStroke(ctx, s, scale);
}

export class InkCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { getStrokes(), getTool() -> {tool,color,width}, pencilOnly(), onStrokeAdded(stroke), onStrokesRemoved([{index, stroke}]) }
   */
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.active = null; // trazo en curso
    this.activeId = null;
    this.erased = null;
    this.bind();
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this._scheme = () => this.render();
    darkMQ.addEventListener && darkMQ.addEventListener('change', this._scheme);
  }

  destroy() { this.ro.disconnect(); darkMQ.removeEventListener && darkMQ.removeEventListener('change', this._scheme); }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.dpr = dpr;
    this.scale = rect.width / PAGE_W;
    this.render();
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    renderStrokes(ctx, this.opts.getStrokes(), this.scale);
    if (this.active) drawStroke(ctx, this.active, this.scale);
  }

  toPagePoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.scale;
    const y = (e.clientY - rect.top) / this.scale;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round((e.pressure || 0) * 100) / 100];
  }

  accepts(e) {
    if (e.pointerType === 'touch' && this.opts.pencilOnly()) return false;
    return true;
  }

  bind() {
    const c = this.canvas;
    c.style.webkitTouchCallout = 'none';
    // Evita el desplazamiento cuando el lápiz toca el papel (Safari expone touchType).
    const touchGuard = (e) => {
      const pencilOnly = this.opts.pencilOnly();
      for (const t of e.touches) {
        if (!pencilOnly || t.touchType === 'stylus') { e.preventDefault(); return; }
      }
    };
    c.addEventListener('touchstart', touchGuard, { passive: false });
    c.addEventListener('touchmove', touchGuard, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      if (!this.accepts(e)) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const tool = this.opts.getTool();
      if (tool.tool === 'text') return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.activeId = e.pointerId;
      const pt = this.toPagePoint(e);
      if (tool.tool === 'eraser') {
        this.erased = [];
        this.eraseAt(pt);
        return;
      }
      this.active = { tool: tool.tool, color: tool.color, width: tool.width, points: [pt] };
      this.render();
    });

    c.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.activeId) return;
      e.preventDefault();
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (this.erased) { for (const ev of events) this.eraseAt(this.toPagePoint(ev)); return; }
      if (!this.active) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = displayColor(this.active.color);
      if (this.active.tool === 'highlighter') { ctx.globalAlpha = darkMQ.matches ? 0.5 : 0.32; ctx.globalCompositeOperation = darkMQ.matches ? 'screen' : 'multiply'; ctx.lineCap = 'butt'; }
      for (const ev of events) {
        const pt = this.toPagePoint(ev);
        const last = this.active.points[this.active.points.length - 1];
        if (Math.abs(pt[0] - last[0]) < 0.8 && Math.abs(pt[1] - last[1]) < 0.8) continue;
        this.active.points.push(pt);
        drawSegment(ctx, this.active, this.active.points.length - 1, this.scale);
      }
      ctx.restore();
    });

    const finish = (e) => {
      if (e.pointerId !== this.activeId) return;
      this.activeId = null;
      try { c.releasePointerCapture(e.pointerId); } catch {}
      if (this.erased) {
        const removed = this.erased; this.erased = null;
        if (removed.length) this.opts.onStrokesRemoved(removed);
        return;
      }
      if (!this.active) return;
      const stroke = this.active; this.active = null;
      // Simplificación ligera para no guardar puntos redundantes
      stroke.points = simplify(stroke.points, 0.35);
      this.opts.onStrokeAdded(stroke);
      this.render();
    };
    c.addEventListener('pointerup', finish);
    c.addEventListener('pointercancel', finish);
    c.addEventListener('lostpointercapture', (e) => { if (e.pointerId === this.activeId) finish(e); });
  }

  eraseAt(pt) {
    const strokes = this.opts.getStrokes();
    const R = 14; // radio en unidades de página
    let changed = false;
    for (let i = strokes.length - 1; i >= 0; i--) {
      const s = strokes[i];
      if (hits(s, pt, R + (s.tool === 'highlighter' ? s.width * 3 : s.width))) {
        this.erased.push({ index: i, stroke: s });
        strokes.splice(i, 1);
        changed = true;
      }
    }
    if (changed) this.render();
  }
}

function hits(stroke, pt, r) {
  const pts = stroke.points;
  const r2 = r * r;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - pt[0], dy = pts[i][1] - pt[1];
    if (dx * dx + dy * dy <= r2) return true;
    if (i > 0) {
      // distancia al segmento
      const ax = pts[i - 1][0], ay = pts[i - 1][1], bx = pts[i][0], by = pts[i][1];
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy || 1;
      let t = ((pt[0] - ax) * vx + (pt[1] - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * vx - pt[0], py = ay + t * vy - pt[1];
      if (px * px + py * py <= r2) return true;
    }
  }
  return false;
}

// Ramer–Douglas–Peucker ligero conservando presión
function simplify(points, eps) {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const ax = points[a][0], ay = points[a][1], bx = points[b][0], by = points[b][1];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = true; stack.push([a, idx], [idx, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Renderiza los trazos a PNG (base64 sin prefijo), recortando al contenido. Devuelve null si no hay tinta. */
export function strokesToPNG(strokes, { maxSide = 1568 } = {}) {
  const inks = strokes.filter(s => s.tool !== 'highlighter');
  if (!inks.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of inks) for (const [x, y] of s.points) {
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  const pad = 30;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(PAGE_W, maxX + pad); maxY = Math.min(PAGE_H, maxY + pad);
  const w = Math.max(200, maxX - minX), h = Math.max(120, maxY - minY);
  const scale = Math.min(maxSide / Math.max(w, h), 2.2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(-minX * scale, -minY * scale);
  // La tinta de color se pasa a negro para que la lectura sea más limpia
  renderStrokes(ctx, inks.map(s => ({ ...s, color: '#111', width: Math.max(s.width, 2) })), scale);
  return canvas.toDataURL('image/png').split(',')[1];
}
