// The film's timeline. frameState(t) and drawUI(ctx, t) are pure functions of
// t: no state survives between frames, so seek, scrub and export are exact.

import { buildLayout, CENTER, CORE_R, COLORS, MARK } from './shapes.js';
import { defaultCam, project } from './camera.js';

export const DURATION = 82;
export const CHAPTERS = [
  { name: 'Cold open', t0: 0, t1: 11 },
  { name: 'The stakes', t0: 11, t1: 21 },
  { name: 'The turn', t0: 21, t1: 33 },
  { name: 'The receipt', t0: 33, t1: 50 },
  { name: 'The stop', t0: 50, t1: 64 },
  { name: 'Program scope', t0: 64, t1: 72 },
  { name: 'Truenote', t0: 72, t1: DURATION },
];

// ---------------------------------------------------------------- copy
export const COPY = {
  caller: "What's the fee if I cancel my Basic plan?",
  q1: 'What is the cancellation fee for the Basic plan?',
  a1: 'The standard cancellation fee for the Basic plan is **$5** [1]',
  doc1: 'Cancellation Policy v1',
  doc2: 'Refund Procedure v1',
  q2: 'What is the reinstatement fee for the Premium plan?',
  tagline: 'A cited answer, or a clear no.',
  url: 'truenote.org',
};

export const STATEMENTS = [
  { text: 'The answer is in here. Somewhere.', accent: [5], t0: 6.2, t1: 10.7, x: 960, y: 866, align: 'center', theme: 'dark' },
  { text: 'A guess sounds exactly like an answer.', accent: [3], t0: 15.8, t1: 20.6, x: 960, y: 870, align: 'center', theme: 'dark' },
  { text: 'Only your approved documents can support an answer.', accent: [2], t0: 29.0, t1: 33.6, x: 110, y: 520, align: 'left', maxWidth: 720, theme: 'light' },
  { text: 'Every answer shows its receipt.', accent: [4], t0: 46.0, t1: 50.0, x: 96, y: 950, align: 'left', maxWidth: 1300, theme: 'light' },
  { text: 'When the documents stop, Truenote stops.', accent: [5], t0: 58.4, t1: 63.0, x: 96, y: 950, align: 'left', maxWidth: 1300, theme: 'light' },
  { text: "A rep's search never reaches another program.", accent: [3], t0: 67.8, t1: 72.1, x: 960, y: 1000, align: 'center', maxWidth: 1700, theme: 'light' },
];

export function captions() {
  return STATEMENTS.map((s) => ({ text: s.text, t0: s.t0, t1: s.t1 }));
}

// ---------------------------------------------------------------- math
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (u) => { u = clamp(u); return u * u * (3 - 2 * u); };
const ramp = (t, a, b) => smooth((t - a) / (b - a));
const easeOutCubic = (u) => 1 - Math.pow(1 - clamp(u), 3);
const easeOutQuart = (u) => 1 - Math.pow(1 - clamp(u), 4);
const easeInOutCubic = (u) => { u = clamp(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
const easeInOutSine = (u) => -(Math.cos(Math.PI * clamp(u)) - 1) / 2;
const backOut = (u, c1 = 0.9) => { u = clamp(u); const c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };
const TAU = Math.PI * 2;
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const pulse = (t, a, b) => { const u = (t - a) / (b - a); return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u); };

// ---------------------------------------------------------------- layout
export const L = buildLayout();
const N = L.n;
export const STRIDE = 16;
const tiles = new Float32Array(N * STRIDE);
const [R0, R1, R2, R3, R4] = L.R;
const HERO = L.hero.tile;
const shortRank = new Int8Array(N).fill(-1);
L.shortlist.forEach((i, k) => { shortRank[i] = k; });
const exactRank = new Int8Array(N).fill(-1);
L.exact.forEach((i, k) => { exactRank[i] = k; });

// ---------------------------------------------------------------- camera
// Keys: t, eye, target, fov. Segments ease in-out between consecutive keys.
const CAM_KEYS = [
  { t: 0, e: [930, 1560, 250], g: [960, 640, 210], fov: 38 },
  { t: 9.5, e: [1080, 1950, 1250], g: [960, 560, 120], fov: 34 },
  { t: 21.0, e: [1020, 1880, 1180], g: [960, 590, 130], fov: 33 },
  { t: 23.6, e: [980, 1900, 860], g: [960, 610, 150], fov: 32 },
  { t: 29.6, e: [760, 810, 2015], g: [760, 540, 0], fov: 30 },
  { t: 34, e: [720, 790, 1990], g: [720, 540, 0], fov: 30 },
  { t: 43.6, e: [700, 760, 1960], g: [700, 540, 0], fov: 30 },
  { t: 44.6, e: [700, 540, 1830], g: [700, 540, 0], fov: 30 },
  { t: 49.4, e: [700, 540, 1810], g: [700, 540, 0], fov: 30 },
  { t: 51.0, e: [720, 790, 1990], g: [720, 540, 0], fov: 30 },
  { t: 63.4, e: [730, 800, 2000], g: [730, 540, 0], fov: 30 },
  { t: 66.6, e: [960, 1420, 2480], g: [960, 560, 0], fov: 30 },
  { t: 72.2, e: [930, 1380, 2420], g: [960, 560, 0], fov: 30 },
  { t: 75.6, e: [1330, 540, 2330], g: [1330, 540, 0], fov: 30 },
  { t: DURATION, e: [1330, 540, 2240], g: [1330, 540, 0], fov: 30 },
];

// prefers-reduced-motion: no camera travel, no vortex spin, no handheld
// breath. The camera holds one pose per act and changes only under a short
// dissolve through ink; every caption and state change stays.
let REDUCED = false;
export function setReducedMotion(on) { REDUCED = !!on; }
const REDUCED_CUTS = [24.8, 63.4, 72.8];
const REDUCED_POSES = [
  { e: [1080, 1950, 1250], g: [960, 560, 120], fov: 34 },
  { e: [720, 540, 1900], g: [720, 540, 0], fov: 30 },
  { e: [960, 1420, 2480], g: [960, 560, 0], fov: 30 },
  { e: [1330, 540, 2280], g: [1330, 540, 0], fov: 30 },
];
function reducedCamera(t) {
  let k = 0;
  while (k < REDUCED_CUTS.length && t >= REDUCED_CUTS[k]) k++;
  const p = REDUCED_POSES[k];
  const cam = defaultCam(p.fov);
  cam.x = p.e[0]; cam.y = p.e[1]; cam.z = p.e[2];
  cam.tx = p.g[0]; cam.ty = p.g[1]; cam.tz = p.g[2];
  return cam;
}
function reducedDip(t) {
  let d = 0;
  for (const c of REDUCED_CUTS) d = Math.max(d, 1 - clamp(Math.abs(t - c) / 0.45));
  return smooth(d);
}

export function cameraAt(t) {
  if (REDUCED) return reducedCamera(t);
  let k = 0;
  while (k < CAM_KEYS.length - 2 && t >= CAM_KEYS[k + 1].t) k++;
  const a = CAM_KEYS[k], b = CAM_KEYS[k + 1];
  const u = easeInOutCubic((t - a.t) / (b.t - a.t));
  const cam = defaultCam(lerp(a.fov, b.fov, u));
  cam.x = lerp(a.e[0], b.e[0], u); cam.y = lerp(a.e[1], b.e[1], u); cam.z = lerp(a.e[2], b.e[2], u);
  cam.tx = lerp(a.g[0], b.g[0], u); cam.ty = lerp(a.g[1], b.g[1], u); cam.tz = lerp(a.g[2], b.g[2], u);
  // Handheld breath in the storm only, from t (deterministic).
  const hb = 1 - ramp(t, 20, 26);
  cam.x += hb * (Math.sin(t * 0.41) * 14 + Math.sin(t * 1.07 + 1.3) * 5);
  cam.z += hb * Math.sin(t * 0.53 + 0.7) * 10;
  cam.tx += hb * Math.sin(t * 0.37 + 2.1) * 6;
  return cam;
}

// ---------------------------------------------------------------- poses
function P() { return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, w: 10, h: 10, r: 1, g: 1, b: 1, a: 1, lines: 0, glow: 0, hue: 0 }; }
const A = P(), B = P(), O = P();

// Storm time warp: full speed, decelerating through the stakes, slow drift after.
function stormClock(t) {
  if (REDUCED) return 4 + t * 0.02;
  if (t <= 11) return t;
  if (t <= 16) { const d = t - 11; return 11 + d - 0.07 * d * d; }
  return 14.25 + 0.3 * (t - 16);
}

function poseStorm(i, t, p) {
  const S = stormClock(t);
  const clear = ramp(t, 20.6, 23.6);
  const rho = (170 + 1280 * Math.pow(R0[i], 0.72)) * (1 + 0.55 * clear);
  const arm = Math.floor(R1[i] * 3);
  const th0 = (arm * TAU) / 3 + Math.log(rho / 170) * 1.35 + (R2[i] - 0.5) * 1.1;
  const om = 0.2 * Math.pow(420 / rho, 0.6);
  const th = th0 + om * S;
  p.x = CENTER.x + rho * Math.cos(th);
  p.y = CENTER.y + 20 + rho * Math.sin(th) * 0.9;
  p.z = 50 + (40 + 560 * R3[i]) * (0.35 + 0.65 * Math.min(1, rho / 900)) + 26 * Math.sin(S * 0.7 + R4[i] * 6) - 120 * clear * R3[i];
  p.rx = R4[i] * TAU + S * (0.35 + R2[i] * 1.2);
  p.ry = R1[i] * TAU + S * (0.25 + R3[i] * 0.9);
  p.rz = th + R0[i] * 3;
  const s = L.slots[i];
  const sz = Math.max(12, s.w * 1.1) * (0.7 + R2[i] * 0.6);
  p.w = sz; p.h = sz * (1.05 + R4[i] * 0.35);
  p.r = COLORS.paper[0]; p.g = COLORS.paper[1]; p.b = COLORS.paper[2];
  p.a = 1; p.lines = 0.9; p.glow = 0; p.hue = 0;
}

// Two document pages, each a 5 x 7 grid of passages.
const PAGE = { cell: 42, gap: 4 };
function poseDoc(i, t, p) {
  const d = L.docs[L.docOf[i]];
  const side = d.page === 0 ? -1 : 1;
  const home = { x: 960 + side * 250, y: 600, z: 150 };
  const inU = easeOutQuart((t - 21.3 - d.page * 0.25) / 1.6);
  const split = easeInOutCubic((t - 23.9) / 0.9);
  const gap = PAGE.gap + split * 14;
  const pitch = PAGE.cell + gap;
  const lx = (d.col - (L.PAGE_COLS - 1) / 2) * pitch;
  const ly = (d.row - (L.PAGE_ROWS - 1) / 2) * pitch;
  const tilt = -0.55;
  p.x = home.x + lx + side * (1 - inU) * 1300 + split * (R1[i] - 0.5) * 14;
  p.y = home.y + ly * Math.cos(tilt);
  p.z = home.z + ly * Math.sin(tilt) + split * (R2[i] - 0.5) * 30;
  p.rx = tilt + split * (R3[i] - 0.5) * 0.3;
  p.ry = side * 0.12 + split * (R4[i] - 0.5) * 0.3;
  p.rz = split * (R0[i] - 0.5) * 0.35;
  p.w = PAGE.cell; p.h = PAGE.cell;
  const c = COLORS.paper;
  p.r = c[0]; p.g = c[1]; p.b = c[2];
  p.a = inU > 0 ? 1 : 0;
  p.lines = 1; p.glow = 0; p.hue = 0;
}

// Archive slot, including the program-wedge separation of the scope chapter
// and a slow drift of the halo on the end slate.
function poseArchive(i, t, p) {
  const s = L.slots[i];
  let x = s.x, y = s.y;
  const sep = ramp(t, 65.4, 67.0) * (1 - ramp(t, 72.0, 73.3));
  if (sep > 0) {
    const w = L.WEDGES[L.wedgeOf[i]];
    const m = (((w.a0 + w.a1) / 2) * Math.PI) / 180;
    x += Math.cos(m) * 46 * sep;
    y += Math.sin(m) * 46 * sep;
  }
  const spin = REDUCED ? 0 : Math.max(0, t - 73) * 0.012;
  if (spin > 0) {
    const a = s.a + spin * (s.field ? 0.6 : 1);
    x = CENTER.x + s.r * Math.cos(a);
    y = CENTER.y + s.r * Math.sin(a);
    p.rz = a + Math.PI / 2;
  } else p.rz = s.rz;
  p.x = x; p.y = y; p.z = s.z;
  p.rx = 0; p.ry = 0;
  p.w = s.w; p.h = s.h;
  p.r = s.col[0]; p.g = s.col[1]; p.b = s.col[2];
  p.a = 1; p.lines = s.lines; p.glow = 0; p.hue = 0;
  // End slate: the archive quiets into a halo around the mark.
  const q = ramp(t, 73.2, 75.4);
  if (q > 0) {
    const c = COLORS.paperCool;
    p.r = lerp(p.r, c[0], q * 0.55); p.g = lerp(p.g, c[1], q * 0.55); p.b = lerp(p.b, c[2], q * 0.55);
    p.z *= 1 - 0.5 * q;
    p.lines *= 1 - 0.6 * q;
  }
}

function poseMark(i, t, p) {
  const c = L.mark.cells[L.mark.markOf[i]];
  p.x = c.x; p.y = c.y; p.z = c.z;
  p.rx = 0; p.ry = 0; p.rz = c.rz;
  p.w = c.w; p.h = c.h;
  const col = COLORS[c.colKey];
  const j = (R2[i] - 0.5) * 0.04;
  p.r = col[0] + j; p.g = col[1] + j; p.b = col[2] + j;
  p.a = 1; p.lines = 0.1; p.glow = 0; p.hue = 0;
  // Gentle breathing of the two sheets on the hold.
  const br = Math.sin(t * 0.9 + c.sheet * 1.7) * 1.2 * ramp(t, 76, 78);
  p.z += br;
}

function blend(a, b, u, i, lift, out) {
  const up = easeInOutSine(u);
  out.x = lerp(a.x, b.x, up);
  out.y = lerp(a.y, b.y, up);
  // Arc sideways so the swarm reads as a swarm, and lift through the flight.
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const arc = Math.sin(Math.PI * up) * (R3[i] - 0.5) * 2 * Math.min(180, len * 0.25);
  out.x += (-dy / len) * arc;
  out.y += (dx / len) * arc;
  const zu = backOut(u, 0.7);
  out.z = lerp(a.z, b.z, zu) + Math.sin(Math.PI * clamp(u)) * lift;
  out.rx = a.rx + wrap(b.rx - a.rx) * up;
  out.ry = a.ry + wrap(b.ry - a.ry) * up;
  out.rz = a.rz + wrap(b.rz - a.rz) * up;
  out.w = lerp(a.w, b.w, up); out.h = lerp(a.h, b.h, up);
  out.r = lerp(a.r, b.r, u); out.g = lerp(a.g, b.g, u); out.b = lerp(a.b, b.b, u);
  out.a = lerp(a.a, b.a, u); out.lines = lerp(a.lines, b.lines, u);
  out.glow = lerp(a.glow, b.glow, u); out.hue = lerp(a.hue, b.hue, u);
}

// Gather timing: inner slots fill first, so the archive grows out from the core.
function gatherStart(i) {
  const s = L.slots[i];
  if (L.docOf[i] >= 0) return 24.9 + R4[i] * 0.6;
  return 24.5 + 2.5 * ((s.r - 146) / 874) + R3[i] * 0.8;
}
const GATHER_DUR = 1.9;
function markStart(i) {
  const s = L.slots[i];
  const a = Math.atan2(s.y - CENTER.y, s.x - CENTER.x);
  return 73.0 + ((a + Math.PI) / TAU) * 1.2 + R2[i] * 0.4;
}

function basePose(i, t, out) {
  const isDoc = L.docOf[i] >= 0;
  const g0 = gatherStart(i);
  if (t < g0) {
    if (isDoc) poseDoc(i, t, out); else poseStorm(i, t, out);
    return;
  }
  const inMark = L.mark.markOf[i] >= 0;
  const m0 = inMark ? markStart(i) : Infinity;
  if (t < g0 + GATHER_DUR) {
    if (isDoc) poseDoc(i, t, A); else poseStorm(i, t, A);
    poseArchive(i, t, B);
    blend(A, B, (t - g0) / GATHER_DUR, i, isDoc ? 60 : 90 + R1[i] * 140, out);
    return;
  }
  if (t < m0) { poseArchive(i, t, out); return; }
  const md = 1.6;
  if (t < m0 + md) {
    poseArchive(i, t, A); poseMark(i, t, B);
    blend(A, B, (t - m0) / md, i, 40 + R1[i] * 50, out);
    return;
  }
  poseMark(i, t, out);
}

// ---------------------------------------------------------------- retrieval
// Search passes, written as data so the renderer waves and the tile glows agree.
const SEARCHES = [
  { t0: 36.5, dur: 2.1, hit: true },
  { t0: 54.6, dur: 2.2, hit: false },
];
const WAVE_R0 = CORE_R + 10, WAVE_R1 = 640;

function waveRadius(sr, t) { return WAVE_R0 + (WAVE_R1 - WAVE_R0) * easeOutCubic((t - sr.t0) / sr.dur); }

// Screen spot where the hero passage opens into the citation panel (world coords,
// camera is top-down over x=700 at that moment).
const PANEL = { x: 1119, y: 540, z: 70, w: 664, h: 454 };

function applyRetrieval(i, t, p) {
  const s = L.slots[i];
  if (s.field && t > 30 && t < 64) {
    // The field still catches the wave light, faintly.
  }
  const dist = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
  for (const sr of SEARCHES) {
    if (t < sr.t0 || t > sr.t0 + sr.dur + 4) continue;
    const r = waveRadius(sr, t);
    const front = Math.exp(-Math.pow((dist - r) / 34, 2)) * (1 - ramp(t, sr.t0 + sr.dur - 0.4, sr.t0 + sr.dur + 0.2));
    p.glow = Math.max(p.glow, front * 0.55);
    // Residual glow on meaning matches after the front passes.
    const passT = sr.t0 + sr.dur * clamp(Math.pow((dist - WAVE_R0) / (WAVE_R1 - WAVE_R0), 0.7));
    if (sr.hit && L.semantic[i] && t > passT) {
      p.glow = Math.max(p.glow, 0.5 * (1 - ramp(t, 41.2, 42.2)));
    }
    if (!sr.hit && L.semantic[i] && t > passT) {
      // Weak matches flicker and die: nothing crosses the threshold.
      p.glow = Math.max(p.glow, 0.22 * pulse(t, passT, passT + 0.9));
      p.z += 10 * pulse(t, passT, passT + 1.1) * R1[i];
    }
  }
  // Exact words: sharp amber hits, one after another.
  const ek = exactRank[i];
  if (ek >= 0 && t > 38.6 && t < 42.4) {
    const th = 38.7 + ek * 0.12;
    if (t > th) {
      const k = Math.exp(-(t - th) * 3.2);
      p.glow = Math.max(p.glow, 0.35 + 0.65 * k);
      p.hue = Math.max(p.hue, (1 - ramp(t, 41.0, 41.6)) * (0.35 + 0.65 * Math.min(1, k * 3 + 0.4)));
      p.glow *= 1 - ramp(t, 41.6, 42.3) * (i === HERO ? 0 : 1);
    }
  }
  // Rerank: the shortlist lifts, the best passage rises highest.
  const sk = shortRank[i];
  if (sk >= 0 && t > 40.0 && t < 43.0) {
    const up = easeOutCubic((t - 40.0 - sk * 0.07) / 0.8) * (1 - easeInOutCubic((t - 41.5) / 0.8));
    const h = i === HERO ? 0 : 60 + (7 - sk) * 12;
    p.z += up * h;
    p.glow = Math.max(p.glow, up * 0.6);
    p.hue *= 1 - up * 0.6;
  }
}

// The hero passage's own track: lift, fly to the core, reappear as the citation
// panel, return to its slot.
function applyHero(t, p) {
  const s = L.slots[HERO];
  const home = { ...p };
  if (t < 40 || t > 51.2) return;
  const lift = easeOutCubic((t - 40.0) / 0.9);
  const toCore = easeInOutCubic((t - 41.5) / 0.9);
  const outCore = easeOutQuart((t - 44.3) / 1.1);
  const back = easeInOutCubic((t - 49.7) / 1.3);
  // Lifted pose above its slot.
  let x = home.x, y = home.y, z = home.z + lift * 150;
  let w = home.w * (1 + lift * 1.2), h = home.h * (1 + lift * 1.2);
  let rz = home.rz, glow = Math.max(home.glow, lift * 0.9), lines = home.lines;
  // Into the core.
  x = lerp(x, CENTER.x, toCore); y = lerp(y, CENTER.y, toCore);
  z = lerp(z, 34, toCore) + Math.sin(Math.PI * toCore) * 80;
  const shrink = 1 - 0.85 * toCore;
  w *= shrink; h *= shrink;
  rz = rz + wrap(0 - rz) * toCore;
  let a = 1 - ramp(t, 42.2, 42.45);
  // Out as the panel.
  if (t > 44.3) {
    a = ramp(t, 44.3, 44.45);
    x = lerp(CENTER.x, PANEL.x, outCore); y = lerp(CENTER.y, PANEL.y, outCore);
    z = lerp(40, PANEL.z, outCore);
    w = lerp(home.w, PANEL.w, outCore); h = lerp(home.h, PANEL.h, outCore);
    rz = 0; glow = 0.25 * (1 - outCore); lines = lerp(1, 0, outCore);
  }
  if (t > 49.7) {
    x = lerp(PANEL.x, s.x, back); y = lerp(PANEL.y, s.y, back);
    z = lerp(PANEL.z, s.z, back) + Math.sin(Math.PI * back) * 60;
    w = lerp(PANEL.w, s.w, back); h = lerp(PANEL.h, s.h, back);
    rz = wrap(s.rz) * back; lines = lerp(0, s.lines, back); glow = 0; a = 1;
  }
  p.x = x; p.y = y; p.z = z; p.w = w; p.h = h; p.rz = rz; p.rx = 0; p.ry = 0;
  p.glow = glow; p.lines = lines; p.a = a;
  const c = COLORS.paper; p.r = c[0]; p.g = c[1]; p.b = c[2];
  if (t > 44.3 && t < 51.2) { const cc = [0.992, 0.992, 0.988]; p.r = cc[0]; p.g = cc[1]; p.b = cc[2]; p.hue = 0; }
}

// Program scope: an angular sweep inside Program A that stops at its walls.
function applyScope(i, t, p) {
  if (t < 67.2 || t > 71.8) return;
  if (L.wedgeOf[i] !== 0) return;
  const w = L.WEDGES[0];
  const mid = (w.a0 + w.a1) / 2;
  let d = L.slots[i].deg - mid;
  d = ((d + 180) % 360 + 360) % 360 - 180;
  const spread = 62 * easeOutCubic((t - 67.3) / 1.4);
  const edge = Math.abs(d) - spread;
  const on = edge < 0 ? 0.42 + 0.4 * Math.exp(-Math.pow(edge / 6, 2)) : 0;
  p.glow = Math.max(p.glow, on * (1 - ramp(t, 70.6, 71.8)));
}

// Ripples: a ring of lift and light that runs out from the core when it
// ignites, when the answer lands, and when the mark forms.
const RIPPLES = [28.9, 42.45, 75.1];
function applyRipple(i, t, p) {
  for (const t0 of RIPPLES) {
    const u = t - t0;
    if (u < 0 || u > 2.2) continue;
    const dist = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
    const r = CORE_R + u * 620;
    const env = Math.exp(-Math.pow((dist - r) / 70, 2)) * Math.exp(-u * 1.1);
    p.z += 12 * env;
    p.glow = Math.max(p.glow, 0.3 * env);
  }
}

// ---------------------------------------------------------------- frame state
const fs = {
  t: 0, cam: null, tiles, count: N,
  ground: { ink: 1, lines: 0, linesX: CENTER.x, linesY: CENTER.y },
  light: { az: 0, el: 0.5, warmth: 0, intensity: 1 },
  shadow: 1,
  core: { x: CENTER.x, y: CENTER.y, r: CORE_R, on: 0, glow: 0, dim: 0 },
  waves: [],
  beams: [],
  post: { exposure: 1, bloom: 0.6, vignette: 0.35, grain: 0.04, fade: 0 },
};

export function frameState(tIn) {
  const t = Math.round(clamp(tIn, 0, DURATION) * 1e6) / 1e6;
  fs.t = t;
  fs.cam = cameraAt(t);

  // Frame reset of every field a scene may write.
  const dawn = ramp(t, 22.2, 25.2);
  fs.ground.ink = 1 - dawn;
  fs.ground.lines = ramp(t, 24.2, 27.8) * (1 - 0.35 * ramp(t, 73, 76));
  fs.ground.linesX = CENTER.x; fs.ground.linesY = CENTER.y;
  fs.light.warmth = dawn;
  fs.light.az = lerp(-2.6, -2.25, dawn);
  fs.light.el = lerp(0.42, 0.85, dawn);
  fs.light.intensity = lerp(0.9, 1.0, dawn);
  fs.shadow = lerp(0.65, 1, dawn);
  fs.post.exposure = 1;
  fs.post.bloom = lerp(0.9, 0.55, dawn);
  fs.post.vignette = lerp(0.5, 0.28, dawn);
  fs.post.grain = lerp(0.5, 0.32, dawn);
  fs.haze = 0.0003 * (1 - dawn);
  fs.post.fade = Math.max(1 - ramp(t, 0, 1.4), REDUCED ? reducedDip(t) : 0);

  // Core.
  const c = fs.core;
  c.x = CENTER.x; c.y = CENTER.y; c.r = CORE_R * (1 + 0.28 * easeInOutCubic((t - 73.2) / 1.8));
  c.on = ramp(t, 27.6, 29.0);
  c.glow = 0.25 * c.on + 0.75 * pulse(t, 42.2, 44.2) + 0.25 * pulse(t, 36.3, 37.2) + 0.35 * ramp(t, 74.5, 76.5);
  c.dim = ramp(t, 56.4, 57.4) * (1 - ramp(t, 61.5, 63.0));

  // Waves.
  fs.waves.length = 0;
  for (const sr of SEARCHES) {
    if (t < sr.t0 || t > sr.t0 + sr.dur + 0.3) continue;
    const u = (t - sr.t0) / sr.dur;
    const inten = Math.sin(Math.PI * clamp(u * 0.95 + 0.05)) * (sr.hit ? 1 : 0.7);
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: waveRadius(sr, t), width: 14, intensity: inten, hue: 0 });
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: Math.max(WAVE_R0, waveRadius(sr, t) - 70), width: 40, intensity: inten * 0.3, hue: 0 });
  }
  if (t > 38.6 && t < 39.9) {
    const u = (t - 38.6) / 1.3;
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: WAVE_R0 + u * 520, width: 3, intensity: 0.8 * Math.sin(Math.PI * u), hue: 1 });
  }

  // Tiles.
  for (let i = 0; i < N; i++) {
    basePose(i, t, O);
    if (t > 36 && t < 58.5) applyRetrieval(i, t, O);
    if (i === HERO) applyHero(t, O);
    if (t > 67) applyScope(i, t, O);
    applyRipple(i, t, O);
    const k = i * STRIDE;
    tiles[k] = O.x; tiles[k + 1] = O.y; tiles[k + 2] = O.z;
    tiles[k + 3] = O.rx; tiles[k + 4] = O.ry; tiles[k + 5] = O.rz;
    tiles[k + 6] = O.w; tiles[k + 7] = O.h;
    tiles[k + 8] = O.r; tiles[k + 9] = O.g; tiles[k + 10] = O.b;
    tiles[k + 11] = O.a; tiles[k + 12] = O.lines; tiles[k + 13] = O.glow; tiles[k + 14] = O.hue;
    tiles[k + 15] = R0[i];
  }

  // Beams.
  fs.beams.length = 0;
  if (t > 41.5 && t < 42.5) {
    // The best passage streaks into the core.
    const k = HERO * STRIDE;
    fs.beams.push({ x0: tiles[k], y0: tiles[k + 1], z0: tiles[k + 2], x1: CENTER.x, y1: CENTER.y, z1: 30, width: 3, intensity: pulse(t, 41.5, 42.5), hue: 0 });
  }
  // Program walls.
  const wall = ramp(t, 66.4, 67.2) * (1 - ramp(t, 71.8, 72.8));
  if (wall > 0) {
    for (const w of L.WEDGES) {
      const a = (w.a0 * Math.PI) / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const hitA = w === L.WEDGES[0] || w === L.WEDGES[1];
      const flare = hitA ? 1 + 1.4 * pulse(t, 68.3, 69.4) : 1;
      fs.beams.push({ x0: CENTER.x + ca * (CORE_R + 30), y0: CENTER.y + sa * (CORE_R + 30), z0: 8, x1: CENTER.x + ca * 980, y1: CENTER.y + sa * 980, z1: 8, width: 2.5, intensity: wall * 0.7 * flare, hue: 1 });
    }
  }
  return fs;
}

// ---------------------------------------------------------------- 2D layer
// Everything the viewer reads. `ui` is the ui.js module (may be null while the
// component library is missing); `cam` is the frame's camera.
export function drawUI(ctx, t, ui, cam) {
  const proj = (x, y, z = 0) => project(cam, x, y, z);
  drawVoice(ctx, t);
  if (!ui) return;
  const theme = t < 23.7 ? 'dark' : 'light';

  // Call bar: cold open, then the payoff once the answer lands.
  const callA = ramp(t, 0.8, 1.6) * (1 - ramp(t, 20.5, 21.4)) + ramp(t, 33.2, 34.0) * (1 - ramp(t, 49.6, 50.4));
  if (callA > 0.001) {
    const secs = 41 + Math.floor(t < 22 ? t : 12 + (t - 33) * 0.6);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    ui.callBar(ctx, {
      x: 96, y: 64, t, timer: `${mm}:${ss}`,
      status: t > 44.8 && t < 51 ? 'answered' : 'live',
      statusProgress: t > 44.8 ? easeOutQuart((t - 44.8) / 0.5) : 1,
      caller: t < 22 ? COPY.caller : null,
      callerProgress: clamp((t - 1.8) / 2.6),
      alpha: callA, theme: t < 22 ? 'dark' : 'light',
    });
  }

  // The stakes: two bare answers, indistinguishable.
  const gA = ramp(t, 11.8, 12.6), gB = ramp(t, 12.3, 13.1);
  const gOut = 1 - ramp(t, 20.0, 20.8);
  if (gA * gOut > 0.001) {
    ui.guessCard(ctx, { x: 520, y: 330, w: 380, h: 250, text: '$5', alpha: gA * gOut, progress: easeOutQuart((t - 11.8) / 0.8), crack: 0, theme: 'light' });
    ui.guessCard(ctx, { x: 1020, y: 330, w: 380, h: 250, text: '$15', alpha: gB * gOut, progress: easeOutQuart((t - 12.3) / 0.8), crack: clamp((t - 18.6) / 1.3), theme: 'light' });
  }

  // The turn: document titles ride above the pages.
  if (t > 21.3 && t < 26.2) {
    const la = ramp(t, 21.9, 22.5) * (1 - ramp(t, 25.2, 25.9));
    for (let pg = 0; pg < 2; pg++) {
      const side = pg === 0 ? -1 : 1;
      const inU = easeOutQuart((t - 21.3 - pg * 0.25) / 1.6);
      const top = proj(960 + side * 250 + side * (1 - inU) * 1300, 600 - 3.4 * 46 * Math.cos(-0.55), 150 - 3.4 * 46 * Math.sin(-0.55) + 40);
      if (la > 0.001) ui.label(ctx, { text: pg === 0 ? COPY.doc1 : COPY.doc2, x: top.sx, y: top.sy - 22, t: 1, t0: 0, t1: 99, theme, align: 'center', size: 18, alpha: la });
    }
    ui.label(ctx, { text: 'Approved documents', x: 960, y: 120, t, t0: 22.3, t1: 24.2, theme, align: 'center', size: 18, swatch: 'cobalt' });
    ui.label(ctx, { text: 'Split into passages', x: 960, y: 120, t, t0: 24.2, t1: 26.0, theme, align: 'center', size: 18, swatch: 'cobalt' });
  }

  // Ask: composer, search labels, answer, receipt, citation panel.
  const compA = ramp(t, 33.4, 34.2) * (1 - ramp(t, 45.2, 45.8)) + ramp(t, 50.4, 51.0) * (1 - ramp(t, 56.4, 57.0));
  const q = t < 50.6 ? COPY.q1 : COPY.q2;
  const typeStart = t < 50.6 ? 34.2 : 51.4;
  const chars = Math.floor(clamp((t - typeStart) / 2.0) * q.length);
  const pressAt = t < 50.6 ? 36.3 : 54.3;
  const cleared = (t > pressAt + 0.25 && t < 50.6) || t > 54.55;
  if (compA > 0.001) {
    ui.composer(ctx, {
      x: 96, y: 790, w: 700, text: cleared ? '' : q, chars: cleared ? 0 : chars,
      caretOn: Math.floor(t * 2) % 2 === 0, alpha: compA, theme: 'light', progress: easeOutQuart((t - (t < 50 ? 33.4 : 50.4)) / 0.6),
      press: pulse(t, pressAt - 0.1, pressAt + 0.3),
    });
  }
  const c = proj(CENTER.x, CENTER.y, 0);
  ui.label(ctx, { text: 'Meaning', x: c.sx + 200, y: c.sy - 360, t, t0: 36.8, t1: 41.0, theme: 'light', size: 18, swatch: 'cobalt' });
  ui.label(ctx, { text: 'Exact words', x: c.sx + 200, y: c.sy - 326, t, t0: 38.8, t1: 41.0, theme: 'light', size: 18, swatch: 'amber' });
  const hs = proj(L.slots[HERO].x, L.slots[HERO].y, 150);
  ui.label(ctx, { text: 'Best passage', x: hs.sx - 40, y: hs.sy - 20, t, t0: 40.5, t1: 42.0, theme: 'light', size: 18, align: 'right', swatch: 'cobalt' });

  if (t > 42.5 && t < 51) {
    const aA = 1 - ramp(t, 49.8, 50.6);
    const card = ui.answerCard(ctx, {
      x: 96, y: 300, w: 700, question: COPY.q1, answer: COPY.a1, citeIndex: 1, docTitle: COPY.doc1,
      progress: easeOutQuart((t - 42.5) / 0.5), receiptProgress: easeOutQuart((t - 43.2) / 0.5),
      chipHot: ramp(t, 44.0, 44.4) * (1 - ramp(t, 48.5, 49.5)), alpha: aA, theme: 'light',
    });
    // Panel: drawn exactly over the hero tile once it has opened into it.
    const pa = ramp(t, 45.1, 45.5) * (1 - ramp(t, 49.4, 49.8));
    if (pa > 0.001) {
      const tl = proj(PANEL.x - PANEL.w / 2, PANEL.y - PANEL.h / 2, PANEL.z);
      const br = proj(PANEL.x + PANEL.w / 2, PANEL.y + PANEL.h / 2, PANEL.z);
      const panel = ui.citationPanel(ctx, {
        x: tl.sx, y: tl.sy, w: br.sx - tl.sx, h: br.sy - tl.sy, docTitle: COPY.doc1, section: 'Standard Fees',
        rows: [['Plan', 'Cancellation Fee'], ['Basic', '$5'], ['Pro', '$10'], ['Enterprise', '$25']],
        highlightRow: 1, progress: easeOutQuart((t - 45.1) / 0.6), alpha: pa,
      });
      if (card && card.chipCenter && panel && panel.row) drawThread(ctx, card.chipCenter, panel.row, pa * ramp(t, 45.6, 46.3));
    }
  }

  // The stop.
  ui.label(ctx, { text: 'No strong match. Answer model not called.', x: c.sx, y: c.sy + 200, t, t0: 56.6, t1: 60.2, theme: 'light', size: 18, align: 'center', swatch: 'amber' });
  if (t > 57.0 && t < 64.4) {
    const ra = ramp(t, 57.1, 57.5) * (1 - ramp(t, 63.6, 64.4));
    ui.refusalCard(ctx, { x: 96, y: 290, w: 700, question: COPY.q2, progress: easeOutQuart((t - 57.1) / 0.5), alpha: ra, flagged: t > 61.2 });
  }
  if (t > 60.8 && t < 64.4) {
    const u = easeOutQuart((t - 60.9) / 0.8);
    ui.label(ctx, { text: 'Logged in Content gaps for review', x: 96, y: 612, t, t0: 61.3, t1: 64.2, theme: 'light', size: 18, align: 'left' });
    ui.gapItem(ctx, { x: 96, y: 640 + (1 - u) * 16, w: 700, question: COPY.q2, progress: u, alpha: ramp(t, 60.9, 61.3) * (1 - ramp(t, 63.6, 64.4)) });
  }

  // Program scope tags.
  if (t > 66.4 && t < 73) {
    const ta = ramp(t, 66.6, 67.3) * (1 - ramp(t, 72.0, 72.8));
    L.WEDGES.forEach((w) => {
      const m = (((w.a0 + w.a1) / 2) * Math.PI) / 180;
      const p = proj(CENTER.x + Math.cos(m) * 560, CENTER.y + Math.sin(m) * 560, 0);
      ui.programTag(ctx, { x: p.sx, y: p.sy, name: w.name, hue: w.hue, alpha: ta, theme: 'light' });
    });
  }

  // Statements.
  for (const s of STATEMENTS) {
    if (t < s.t0 - 0.05 || t > s.t1 + 0.05) continue;
    ui.statement(ctx, { ...s, size: s.align === 'left' ? 60 : 66, maxWidth: s.maxWidth ?? 1400, t });
  }

  // End slate: the mark is tiles and the lens; the layer adds the T and the words.
  if (t > 74.6) {
    const m = proj(MARK.x, MARK.y, 0);
    ui.lockup(ctx, {
      x: m.sx, y: m.sy, scale: (m.scale * MARK.size) / 330, markAlpha: 0, tAlpha: ramp(t, 75.0, 75.8),
      wordAlpha: ramp(t, 75.6, 76.6), tagline: COPY.tagline, taglineAlpha: ramp(t, 76.4, 77.3),
      url: COPY.url, urlAlpha: ramp(t, 77.2, 78.0), theme: 'light', layout: 'horizontal',
    });
  }
}

// The caller's voice: a thin line across the lower frame, driven by a
// deterministic speech envelope.
function drawVoice(ctx, t) {
  const a = ramp(t, 0.6, 1.4) * (1 - ramp(t, 9.5, 11));
  if (a <= 0.001) return;
  const speaking = (u) => pulse(u, 1.8, 4.6) * (0.6 + 0.4 * Math.sin(u * 7.1) * Math.sin(u * 3.3));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(233, 226, 210, 0.75)';
  ctx.shadowColor = 'rgba(160, 190, 255, 0.55)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  const y0 = 1000;
  for (let x = 0; x <= 1920; x += 6) {
    const env = Math.exp(-Math.pow((x - 960) / 520, 2));
    const s = speaking(t);
    const v = Math.sin(x * 0.045 + t * 9) * 0.6 + Math.sin(x * 0.11 - t * 13) * 0.3 + Math.sin(x * 0.021 + t * 4) * 0.5;
    const y = y0 + v * env * (2 + s * 26);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// A cobalt thread from the citation chip to the highlighted source row.
function drawThread(ctx, chip, row, a) {
  if (a <= 0.001) return;
  const x0 = chip.x, y0 = chip.y;
  const x1 = row.x, y1 = row.y + row.h / 2;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = 'rgba(0, 64, 171, 0.85)';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(0, 93, 229, 0.6)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  const mx = (x0 + x1) / 2;
  ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 64, 171, 1)';
  ctx.beginPath(); ctx.arc(x1, y1, 4, 0, TAU); ctx.fill();
  ctx.restore();
}
