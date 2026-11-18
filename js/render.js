// Draws one frame of sky onto a 2D canvas and reports where things landed so
// taps can be matched to objects.

import { mul3, starTitle } from './sky.js';

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const NEAR = 0.05; // cos-ish cut-off for "in front of the camera"

const UI_FONT = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
const DISPLAY_FONT = 'Marcellus, "Iowan Old Style", "Palatino Linotype", Georgia, serif';

const COLOR = {
  backdrop: '#070b1a',
  scrim: 'rgba(7, 11, 26, 0.38)',
  ground: 'rgba(16, 22, 44, 0.72)',
  groundOverCamera: 'rgba(7, 11, 26, 0.25)',
  horizon: 'rgba(229, 181, 103, 0.75)',
  line: 'rgba(146, 164, 255, 0.5)',
  lineStrong: 'rgba(229, 181, 103, 0.95)',
  starLabel: '#e8ecff',
  conLabel: '#e5b567',
  brass: '#e5b567',
  halo: 'rgba(4, 7, 18, 0.78)',
};

// Colour index (B-V) to a tint: hot blue-white through to cool orange.
const STAR_TINTS = [
  [-0.05, '#a9c0ff'], [0.2, '#cbd8ff'], [0.5, '#f4f5ff'], [0.85, '#fff3df'], [1.25, '#ffd9a8'], [Infinity, '#ffbe85'],
];
const starTint = (bv) => STAR_TINTS.find(([max]) => bv <= max)[1];

const BODY_STYLE = {
  Sun: { color: '#ffd98a', radius: 13 },
  Moon: { color: '#ece8da', radius: 10 },
  Mercury: { color: '#cdbba2' },
  Venus: { color: '#fff3c9' },
  Mars: { color: '#ff9a6a' },
  Jupiter: { color: '#f4dab2' },
  Saturn: { color: '#ecd28c' },
  Uranus: { color: '#a9e7e1' },
  Neptune: { color: '#93a9ff' },
};

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const starRadius = (mag) => 1 + 0.6 * Math.max(0, 5.2 - mag) ** 0.92;
const starAlpha = (mag) => Math.max(0.62, Math.min(1, 1.2 - 0.12 * mag));
const bodyRadius = (b) => BODY_STYLE[b.name].radius || Math.max(2.6, starRadius(Math.max(b.mag, -1.5)) * 0.95);

/**
 * @param ctx  2D context already scaled so one unit is one CSS pixel
 * @param v    { w, h, f, cam, sky, catalog, bodies, limitMag, overCamera,
 *               showLines, showNames, selected, target }
 *             `selected` / `target`: { kind: 'star'|'body'|'constellation', index }
 * @returns    { hits, targetInfo } - hits are tappable objects in screen space
 */
export function drawSky(ctx, v) {
  const { w, h, f, cam, catalog } = v;
  const cx = w / 2, cy = h / 2;
  const m = mul3(cam, v.sky); // EQJ -> camera
  const hits = [];
  const labels = [];

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = v.overCamera ? COLOR.scrim : COLOR.backdrop;
  ctx.fillRect(0, 0, w, h);

  // Everything further off-axis than the screen corner can be skipped early.
  const minZ = Math.max(NEAR, 0.94 / Math.sqrt(1 + (cx * cx + cy * cy) / (f * f)));
  const margin = 24;
  const onScreen = (x, y) => x > -margin && x < w + margin && y > -margin && y < h + margin;

  let px = 0, py = 0, pz = 0;
  const project = (x, y, z) => {
    pz = m[6] * x + m[7] * y + m[8] * z;
    if (pz < minZ) return false;
    px = cx + (f * (m[0] * x + m[1] * y + m[2] * z)) / pz;
    py = cy - (f * (m[3] * x + m[4] * y + m[5] * z)) / pz;
    return true;
  };

  drawGround(ctx, v, cx, cy);

  // --- constellation figures -------------------------------------------
  const targetCon = v.target && v.target.kind === 'constellation' ? v.target.index : -1;
  if (v.showLines || targetCon >= 0) {
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLOR.line;
    ctx.beginPath();
    catalog.constellations.forEach((con, ci) => {
      if (ci === targetCon || !v.showLines) return;
      for (const pts of con.lines) tracePolyline(ctx, pts, m, f, cx, cy);
    });
    ctx.stroke();
    if (targetCon >= 0) {
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = COLOR.lineStrong;
      ctx.beginPath();
      for (const pts of catalog.constellations[targetCon].lines) tracePolyline(ctx, pts, m, f, cx, cy);
      ctx.stroke();
    }
  }

  // --- stars --------------------------------------------------------------
  const nameLimit = v.limitMag - 2.6;
  const vec = catalog.vec;
  for (let i = 0; i < catalog.n; i++) {
    const mag = catalog.mag[i];
    if (mag > v.limitMag) break; // sorted brightest first
    if (!project(vec[i * 3], vec[i * 3 + 1], vec[i * 3 + 2]) || !onScreen(px, py)) continue;
    const r = starRadius(mag);
    ctx.fillStyle = starTint(catalog.bv[i]);
    if (mag < 1.6) {
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      ctx.arc(px, py, r * 2.5, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = starAlpha(mag);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
    hits.push({ kind: 'star', index: i, x: px, y: py, r });
    if (v.showNames && catalog.proper[i] && mag < nameLimit) {
      labels.push({ text: catalog.proper[i], x: px + r + 5, y: py, priority: mag < 1.5 ? 1 : 3 + mag, style: 'star' });
    }
  }
  ctx.globalAlpha = 1;

  // --- constellation names ------------------------------------------------
  if (v.showNames) {
    catalog.constellations.forEach((con, ci) => {
      if (!project(con.label[0], con.label[1], con.label[2]) || !onScreen(px, py)) return;
      labels.push({ text: con.name.toUpperCase(), x: px, y: py, priority: ci === targetCon ? 0 : 2, style: 'constellation' });
    });
  }

  // --- Sun, Moon, planets ---------------------------------------------------
  v.bodies.forEach((b, bi) => {
    if (!project(b.vec[0], b.vec[1], b.vec[2]) || !onScreen(px, py)) return;
    const style = BODY_STYLE[b.name];
    const r = bodyRadius(b);
    if (b.name === 'Sun') {
      const glow = ctx.createRadialGradient(px, py, r * 0.6, px, py, r * 3);
      glow.addColorStop(0, 'rgba(255, 217, 138, 0.55)');
      glow.addColorStop(1, 'rgba(255, 217, 138, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(px, py, r * 3, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = style.color;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fill();
    if (b.kind === 'Planet') {
      // A thin ring sets planets apart from stars of the same brightness.
      ctx.strokeStyle = style.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(px, py, r + 3.5, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    hits.push({ kind: 'body', index: bi, x: px, y: py, r: r + 4 });
    labels.push({ text: b.name, x: px + r + 8, y: py, priority: 0, style: 'body' });
  });

  drawCardinals(ctx, v, cx, cy, onScreen);

  // --- selection and guidance ----------------------------------------------
  const directionOf = (ref) => {
    if (!ref) return null;
    if (ref.kind === 'star') return [vec[ref.index * 3], vec[ref.index * 3 + 1], vec[ref.index * 3 + 2]];
    if (ref.kind === 'body') return v.bodies[ref.index] ? v.bodies[ref.index].vec : null;
    return catalog.constellations[ref.index].label;
  };
  const nameOf = (ref) => {
    if (ref.kind === 'star') return starTitle(catalog, ref.index);
    if (ref.kind === 'body') return v.bodies[ref.index].name;
    return catalog.constellations[ref.index].name;
  };

  const sel = directionOf(v.selected);
  if (sel && project(sel[0], sel[1], sel[2]) && onScreen(px, py)) {
    drawMarker(ctx, px, py, 15);
    if (v.selected.kind !== 'constellation') {
      labels.push({ text: nameOf(v.selected), x: px + 21, y: py, priority: -1, style: v.selected.kind });
    }
  }

  let targetInfo = null;
  const tgt = directionOf(v.target);
  if (tgt) {
    const tx = m[0] * tgt[0] + m[1] * tgt[1] + m[2] * tgt[2];
    const ty = m[3] * tgt[0] + m[4] * tgt[1] + m[5] * tgt[2];
    const tz = m[6] * tgt[0] + m[7] * tgt[1] + m[8] * tgt[2];
    const away = Math.acos(Math.max(-1, Math.min(1, tz))) / RAD;
    const sx = cx + (f * tx) / tz, sy = cy - (f * ty) / tz;
    // "In view" means clear of the bars at the top and bottom of the screen.
    const inView = tz > NEAR && sx > 28 && sx < w - 28 && sy > 96 && sy < h - 150;
    targetInfo = { away, inView };
    if (inView) {
      // A constellation is marked by its highlighted figure and name instead of a ring.
      if (v.target.kind !== 'constellation') {
        drawMarker(ctx, sx, sy, 22, true);
        labels.push({ text: nameOf(v.target), x: sx + 28, y: sy, priority: -2, style: v.target.kind });
      }
    } else {
      drawGuideArrow(ctx, tx, ty, away, cx, cy, w, h);
    }
  }

  drawLabels(ctx, labels, w, h);
  drawReticle(ctx, cx, cy);
  return { hits, targetInfo };
}

/** Adds a great-circle polyline to the current path, clipped to what is in front of the camera. */
function tracePolyline(ctx, pts, m, f, cx, cy) {
  let prev = null;
  for (let k = 0; k < pts.length; k += 3) {
    const x = pts[k], y = pts[k + 1], z = pts[k + 2];
    const cur = [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
    if (prev && (prev[2] > NEAR || cur[2] > NEAR)) {
      let a = prev, b = cur;
      if (a[2] < NEAR) a = clipToNear(a, b);
      else if (b[2] < NEAR) b = clipToNear(b, a);
      ctx.moveTo(cx + (f * a[0]) / a[2], cy - (f * a[1]) / a[2]);
      ctx.lineTo(cx + (f * b[0]) / b[2], cy - (f * b[1]) / b[2]);
    }
    prev = cur;
  }
}

function clipToNear(behind, front) {
  const t = (NEAR - behind[2]) / (front[2] - behind[2]);
  return [behind[0] + t * (front[0] - behind[0]), behind[1] + t * (front[1] - behind[1]), NEAR];
}

/**
 * In a perspective view the horizon is a straight line, so the ground is the
 * part of the screen rectangle on one side of it.
 */
function drawGround(ctx, v, cx, cy) {
  const { w, h, f, cam } = v;
  // "Up" as the camera sees it; altitude sign at a pixel is linear in x and y.
  const nx = cam[2], ny = cam[5], nz = cam[8];
  const height = (x, y) => (nx * (x - cx)) / f - (ny * (y - cy)) / f + nz;
  const corners = [[0, 0], [w, 0], [w, h], [0, h]];
  const poly = [];
  const crossings = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const ha = height(a[0], a[1]), hb = height(b[0], b[1]);
    if (ha < 0) poly.push(a);
    if (ha < 0 !== hb < 0) {
      const t = ha / (ha - hb);
      const p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      poly.push(p);
      crossings.push(p);
    }
  }
  if (poly.length >= 3) {
    ctx.fillStyle = v.overCamera ? COLOR.groundOverCamera : COLOR.ground;
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  }
  if (crossings.length === 2) {
    ctx.strokeStyle = COLOR.horizon;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(crossings[0][0], crossings[0][1]);
    ctx.lineTo(crossings[1][0], crossings[1][1]);
    ctx.stroke();
  }
}

/** Compass ticks every 15 degrees along the horizon, lettered every 45. */
function drawCardinals(ctx, v, cx, cy, onScreen) {
  const { f, cam } = v;
  // Screen direction pointing from the horizon down into the ground.
  const gl = Math.hypot(cam[2], cam[5]) || 1;
  const gx = -cam[2] / gl, gy = cam[5] / gl;
  ctx.strokeStyle = COLOR.horizon;
  ctx.lineWidth = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let az = 0; az < 360; az += 15) {
    const e = Math.sin(az * RAD), n = Math.cos(az * RAD);
    const z = cam[6] * e + cam[7] * n;
    if (z < NEAR) continue;
    const x = cx + (f * (cam[0] * e + cam[1] * n)) / z;
    const y = cy - (f * (cam[3] * e + cam[4] * n)) / z;
    if (!onScreen(x, y)) continue;
    const lettered = az % 45 === 0;
    const len = lettered ? 9 : 5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + gx * len, y + gy * len);
    ctx.stroke();
    if (!lettered) continue;
    const major = az % 90 === 0;
    ctx.font = `${major ? 15 : 11}px ${DISPLAY_FONT}`;
    haloText(ctx, CARDINALS[az / 45], x + gx * 22, y + gy * 22, COLOR.brass, major ? 1 : 0.8);
  }
}

function drawMarker(ctx, x, y, r, strong = false) {
  ctx.strokeStyle = COLOR.brass;
  ctx.lineWidth = strong ? 1.8 : 1.3;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  // Four ticks, like the bezel of a finder scope.
  for (let k = 0; k < 4; k++) {
    const c = Math.cos((k * Math.PI) / 2), s = Math.sin((k * Math.PI) / 2);
    ctx.moveTo(x + c * (r + 2), y + s * (r + 2));
    ctx.lineTo(x + c * (r + 7), y + s * (r + 7));
  }
  ctx.stroke();
}

function drawReticle(ctx, cx, cy) {
  ctx.strokeStyle = COLOR.brass;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const c = Math.cos((k * Math.PI) / 2), s = Math.sin((k * Math.PI) / 2);
    ctx.moveTo(cx + c * 7, cy + s * 7);
    ctx.lineTo(cx + c * 15, cy + s * 15);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Arrow on the rim of the view showing which way to turn towards the target. */
function drawGuideArrow(ctx, tx, ty, away, cx, cy, w, h) {
  let dx = tx, dy = -ty;
  const len = Math.hypot(dx, dy);
  if (len < 1e-4) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
  const rx = Math.max(40, cx - 46), ry = Math.max(40, cy - 150);
  // Point where the direction meets an ellipse inset from the screen edge.
  const k = 1 / Math.hypot(dx / rx, dy / ry);
  const x = cx + dx * k, y = cy + dy * k;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.fillStyle = COLOR.brass;
  ctx.strokeStyle = COLOR.halo;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(18, 0);
  ctx.lineTo(-10, -12);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-10, 12);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
  ctx.restore();
  ctx.font = `600 13px ${UI_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  haloText(ctx, `${Math.round(away)}°`, x - dx * 34, y - dy * 34, COLOR.brass, 1);
}

function haloText(ctx, text, x, y, color, alpha) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLOR.halo;
  ctx.strokeText(text, x, y);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.globalAlpha = 1;
}

const LABEL_STYLE = {
  star: { font: `13px ${UI_FONT}`, color: COLOR.starLabel, alpha: 0.92, align: 'left', spacing: '0px' },
  body: { font: `600 14px ${UI_FONT}`, color: '#ffffff', alpha: 1, align: 'left', spacing: '0px' },
  constellation: { font: `11px ${DISPLAY_FONT}`, color: COLOR.conLabel, alpha: 0.85, align: 'center', spacing: '2.5px' },
};

/** Places labels most-important first and drops any that would overlap one already placed. */
function drawLabels(ctx, labels, w, h) {
  labels.sort((a, b) => a.priority - b.priority);
  const placed = [];
  const seen = new Set();
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    if (seen.has(l.text)) continue; // a selected object is already labelled
    const style = LABEL_STYLE[l.style];
    ctx.font = style.font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = style.spacing;
    const width = ctx.measureText(l.text).width;
    const left = style.align === 'center' ? l.x - width / 2 : l.x;
    const box = [left - 3, l.y - 9, left + width + 3, l.y + 9];
    if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h) continue;
    if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
    placed.push(box);
    seen.add(l.text);
    ctx.textAlign = 'left';
    haloText(ctx, l.text, left, l.y, style.color, style.alpha);
  }
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/** The object nearest a tap, favouring planets and brighter stars; null if none is close. */
export function pick(hits, x, y, radius = 30) {
  let best = null;
  let bestScore = Infinity;
  for (const hit of hits) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    if (d > radius + hit.r) continue;
    // Bigger (brighter) dots win ties against faint neighbours.
    const score = d - hit.r * 2.5 - (hit.kind === 'body' ? 10 : 0);
    if (score < bestScore) { bestScore = score; best = hit; }
  }
  return best;
}
