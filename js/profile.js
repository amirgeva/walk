// Elevation profile chart on a <canvas>, coloured by grade, with hover read-out.
import { GRADE_CLASSES } from './difficulty.js';

function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

export class ProfileChart {
  constructor(canvas, tip, onHover) {
    this.canvas = canvas;
    this.tip = tip;
    this.onHover = onHover;
    this.a = null;
    this.hi = null;
    this.pad = { l: 46, r: 14, t: 12, b: 24 };
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointermove', (ev) => this._move(ev));
    canvas.addEventListener('pointerleave', () => { this.setHighlight(null); this.onHover?.(null); });
  }

  setData(analysis) { this.a = analysis; this.hi = null; this.draw(); }

  setHighlight(i) { this.hi = i; this.draw(); }

  _geom() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, { l, r, t, b } = this.pad;
    const { d, elev } = this.a;
    let lo = Math.min(...elev), hi = Math.max(...elev);
    const minSpan = 30; // don't make a flat walk look like the Alps
    if (hi - lo < minSpan) { const m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
    const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
    const total = d[d.length - 1];
    return {
      w, h, lo, hi, total,
      X: (v) => l + (v / total) * (w - l - r),
      Y: (v) => t + (1 - (v - lo) / (hi - lo)) * (h - t - b),
      x2d: (x) => ((x - l) / (w - l - r)) * total,
    };
  }

  _move(ev) {
    if (!this.a) return;
    const rect = this.canvas.getBoundingClientRect();
    const dist = this._geom().x2d(ev.clientX - rect.left);
    const { d } = this.a;
    let lo = 0, hi = d.length - 1; // binary search for nearest sample
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m] < dist) lo = m; else hi = m; }
    const i = Math.abs(d[lo] - dist) < Math.abs(d[hi] - dist) ? lo : hi;
    this.setHighlight(i);
    this.onHover?.(i);
  }

  draw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.a) { this.tip.hidden = true; return; }

    const css = getComputedStyle(c);
    const fg = css.getPropertyValue('--fg-muted').trim() || '#666';
    const grid = css.getPropertyValue('--grid').trim() || '#e5e7eb';
    const line = css.getPropertyValue('--fg').trim() || '#222';
    const { d, elev, segClass } = this.a;
    const g = this._geom(), { X, Y } = g, { l, r, t, b } = this.pad;
    const n = d.length;

    // grid + labels
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = fg; ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ys = niceStep(g.hi - g.lo, 4);
    for (let v = Math.ceil(g.lo / ys) * ys; v <= g.hi; v += ys) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(w - r, y); ctx.stroke();
      ctx.fillText(`${Math.round(v)} m`, l - 6, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const km = g.total / 1000, xs = niceStep(km, Math.max(2, Math.floor((w - l - r) / 80)));
    for (let v = 0; v <= km + 1e-9; v += xs) {
      ctx.fillText(xs < 1 ? `${+v.toFixed(2)} km` : `${+v.toFixed(1)} km`, X(v * 1000), h - b + 6);
    }

    // area fill, one path per run of the same grade class
    const base = Y(g.lo);
    for (let i = 0; i < n - 1;) {
      const cls = segClass[i];
      let j = i;
      while (j < n - 1 && segClass[j] === cls) j++;
      ctx.beginPath();
      ctx.moveTo(X(d[i]), base);
      for (let k = i; k <= j; k++) ctx.lineTo(X(d[k]), Y(elev[k]));
      ctx.lineTo(X(d[j]), base);
      ctx.closePath();
      ctx.fillStyle = GRADE_CLASSES[cls].color + 'b0';
      ctx.fill();
      i = j;
    }
    ctx.beginPath();
    for (let k = 0; k < n; k++) ctx[k ? 'lineTo' : 'moveTo'](X(d[k]), Y(elev[k]));
    ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.stroke();

    // hover
    if (this.hi != null) {
      const i = this.hi, x = X(d[i]), y = Y(elev[i]);
      ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, h - b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, 7); ctx.fill();
      ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.stroke();
      const grade = this.a.segGrade[Math.min(i, n - 2)];
      this.tip.hidden = false;
      this.tip.textContent = `${(d[i] / 1000).toFixed(2)} km · ${Math.round(elev[i])} m · ${grade >= 0 ? '+' : ''}${grade.toFixed(1)}%`;
      const tw = this.tip.offsetWidth;
      this.tip.style.left = `${Math.min(w - tw - 4, Math.max(4, x - tw / 2))}px`;
    } else {
      this.tip.hidden = true;
    }
  }
}
