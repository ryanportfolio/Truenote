// The film's timeline. frameState(t) and drawUI(ctx, t) are pure functions of
// t: no state survives between frames, so seek, scrub and export are exact.

import { buildLayout, CENTER, CORE_R, COLORS, MARK } from './shapes.js';
import { defaultCam, project } from './camera.js';

export const DURATION = 77;
export const CHAPTERS = [
  { name: 'Cold open', t0: 0, t1: 10 },
  { name: 'The stakes', t0: 10, t1: 19 },
  { name: 'The turn', t0: 19, t1: 31 },
  { name: 'The receipt', t0: 31, t1: 46.6 },
  { name: 'The stop', t0: 46.6, t1: 58.6 },
  { name: 'Program scope', t0: 58.6, t1: 67 },
  { name: 'Truenote', t0: 67, t1: DURATION },
];

// ---------------------------------------------------------------- copy
export const COPY = {
  caller: "What's the fee if I cancel my Basic plan?",
  q1: 'What is the cancellation fee for the Basic plan?',
  a1: 'The standard cancellation fee for the Basic plan is **$5** [1]',
  doc1: 'Cancellation Policy v1',
  doc2: 'Refund Procedure v1',
  q2: 'What is the reinstatement fee for the Premium plan?',
  // Refusal copy as the API and AnswerView render it (answer.ts:54, AnswerView.tsx:225-231).
  refusal: "I couldn't find this in the knowledge base. Please escalate or check the source documents directly.",
  refusalHint: 'Search for the plan, form, or fee name used in the document.',
  tagline: 'A cited answer, or a clear no.',
  url: 'truenote.org',
};

// The seeded Cancellation Policy passage (scripts/src/seed.ts), as the
// citation panel shows it: raw markdown.
const EXCERPT_ROWS = [['Plan', 'Cancellation Fee'], ['Basic', '$5'], ['Pro', '$10'], ['Enterprise', '$25']];
const EXCERPT_LINES = ['## Standard Fees', '| Plan | Cancellation Fee |', '| --- | --- |', '| Basic | $5 |', '| Pro | $10 |', '| Enterprise | $25 |'];

export const STATEMENTS = [
  { text: 'The answer is in here. Somewhere.', accent: [5], t0: 6.4, t1: 10.5, x: 960, y: 866, align: 'center', theme: 'dark' },
  { text: 'A guess sounds exactly like an answer.', accent: [3], t0: 13.6, t1: 18.0, x: 960, y: 880, align: 'center', theme: 'dark' },
  { text: 'Only your approved documents can support an answer.', accent: [2], t0: 27.0, t1: 31.6, x: 110, y: 520, align: 'left', maxWidth: 720, theme: 'light' },
  { text: 'Every answer shows its receipt.', accent: [4], t0: 41.8, t1: 45.6, x: 96, y: 950, align: 'left', maxWidth: 1300, theme: 'light' },
  { text: 'When the documents stop, Truenote stops.', accent: [5], t0: 54.4, t1: 58.5, x: 96, y: 950, align: 'left', maxWidth: 1300, theme: 'light' },
  { text: "A rep's search never reaches another program.", accent: [3], t0: 62.2, t1: 66.6, x: 960, y: 985, align: 'center', maxWidth: 1700, theme: 'light' },
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
const easeInCubic = (u) => Math.pow(clamp(u), 3);
const easeInOutCubic = (u) => { u = clamp(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
const easeInOutSine = (u) => -(Math.cos(Math.PI * clamp(u)) - 1) / 2;
const backOut = (u, c1 = 0.9) => { u = clamp(u); const c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); };
const TAU = Math.PI * 2;
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const pulse = (t, a, b) => { const u = (t - a) / (b - a); return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u); };
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

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

// The cold-open close-up: one passage tumbles past the lens with the answer
// printed on it, before anyone knows it matters.
const FOCUS = (() => { for (let i = 0; i < N; i++) if (L.slots[i].field && L.docOf[i] < 0 && L.mark.markOf[i] < 0) return i; return 0; })();

// Program walls: tiles lying on the three wedge boundaries stand up as palisades.
const WALL_ANGLES = L.WEDGES.map((w) => w.a0);
const wallOf = new Int8Array(N).fill(-1);
for (let i = 0; i < N; i++) {
  const s = L.slots[i];
  if (i === HERO || L.docOf[i] >= 0 || s.r < CORE_R + 40 || s.r > 900) continue;
  for (let k = 0; k < 3; k++) if (Math.abs(angDiff(s.deg, WALL_ANGLES[k])) < (s.field ? 1.1 : 1.8)) wallOf[i] = k;
}

// End slate: every tile folds into the mark. Tiles without their own cell
// stack beneath a cell of the top layer.
const CELLS = L.mark.cells;
const markCell = new Int32Array(N);
const markLayer = new Float32Array(N);
{
  let k = 0;
  for (let i = 0; i < N; i++) {
    if (L.mark.markOf[i] >= 0) { markCell[i] = L.mark.markOf[i]; markLayer[i] = 0; }
    else { markCell[i] = k % CELLS.length; markLayer[i] = 1 + Math.floor(k / CELLS.length); k++; }
  }
}

// ---------------------------------------------------------------- camera
// Keys: t, eye, target, fov, roll. Segments ease in-out between consecutive keys.
const CAM_KEYS = [
  { t: 0, e: [930, 1560, 250], g: [960, 640, 210], fov: 38 },
  { t: 8.5, e: [1080, 1950, 1250], g: [960, 560, 120], fov: 34 },
  { t: 18.6, e: [1020, 1880, 1180], g: [960, 590, 130], fov: 33 },
  { t: 20.8, e: [980, 1760, 760], g: [960, 610, 150], fov: 32 },
  { t: 22.6, e: [990, 1740, 760], g: [960, 600, 120], fov: 32, r: -0.22 },
  { t: 26.2, e: [770, 720, 2015], g: [770, 540, 0], fov: 30 },
  { t: 27.4, e: [760, 700, 2015], g: [760, 540, 0], fov: 30 },
  { t: 31.0, e: [745, 690, 1995], g: [745, 540, 0], fov: 30, r: 0.03 },
  // The search, seen low across the paper so the waves roll toward us.
  { t: 33.8, e: [820, 1880, 640], g: [980, 470, 0], fov: 34 },
  { t: 36.4, e: [720, 1360, 520], g: [860, 700, 60], fov: 34 },
  { t: 37.9, e: [880, 1180, 860], g: [960, 560, 30], fov: 33 },
  // Overhead for the receipt: the panel is drawn over the unfolded tile.
  { t: 40.4, e: [700, 540, 1830], g: [700, 540, 0], fov: 30 },
  { t: 45.5, e: [700, 540, 1810], g: [700, 540, 0], fov: 30 },
  { t: 47.0, e: [740, 800, 1990], g: [740, 540, 0], fov: 30 },
  // The second search, from the other side; then a held stop.
  { t: 49.0, e: [-160, 980, 780], g: [900, 560, 20], fov: 34 },
  { t: 52.2, e: [-120, 960, 790], g: [900, 560, 20], fov: 34 },
  { t: 52.9, e: [-120, 960, 790], g: [900, 560, 20], fov: 34 },
  { t: 56.8, e: [720, 760, 2000], g: [720, 540, 0], fov: 30 },
  { t: 58.4, e: [730, 780, 2010], g: [730, 540, 0], fov: 30 },
  { t: 60.6, e: [960, 1420, 2480], g: [960, 560, 0], fov: 30 },
  { t: 66.4, e: [930, 1380, 2400], g: [960, 560, 0], fov: 30, r: 0.05 },
  { t: 67.6, e: [960, 760, 2150], g: [960, 540, 0], fov: 30 },
  { t: 69.8, e: [1330, 540, 2330], g: [1330, 540, 0], fov: 30 },
  { t: DURATION, e: [1330, 540, 2230], g: [1330, 540, 0], fov: 30 },
];

// prefers-reduced-motion: no camera travel, no vortex spin, no handheld
// breath. The camera holds one pose per act and changes only under a short
// dissolve through ink; every caption and state change stays.
let REDUCED = false;
export function setReducedMotion(on) { REDUCED = !!on; }
const REDUCED_CUTS = [22.9, 58.6, 67.2];
const REDUCED_POSES = [
  { e: [1080, 1950, 1250], g: [960, 560, 120], fov: 34 },
  { e: [700, 540, 1830], g: [700, 540, 0], fov: 30 },
  { e: [960, 1420, 2480], g: [960, 560, 0], fov: 30 },
  { e: [1330, 540, 2280], g: [1330, 540, 0], fov: 30 },
];
function reducedDip(t) {
  let d = 0;
  for (const c of REDUCED_CUTS) d = Math.max(d, 1 - clamp(Math.abs(t - c) / 0.45));
  return smooth(d);
}

function setCam(cam, e, g, r = 0) {
  cam.x = e[0]; cam.y = e[1]; cam.z = e[2];
  cam.tx = g[0]; cam.ty = g[1]; cam.tz = g[2];
  cam.ux = Math.sin(r); cam.uy = -Math.cos(r); cam.uz = 0;
  return cam;
}

export function cameraAt(t) {
  if (REDUCED) {
    let k = 0;
    while (k < REDUCED_CUTS.length && t >= REDUCED_CUTS[k]) k++;
    const p = REDUCED_POSES[k];
    return setCam(defaultCam(p.fov), p.e, p.g);
  }
  let k = 0;
  while (k < CAM_KEYS.length - 2 && t >= CAM_KEYS[k + 1].t) k++;
  const a = CAM_KEYS[k], b = CAM_KEYS[k + 1];
  const u = easeInOutCubic((t - a.t) / (b.t - a.t));
  const cam = defaultCam(lerp(a.fov, b.fov, u));
  const e = [0, 1, 2].map((j) => lerp(a.e[j], b.e[j], u));
  const g = [0, 1, 2].map((j) => lerp(a.g[j], b.g[j], u));
  setCam(cam, e, g, lerp(a.r ?? 0, b.r ?? 0, u));
  // Handheld breath in the storm only, from t (deterministic).
  const hb = 1 - ramp(t, 19, 24);
  cam.x += hb * (Math.sin(t * 0.41) * 14 + Math.sin(t * 1.07 + 1.3) * 5);
  cam.z += hb * Math.sin(t * 0.53 + 0.7) * 10;
  cam.tx += hb * Math.sin(t * 0.37 + 2.1) * 6;
  return cam;
}

function camBasis(cam) {
  const f = [cam.tx - cam.x, cam.ty - cam.y, cam.tz - cam.z];
  const fl = Math.hypot(...f); f[0] /= fl; f[1] /= fl; f[2] /= fl;
  const up = [cam.ux, cam.uy, cam.uz];
  // World is mirrored (y down, z up): right = up x forward.
  let r = [up[1] * f[2] - up[2] * f[1], up[2] * f[0] - up[0] * f[2], up[0] * f[1] - up[1] * f[0]];
  const rl = Math.hypot(...r); r = r.map((v) => v / rl);
  const u = [f[1] * r[2] - f[2] * r[1], f[2] * r[0] - f[0] * r[2], f[0] * r[1] - f[1] * r[0]];
  return { f, r, u };
}

// ---------------------------------------------------------------- poses
function P() { return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, w: 10, h: 10, r: 1, g: 1, b: 1, a: 1, lines: 0, glow: 0, hue: 0 }; }
const A = P(), B = P(), O = P();

// Storm time warp: full speed, decelerating through the stakes, slow drift after.
function stormClock(t) {
  if (REDUCED) return 4;
  if (t <= 10) return t;
  if (t <= 15) { const d = t - 10; return 10 + d - 0.07 * d * d; }
  return 13.25 + 0.3 * (t - 15);
}

function stormColour(i) {
  if (R1[i] < 0.1) return COLORS.sage;
  if (R1[i] > 0.93) return COLORS.coralLight;
  return R4[i] < 0.3 ? COLORS.paperWarm : COLORS.paper;
}

function poseStorm(i, t, p) {
  const S = stormClock(t);
  const clear = ramp(t, 18.8, 21.4);
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
  const c = stormColour(i);
  p.r = c[0]; p.g = c[1]; p.b = c[2];
  p.a = 1; p.lines = 0.9; p.glow = 0; p.hue = 0;
}

// The close-up passage: a path in camera space, facing the lens mid-flight.
function applyFocus(t, p) {
  // Hidden in the storm outside its flight, so it never blinks out of the swarm.
  if (t < 4.0 || t > 7.8) { if (t < gatherStart(FOCUS)) p.a = 0; return; }
  const u = clamp((t - 4.0) / 3.8);
  const cam = cameraAt(t);
  const { f, r, u: up } = camBasis(cam);
  const d = 560;
  const x = lerp(-620, 520, easeInOutSine(u));
  const y = -40 + 50 * Math.sin(u * Math.PI);
  p.x = cam.x + f[0] * d + r[0] * x + up[0] * y;
  p.y = cam.y + f[1] * d + r[1] * x + up[1] * y;
  p.z = cam.z + f[2] * d + r[2] * x + up[2] * y;
  // Face the camera, turning a little as it passes.
  const tilt = (u - 0.5) * 1.1;
  const n = [-f[0] + r[0] * tilt, -f[1] + r[1] * tilt, -f[2] + r[2] * tilt];
  const nl = Math.hypot(...n);
  p.rx = Math.asin(clamp(-n[1] / nl, -1, 1));
  p.ry = Math.atan2(n[0] / nl, n[2] / nl);
  p.rz = 0.12 * Math.sin(u * 3);
  p.w = 104; p.h = 72;
  const c = COLORS.paper;
  p.r = c[0]; p.g = c[1]; p.b = c[2];
  p.lines = 0; p.glow = 0; p.a = 1;
}

// Two document pages that arrive whole and are cut into 5 x 7 passages.
const PAGE = { cell: 42 };
function poseDoc(i, t, p) {
  const d = L.docs[L.docOf[i]];
  const side = d.page === 0 ? -1 : 1;
  const home = { x: 960 + side * 250, y: 600, z: 150 };
  const inU = easeOutQuart((t - 19.3 - d.page * 0.25) / 1.6);
  const cut = easeOutCubic((t - (21.5 + d.row * 0.12 + d.page * 0.05)) / 0.4);
  const pitch = PAGE.cell + 1 + cut * 12;
  const lx = (d.col - (L.PAGE_COLS - 1) / 2) * pitch;
  const ly = (d.row - (L.PAGE_ROWS - 1) / 2) * (PAGE.cell + 1 + cut * 16);
  const tilt = -0.55;
  p.x = home.x + lx + side * (1 - inU) * 1300 + cut * (R1[i] - 0.5) * 10;
  p.y = home.y + ly * Math.cos(tilt);
  p.z = home.z + ly * Math.sin(tilt) + cut * (R2[i] - 0.5) * 24;
  p.rx = tilt + cut * (R3[i] - 0.5) * 0.25;
  p.ry = side * 0.12 + cut * (R4[i] - 0.5) * 0.25;
  p.rz = cut * (R0[i] - 0.5) * 0.3;
  p.w = PAGE.cell + 1 - cut; p.h = PAGE.cell + 1 - cut;
  const c = COLORS.paper;
  p.r = c[0]; p.g = c[1]; p.b = c[2];
  p.a = inU > 0 ? 1 : 0;
  p.lines = 1; p.glow = 0.35 * pulse(t, 21.5 + d.row * 0.12, 21.95 + d.row * 0.12); p.hue = 0;
}

// Archive slot, with the program-wedge separation of the scope chapter.
function sepAmount(t) { return ramp(t, 59.4, 60.6) * (1 - ramp(t, 66.4, 67.2)); }
function poseArchive(i, t, p) {
  const s = L.slots[i];
  let x = s.x, y = s.y;
  const sep = sepAmount(t);
  if (sep > 0 && wallOf[i] < 0) {
    const w = L.WEDGES[L.wedgeOf[i]];
    const m = (((w.a0 + w.a1) / 2) * Math.PI) / 180;
    x += Math.cos(m) * 42 * sep;
    y += Math.sin(m) * 42 * sep;
  }
  p.x = x; p.y = y; p.z = s.z;
  p.rx = 0; p.ry = 0; p.rz = s.rz;
  p.w = s.w; p.h = s.h;
  p.r = s.col[0]; p.g = s.col[1]; p.b = s.col[2];
  p.a = 1; p.lines = s.lines; p.glow = 0; p.hue = 0;
  // Palisades: boundary tiles stand on edge along their radius.
  const k = wallOf[i];
  if (k >= 0 && sep > 0) {
    const a = (WALL_ANGLES[k] * Math.PI) / 180;
    const up = easeOutCubic(sep);
    const H = 38;
    p.x = lerp(s.x, CENTER.x + Math.cos(a) * s.r, up);
    p.y = lerp(s.y, CENTER.y + Math.sin(a) * s.r, up);
    p.rz = lerp(s.rz, a, up);
    p.rx = (Math.PI / 2) * up;
    p.w = lerp(s.w, Math.max(s.w, 20) * 1.15, up);
    p.h = lerp(s.h, H, up);
    p.z = lerp(s.z, H / 2 + 2, up);
    p.lines = lerp(s.lines, 0.2, up);
  }
}

function poseMark(i, t, p) {
  const c = CELLS[markCell[i]];
  const layer = markLayer[i];
  const fuse = ramp(t, 69.0, 70.0);
  p.x = c.x; p.y = c.y; p.z = c.z - layer * 1.2;
  p.rx = 0; p.ry = 0; p.rz = c.rz;
  const grow = layer > 0 ? 0.9 : lerp(1, 1.12, fuse);
  p.w = c.w * grow; p.h = c.h * grow;
  const col = COLORS[c.colKey];
  const j = (R2[i] - 0.5) * 0.04 * (1 - fuse);
  p.r = col[0] + j; p.g = col[1] + j; p.b = col[2] + j;
  p.a = 1; p.lines = 0.1 * (1 - fuse); p.glow = 0; p.hue = 0;
  p.z += Math.sin(t * 0.9 + c.sheet * 1.7) * 1.2 * ramp(t, 71, 73);
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

// Gather timing: passages file in first; the archive grows out from the core.
function gatherStart(i) {
  const s = L.slots[i];
  const d = L.docOf[i];
  if (d >= 0) { const doc = L.docs[d]; return 22.7 + doc.row * 0.08 + doc.col * 0.03 + doc.page * 0.1; }
  return 22.8 + 2.1 * ((s.r - 146) / 874) + R3[i] * 0.45;
}
function gatherDur(i) { return L.docOf[i] >= 0 ? 1.4 : 1.5; }
function markStart(i) {
  const s = L.slots[i];
  return 67.3 + R2[i] * 0.45 + (s.field ? 0.15 : 0) + (L.mark.markOf[i] >= 0 ? 0 : 0.1);
}
const MARK_DUR = 1.5;

function basePose(i, t, out) {
  const isDoc = L.docOf[i] >= 0;
  const g0 = gatherStart(i), gd = gatherDur(i);
  if (t < g0) {
    if (isDoc) poseDoc(i, t, out); else poseStorm(i, t, out);
    return;
  }
  const m0 = markStart(i);
  if (t < g0 + gd) {
    if (isDoc) poseDoc(i, t, A); else poseStorm(i, t, A);
    poseArchive(i, t, B);
    blend(A, B, (t - g0) / gd, i, isDoc ? 60 : 90 + R1[i] * 140, out);
    return;
  }
  if (t < m0) { poseArchive(i, t, out); return; }
  if (t < m0 + MARK_DUR) {
    poseArchive(i, t, A); poseMark(i, t, B);
    blend(A, B, (t - m0) / MARK_DUR, i, 50 + R1[i] * 90, out);
    const cu = ramp(t, m0 + MARK_DUR * 0.6, m0 + MARK_DUR);
    out.r = lerp(A.r, B.r, cu); out.g = lerp(A.g, B.g, cu); out.b = lerp(A.b, B.b, cu);
    return;
  }
  poseMark(i, t, out);
}

// ---------------------------------------------------------------- retrieval
// Search passes as data, so the renderer waves and the tile glows agree.
const SEARCHES = [
  { t0: 34.0, dur: 1.6, hit: true },
  { t0: 49.6, dur: 1.6, hit: false },
];
const WAVE_R0 = CORE_R + 10, WAVE_R1 = 640;
function waveRadius(sr, t) { return WAVE_R0 + (WAVE_R1 - WAVE_R0) * easeOutCubic((t - sr.t0) / sr.dur); }
const EXACT_T0 = 35.2, EXACT_STEP = 0.08;
const THRESH = { r: 430, z: 70 };

// Where the hero passage opens into the citation panel (world, overhead camera over x=700).
const PANEL = { x: 1119, y: 540, z: 70, w: 664, h: 454 };

function applyRetrieval(i, t, p) {
  const dist = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
  for (const sr of SEARCHES) {
    if (t < sr.t0 || t > sr.t0 + sr.dur + 3.5) continue;
    const r = waveRadius(sr, t);
    const front = Math.exp(-Math.pow((dist - r) / 34, 2)) * (1 - ramp(t, sr.t0 + sr.dur - 0.3, sr.t0 + sr.dur + 0.2));
    p.glow = Math.max(p.glow, front * 0.55);
    // Cobalt light on persimmon reads purple; warm tiles catch the wave as amber.
    if (front > 0.02 && L.slots[i].colKey === 'coral') p.hue = Math.max(p.hue, 1);
    const passT = sr.t0 + sr.dur * clamp(Math.pow((dist - WAVE_R0) / (WAVE_R1 - WAVE_R0), 0.7));
    if (sr.hit && L.semantic[i] && t > passT) p.glow = Math.max(p.glow, 0.5 * (1 - ramp(t, 36.8, 37.4)));
    if (!sr.hit && L.semantic[i] && t > passT) {
      // Weak matches rise toward the bar, fall short, and settle.
      const rise = easeOutCubic((t - 50.6 - R1[i] * 0.3) / 0.8) * (1 - easeInOutCubic((t - 51.8 - R2[i] * 0.2) / 0.6));
      p.z += THRESH.z * 0.6 * rise * (0.6 + 0.4 * R3[i]);
      p.glow = Math.max(p.glow, 0.28 * rise);
    }
  }
  // Exact words: sharp amber hits, one after another.
  const ek = exactRank[i];
  if (ek >= 0 && t > EXACT_T0 && t < 37.6) {
    const th = EXACT_T0 + ek * EXACT_STEP;
    if (t > th) {
      const k = Math.exp(-(t - th) * 3.2);
      p.glow = Math.max(p.glow, 0.35 + 0.65 * k);
      p.hue = Math.max(p.hue, (1 - ramp(t, 36.4, 36.9)) * (0.35 + 0.65 * Math.min(1, k * 3 + 0.4)));
      p.glow *= 1 - ramp(t, 36.9, 37.5) * (i === HERO ? 0 : 1);
    }
  }
  // Rerank: the shortlist lifts, the best passage rises highest.
  const sk = shortRank[i];
  if (sk >= 0 && i !== HERO && t > 36.2 && t < 38.2) {
    const up = easeOutCubic((t - 36.2 - sk * 0.06) / 0.6) * (1 - easeInOutCubic((t - 37.1) / 0.7));
    p.z += up * (60 + (7 - sk) * 12);
    p.glow = Math.max(p.glow, up * 0.6);
    p.hue *= 1 - up * 0.6;
  }
}

// The hero passage: lift, fly into the core, come back out, turn over and
// unfold into the citation panel, then return to its slot.
function applyHero(t, p) {
  if (t < 36.2 || t > 46.7) return;
  const s = L.slots[HERO];
  const home = { ...p };
  const cardCol = [0.992, 0.99, 0.984];
  if (t < 39.0) {
    const lift = easeOutCubic((t - 36.2) / 0.7);
    const toCore = easeInOutCubic((t - 37.2) / 0.7);
    let x = home.x, y = home.y, z = home.z + lift * 150;
    let w = home.w * (1 + lift * 1.3), h = home.h * (1 + lift * 1.3);
    x = lerp(x, CENTER.x, toCore); y = lerp(y, CENTER.y, toCore);
    z = lerp(z, 34, toCore) + Math.sin(Math.PI * toCore) * 80;
    const shrink = 1 - 0.85 * toCore;
    p.x = x; p.y = y; p.z = z; p.w = w * shrink; p.h = h * shrink;
    p.rz = home.rz + wrap(0 - home.rz) * toCore; p.rx = 0; p.ry = 0;
    p.glow = Math.max(home.glow, lift * 0.9); p.hue = 0;
    p.a = 1 - ramp(t, 37.7, 37.9);
    return;
  }
  const out = easeOutCubic((t - 39.0) / 0.6);
  const flip = easeInOutCubic((t - 39.4) / 0.8);
  const unfold = easeInOutCubic((t - 40.1) / 0.7);
  const back = easeInOutCubic((t - 45.4) / 1.2);
  p.a = ramp(t, 39.0, 39.15);
  const liftZ = lerp(40, 190, out);
  let x = CENTER.x, y = CENTER.y + 40 * out, z = liftZ;
  let w = lerp(16, 120, out), h = lerp(16, 90, out);
  // Unfold: fly to the panel spot, flatten, grow.
  x = lerp(x, PANEL.x, unfold); y = lerp(y, PANEL.y, unfold); z = lerp(z, PANEL.z, unfold);
  w = lerp(w, PANEL.w, unfold); h = lerp(h, PANEL.h, unfold);
  p.rx = 0.35 * Math.sin(Math.PI * flip) * (1 - unfold);
  p.ry = TAU * flip;
  p.rz = 0;
  p.lines = 1 - unfold; p.glow = 0.7 * (1 - unfold) * out; p.hue = 0;
  const c = COLORS.paper;
  p.r = lerp(c[0], cardCol[0], unfold); p.g = lerp(c[1], cardCol[1], unfold); p.b = lerp(c[2], cardCol[2], unfold);
  if (t > 45.4) {
    x = lerp(PANEL.x, s.x, back); y = lerp(PANEL.y, s.y, back);
    z = lerp(PANEL.z, s.z, back) + Math.sin(Math.PI * back) * 60;
    w = lerp(PANEL.w, s.w, back); h = lerp(PANEL.h, s.h, back);
    p.rz = wrap(s.rz) * back; p.ry = 0; p.rx = 0; p.lines = lerp(0, s.lines, back); p.glow = 0; p.a = 1;
    p.r = lerp(cardCol[0], s.col[0], back); p.g = lerp(cardCol[1], s.col[1], back); p.b = lerp(cardCol[2], s.col[2], back);
  }
  p.x = x; p.y = y; p.z = z; p.w = w; p.h = h;
}

// Program scope: a sweep inside Program A that runs to its walls and stops.
const SWEEP = { t0: 61.4, from: -70, speed: 60 };
function sweepSpread(t) { return Math.max(0, (t - SWEEP.t0) * SWEEP.speed); }
function wallHitTime(k) { return SWEEP.t0 + Math.abs(angDiff(WALL_ANGLES[k], SWEEP.from)) / SWEEP.speed; }
function applyScope(i, t, p) {
  if (t < SWEEP.t0 || t > 66.4) return;
  const fade = 1 - ramp(t, 65.2, 66.4);
  const k = wallOf[i];
  if (k === 0 || k === 1) {
    // Wedge A's walls take the hit: an amber contact flash as the sweep lands.
    const th = wallHitTime(k);
    p.glow = Math.max(p.glow, Math.exp(-Math.max(0, t - th) * 2.5) * (t > th ? 0.9 : 0) * fade);
    p.hue = 1;
    return;
  }
  if (L.wedgeOf[i] !== 0) return;
  const d = angDiff(L.slots[i].deg, SWEEP.from);
  const lo = angDiff(WALL_ANGLES[0], SWEEP.from), hi = angDiff(WALL_ANGLES[1], SWEEP.from);
  const sp = sweepSpread(t);
  const reach = d < 0 ? Math.max(lo, -sp) : Math.min(hi, sp);
  const inside = d < 0 ? d >= reach : d <= reach;
  if (!inside) return;
  const edge = Math.abs(d - reach);
  const on = 0.4 + 0.4 * Math.exp(-Math.pow(edge / 6, 2));
  p.glow = Math.max(p.glow, on * fade);
}

// Ripples: lift and light running out from the core when it ignites, when
// the answer lands, and when the mark forms.
const RIPPLES = [26.9, 37.95, 69.9];
function applyRipple(i, t, p) {
  for (const t0 of RIPPLES) {
    const u = t - t0;
    if (u < 0 || u > 2.2) continue;
    const dist = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
    const r = CORE_R + u * 620;
    const env = Math.exp(-Math.pow((dist - r) / 70, 2)) * Math.exp(-u * 1.1);
    p.z += 12 * env;
    // The end-slate ripple only lifts: cobalt light over the persimmon sheet reads pink.
    if (t0 < 60) p.glow = Math.max(p.glow, 0.3 * env);
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
  post: { exposure: 1, bloom: 0.6, vignette: 0.35, grain: 0.4, fade: 0 },
  haze: 0,
  tileEdge: 1,
};

export function frameState(tIn) {
  const t = Math.round(clamp(tIn, 0, DURATION) * 1e6) / 1e6;
  fs.t = t;
  fs.cam = cameraAt(t);

  // Frame reset of every field a scene may write.
  const dawn = ramp(t, 20.0, 23.2);
  fs.ground.ink = 1 - dawn;
  fs.ground.lines = ramp(t, 22.6, 26.0) * (1 - 0.65 * ramp(t, 67.5, 69.5));
  fs.ground.linesX = CENTER.x; fs.ground.linesY = CENTER.y;
  fs.light.warmth = dawn;
  fs.light.az = lerp(-2.6, -2.25, dawn);
  fs.light.el = lerp(0.42, 0.85, dawn);
  fs.light.intensity = lerp(0.9, 1.0, dawn);
  fs.shadow = lerp(0.65, 1, dawn);
  fs.post.exposure = 1 - 0.1 * ramp(t, 52.9, 53.5) * (1 - ramp(t, 56.8, 57.8));
  fs.post.bloom = lerp(0.9, 0.55, dawn);
  fs.post.vignette = lerp(0.5, 0.28, dawn);
  fs.post.grain = lerp(0.5, 0.32, dawn);
  fs.post.fade = Math.max(1 - ramp(t, 0, 1.4), REDUCED ? reducedDip(t) : 0);
  fs.haze = 0.0003 * (1 - dawn);
  fs.tileEdge = 1 - ramp(t, 69.0, 70.0);

  // Core.
  const c = fs.core;
  c.x = CENTER.x; c.y = CENTER.y;
  c.r = CORE_R * (1 + 0.28 * easeInOutCubic((t - 68.0) / 1.8));
  c.on = ramp(t, 25.8, 26.9);
  c.glow = 0.25 * c.on + 0.8 * pulse(t, 37.8, 39.6) + 0.25 * pulse(t, 33.9, 34.6) + 0.35 * ramp(t, 69.0, 70.5);
  c.dim = ramp(t, 52.9, 53.5) * (1 - ramp(t, 57.8, 58.8));

  // Waves.
  fs.waves.length = 0;
  for (const sr of SEARCHES) {
    if (t < sr.t0 || t > sr.t0 + sr.dur + 0.3) continue;
    const u = (t - sr.t0) / sr.dur;
    const inten = Math.sin(Math.PI * clamp(u * 0.95 + 0.05)) * (sr.hit ? 1 : 0.7);
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: waveRadius(sr, t), width: 16, intensity: inten, hue: 0 });
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: Math.max(WAVE_R0, waveRadius(sr, t) - 70), width: 44, intensity: inten * 0.3, hue: 0 });
  }
  if (t > EXACT_T0 && t < EXACT_T0 + 0.9) {
    const u = (t - EXACT_T0) / 0.9;
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: WAVE_R0 + u * 520, width: 5, intensity: 0.8 * Math.sin(Math.PI * u), hue: 1 });
  }

  // Tiles.
  for (let i = 0; i < N; i++) {
    basePose(i, t, O);
    if (i === FOCUS) applyFocus(t, O);
    if ((t > 34 && t < 38.2) || (t > 49.6 && t < 52.8)) applyRetrieval(i, t, O);
    if (i === HERO) applyHero(t, O);
    if (t > SWEEP.t0) applyScope(i, t, O);
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
  if (t > 37.2 && t < 37.95) {
    const k = HERO * STRIDE;
    fs.beams.push({ x0: tiles[k], y0: tiles[k + 1], z0: tiles[k + 2], x1: CENTER.x, y1: CENTER.y, z1: 30, width: 3, intensity: pulse(t, 37.2, 37.95), hue: 0 });
  }
  // The bar a passage must clear: a dashed amber ring floating over the archive.
  const bar = ramp(t, 49.3, 49.9) * (1 - ramp(t, 55.4, 56.2));
  if (bar > 0) {
    const n = 56;
    for (let j = 0; j < n; j++) {
      const a0 = (j / n) * TAU, a1 = a0 + (TAU / n) * 0.55;
      fs.beams.push({
        x0: CENTER.x + Math.cos(a0) * THRESH.r, y0: CENTER.y + Math.sin(a0) * THRESH.r, z0: THRESH.z,
        x1: CENTER.x + Math.cos(a1) * THRESH.r, y1: CENTER.y + Math.sin(a1) * THRESH.r, z1: THRESH.z,
        width: 7, intensity: bar * 1.3, hue: 1,
      });
    }
  }
  return fs;
}

// ---------------------------------------------------------------- 2D layer
function tileQuad(cam, i) {
  const k = i * STRIDE;
  const [x, y, z, rx, ry, rz, w, h] = [tiles[k], tiles[k + 1], tiles[k + 2], tiles[k + 3], tiles[k + 4], tiles[k + 5], tiles[k + 6], tiles[k + 7]];
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const rot = (u, v) => {
    const py = v * cx, pz0 = v * sx;
    const qx = u * cy + pz0 * sy, qz = -u * sy + pz0 * cy;
    return [qx * cz - py * sz, qx * sz + py * cz, qz];
  };
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => {
    const r = rot(u, v);
    const p = project(cam, x + r[0], y + r[1], z + r[2]);
    return [p.sx, p.sy];
  });
}

// Everything the viewer reads. `ui` is the ui.js module (may be null);
// `cam` is the frame's camera. Must run after frameState(t) for the same t.
export function drawUI(ctx, t, ui, cam) {
  const proj = (x, y, z = 0) => project(cam, x, y, z);
  drawVoice(ctx, t);
  if (!ui) return;
  const theme = t < 21.6 ? 'dark' : 'light';

  // The passage that flies past in the cold open carries the answer.
  if (t > 4.6 && t < 7.4 && ui.tileText) {
    ui.tileText(ctx, { quad: tileQuad(cam, FOCUS), lines: EXCERPT_LINES, alpha: ramp(t, 4.6, 5.0) * (1 - ramp(t, 7.0, 7.4)), ink: '#21201C' });
  }

  // Call bar: the cold open, then the payoff once the source is shown.
  const callA = ramp(t, 0.8, 1.6) * (1 - ramp(t, 18.6, 19.4)) + ramp(t, 31.2, 32.0) * (1 - ramp(t, 45.8, 46.6));
  if (callA > 0.001) {
    const secs = 41 + Math.floor(t < 21 ? t : 21 + (t - 19) * 0.5);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    ui.callBar(ctx, {
      x: 96, y: 64, t, timer: `${mm}:${ss}`,
      status: t > 41.4 && t < 47 ? 'answered' : 'live',
      statusProgress: t > 41.4 ? easeOutQuart((t - 41.4) / 0.5) : 1,
      caller: t < 21 ? COPY.caller : null,
      callerProgress: clamp((t - 1.8) / 2.6),
      alpha: callA, theme: t < 21 ? 'dark' : 'light',
    });
  }

  // The stakes: two bare answers, indistinguishable, neither with a source.
  const gA = ramp(t, 10.6, 11.4), gB = ramp(t, 11.0, 11.8);
  const gOut = 1 - ramp(t, 17.8, 18.6);
  if (gA * gOut > 0.001) {
    const drift = ramp(t, 17.8, 18.6) * 14;
    ui.guessCard(ctx, { x: 520, y: 330 + drift, w: 380, h: 250, text: '$5', kicker: 'No source', alpha: gA * gOut, progress: easeOutQuart((t - 10.6) / 0.8), crack: 0, theme: 'light' });
    ui.guessCard(ctx, { x: 1020, y: 330 + drift, w: 380, h: 250, text: '$15', kicker: 'No source', alpha: gB * gOut, progress: easeOutQuart((t - 11.0) / 0.8), crack: 0, theme: 'light' });
  }

  // The turn: titles ride above the pages, then the cut.
  if (t > 19.3 && t < 24.2) {
    const la = ramp(t, 19.9, 20.5) * (1 - ramp(t, 23.0, 23.6));
    for (let pg = 0; pg < 2; pg++) {
      const side = pg === 0 ? -1 : 1;
      const inU = easeOutQuart((t - 19.3 - pg * 0.25) / 1.6);
      const top = proj(960 + side * 250 + side * (1 - inU) * 1300, 600 - 3.4 * 43 * Math.cos(-0.55), 150 - 3.4 * 43 * Math.sin(-0.55) + 40);
      if (la > 0.001) ui.label(ctx, { text: pg === 0 ? COPY.doc1 : COPY.doc2, x: top.sx, y: top.sy - 24, t: 1, t0: 0, t1: 99, theme, align: 'center', size: 18, alpha: la });
    }
    ui.label(ctx, { text: 'Approved documents', x: 960, y: 150, t, t0: 20.1, t1: 21.5, theme, align: 'center', size: 18, swatch: 'cobalt' });
    ui.label(ctx, { text: 'Split into passages', x: 960, y: 150, t, t0: 21.5, t1: 23.6, theme, align: 'center', size: 18, swatch: 'cobalt' });
  }

  // Ask: composer, then the search, told where it happens.
  const compA = ramp(t, 31.2, 31.8) * (1 - ramp(t, 37.2, 37.7)) + ramp(t, 46.8, 47.4) * (1 - ramp(t, 52.6, 53.2));
  const q = t < 46.7 ? COPY.q1 : COPY.q2;
  const typeStart = t < 46.7 ? 31.6 : 47.2;
  const chars = Math.floor(clamp((t - typeStart) / 2.0) * q.length);
  const pressAt = t < 46.7 ? 33.8 : 49.4;
  const cleared = (t > pressAt + 0.25 && t < 46.7) || t > pressAt + 0.25;
  if (compA > 0.001) {
    ui.composer(ctx, {
      x: 96, y: 790, w: 700, text: cleared ? '' : q, chars: cleared ? 0 : chars,
      caretOn: Math.floor(t * 2) % 2 === 0, alpha: compA, theme: 'light', progress: easeOutQuart((t - (t < 46.7 ? 31.2 : 46.8)) / 0.6),
      press: pulse(t, pressAt - 0.1, pressAt + 0.3),
    });
  }
  const wa = (-20 * Math.PI) / 180;
  const wp = proj(CENTER.x + Math.cos(wa) * 470, CENTER.y + Math.sin(wa) * 470, 0);
  ui.label(ctx, { text: 'Meaning', x: wp.sx + 30, y: wp.sy - 70, tick: { x: wp.sx, y: wp.sy }, t, t0: 34.4, t1: 36.9, theme: 'light', size: 18, swatch: 'cobalt' });
  const ek = L.exact[1] ?? L.exact[0];
  const ep = proj(L.slots[ek].x, L.slots[ek].y, 20);
  ui.label(ctx, { text: 'Exact words', x: ep.sx + 40, y: ep.sy + 70, tick: { x: ep.sx, y: ep.sy }, t, t0: 35.3, t1: 36.9, theme: 'light', size: 18, swatch: 'amber' });
  const hs = proj(L.slots[HERO].x, L.slots[HERO].y, 160);
  ui.label(ctx, { text: 'Best passage', x: hs.sx - 60, y: hs.sy - 60, tick: { x: hs.sx, y: hs.sy }, t, t0: 36.4, t1: 37.4, theme: 'light', size: 18, align: 'right', swatch: 'cobalt' });

  // The answer, then its receipt: the passage unfolds into the source panel.
  if (t > 37.9 && t < 46.7) {
    const aA = 1 - ramp(t, 45.6, 46.4);
    const card = ui.answerCard(ctx, {
      x: 96, y: 250, w: 700, question: COPY.q1, answer: COPY.a1, citeIndex: 1, docTitle: COPY.doc1,
      progress: easeOutQuart((t - 38.0) / 0.5), receiptProgress: easeOutQuart((t - 38.7) / 0.5),
      chipHot: ramp(t, 39.2, 39.6) * (1 - ramp(t, 44.6, 45.4)), alpha: aA, theme: 'light',
    });
    const pa = ramp(t, 40.7, 41.0) * (1 - ramp(t, 45.2, 45.5));
    if (pa > 0.001) {
      const tl = proj(PANEL.x - PANEL.w / 2, PANEL.y - PANEL.h / 2, PANEL.z);
      const br = proj(PANEL.x + PANEL.w / 2, PANEL.y + PANEL.h / 2, PANEL.z);
      const panel = ui.citationPanel(ctx, {
        x: tl.sx, y: tl.sy, w: br.sx - tl.sx, h: br.sy - tl.sy, docTitle: COPY.doc1, section: 'Standard Fees',
        rows: EXCERPT_ROWS, highlightRow: 1, progress: easeOutQuart((t - 40.7) / 0.5), alpha: pa, surface: false,
      });
      const anchor = card && (card.chipAnchor || card.chipCenter);
      const target = panel && (panel.rowAnchor || (panel.row && { x: panel.row.x - 8, y: panel.row.y + panel.row.h / 2 }));
      if (anchor && target) drawThread(ctx, anchor, target, pa, clamp((t - 41.0) / 0.6));
    }
  }

  // The stop: the bar, the fall short, the refusal, the gap.
  const bp = proj(CENTER.x + Math.cos(2.7) * THRESH.r, CENTER.y + Math.sin(2.7) * THRESH.r, THRESH.z);
  ui.label(ctx, { text: 'Minimum match', x: bp.sx + 36, y: bp.sy + 54, tick: { x: bp.sx, y: bp.sy }, t, t0: 49.9, t1: 52.1, theme: 'light', size: 18, swatch: 'amber' });
  ui.label(ctx, { text: 'No passage matched well enough', x: bp.sx + 36, y: bp.sy + 54, tick: { x: bp.sx, y: bp.sy }, t, t0: 52.2, t1: 55.4, theme: 'light', size: 18, swatch: 'amber' });
  if (t > 53.4 && t < 58.7) {
    const ra = ramp(t, 53.5, 53.9) * (1 - ramp(t, 57.9, 58.6));
    const rc = ui.refusalCard(ctx, { x: 96, y: 130, w: 760, question: COPY.q2, answer: COPY.refusal, hint: COPY.refusalHint, progress: easeOutQuart((t - 53.5) / 0.5), alpha: ra, flagged: false });
    const bottom = rc && rc.rect ? rc.rect.y + rc.rect.h : 470;
    if (t > 55.6) {
      const u = easeOutQuart((t - 55.7) / 0.7);
      const ga = ramp(t, 55.7, 56.1) * (1 - ramp(t, 57.9, 58.6));
      ui.label(ctx, { text: 'Logged in Content gaps for review', x: 96, y: bottom + 40, t, t0: 55.9, t1: 58.6, theme: 'light', size: 18, align: 'left' });
      ui.gapItem(ctx, { x: 96, y: bottom + 70 + (1 - u) * 16, w: 760, question: COPY.q2, progress: u, alpha: ga });
    }
  }

  // Program scope tags, one per wedge.
  if (t > 60.2 && t < 67.4) {
    const ta = ramp(t, 60.4, 61.0) * (1 - ramp(t, 66.4, 67.2));
    const hues = [262, 48, 168];
    L.WEDGES.forEach((w, k) => {
      const m = (((w.a0 + w.a1) / 2) * Math.PI) / 180;
      const p = proj(CENTER.x + Math.cos(m) * 560, CENTER.y + Math.sin(m) * 560, 0);
      ui.programTag(ctx, { x: p.sx, y: p.sy, name: w.name, hue: hues[k], alpha: ta, theme: 'light' });
    });
  }

  // Statements.
  for (const s of STATEMENTS) {
    if (t < s.t0 - 0.05 || t > s.t1 + 0.05) continue;
    ui.statement(ctx, { ...s, size: s.align === 'left' ? 60 : 66, maxWidth: s.maxWidth ?? 1400, t });
  }

  // End slate: the mark is tiles and the lens; the layer adds the T and the words.
  if (t > 69.4) {
    const m = proj(MARK.x, MARK.y, 0);
    ui.lockup(ctx, {
      x: m.sx, y: m.sy, scale: (m.scale * MARK.size) / 330, markAlpha: 0, tAlpha: ramp(t, 69.8, 70.6),
      wordAlpha: ramp(t, 70.4, 71.4), tagline: COPY.tagline, taglineAlpha: ramp(t, 71.2, 72.1),
      url: COPY.url, urlAlpha: ramp(t, 72.0, 72.8), theme: 'light', layout: 'horizontal',
    });
  }
}

// The caller's voice: a thin line across the lower frame, driven by a
// deterministic speech envelope.
function drawVoice(ctx, t) {
  const a = ramp(t, 0.6, 1.4) * (1 - ramp(t, 5.0, 6.2));
  if (a <= 0.001) return;
  const speaking = (u) => pulse(u, 1.8, 4.6) * (0.6 + 0.4 * Math.sin(u * 7.1) * Math.sin(u * 3.3));
  ctx.save();
  ctx.globalAlpha = a * 0.8;
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(233, 226, 210, 0.75)';
  ctx.shadowColor = 'rgba(160, 190, 255, 0.55)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  const y0 = 1030;
  for (let x = 0; x <= 1920; x += 6) {
    const env = Math.exp(-Math.pow((x - 960) / 520, 2));
    const s = speaking(t);
    const v = Math.sin(x * 0.045 + t * 9) * 0.6 + Math.sin(x * 0.11 - t * 13) * 0.3 + Math.sin(x * 0.021 + t * 4) * 0.5;
    const y = y0 + v * env * (2 + s * 22);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// A cobalt thread from the citation chip to the source line; a point of light
// runs along it from the source to the chip once it has drawn.
function drawThread(ctx, chip, row, a, draw) { // row: {x, y} anchor point
  if (a <= 0.001 || draw <= 0) return;
  const x0 = chip.x, y0 = chip.y;
  const x1 = row.x, y1 = row.y;
  const mx = (x0 + x1) / 2;
  const bez = (u) => {
    const v = 1 - u;
    return [v * v * v * x0 + 3 * v * v * u * mx + 3 * v * u * u * mx + u * u * u * x1, v * v * v * y0 + 3 * v * v * u * y0 + 3 * v * u * u * y1 + u * u * u * y1];
  };
  const d = easeOutCubic(draw);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = 'rgba(0, 64, 171, 0.9)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.shadowColor = 'rgba(0, 93, 229, 0.55)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  for (let k = 0; k <= 40; k++) {
    const p = bez((k / 40) * d);
    if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
  ctx.fillStyle = 'rgba(0, 64, 171, 1)';
  const e = bez(d);
  ctx.beginPath(); ctx.arc(e[0], e[1], 4.5, 0, TAU); ctx.fill();
  ctx.restore();
}
