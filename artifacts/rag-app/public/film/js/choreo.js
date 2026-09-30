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
  tagline: 'A cited answer, or a clear no',
  url: 'truenote.org',
};

// The seeded Cancellation Policy passage (scripts/src/seed.ts), raw markdown as
// the citation panel shows it: segments joined with a blank line.
const EXCERPT_LINES = ['## Standard Fees', '', '| Plan | Cancellation Fee |', '| --- | --- |', '| Basic | $5 |', '| Pro | $10 |', '| Enterprise | $25 |'];
const EXCERPT = EXCERPT_LINES.join('\n');

export const STATEMENTS = [
  { text: 'The answer is in here, somewhere', accent: [5], t0: 6.4, t1: 10.5, x: 960, y: 866, align: 'center', theme: 'dark' },
  { text: 'A guess sounds exactly like an answer', accent: [3], t0: 13.6, t1: 18.0, x: 960, y: 880, align: 'center', theme: 'dark' },
  { text: 'Only your approved documents can support an answer', accent: [2], t0: 27.0, t1: 31.6, x: 110, y: 520, align: 'left', maxWidth: 720, theme: 'light' },
  { text: 'Every answer shows its receipt', accent: [4], t0: 41.8, t1: 45.6, x: 96, y: 905, align: 'left', maxWidth: 1300, theme: 'light' },
  { text: 'When the documents stop, Truenote stops', accent: [5], t0: 54.8, t1: 58.5, x: 96, y: 905, align: 'left', maxWidth: 860, theme: 'light' },
  { text: "A rep's search never reaches another program", accent: [3], t0: 62.2, t1: 66.6, x: 960, y: 945, align: 'center', maxWidth: 1700, theme: 'light' },
];

// Timed labels, so their reading budget is checked with the statements.
export const LABELS = [
  { text: 'Approved documents', t0: 20.1, t1: 21.8 },
  { text: 'Split into passages', t0: 21.8, t1: 23.6 },
  { text: 'Meaning', t0: 34.4, t1: 35.95 },
  { text: 'Exact words', t0: 35.3, t1: 36.9 },
  { text: 'Best passage', t0: 36.2, t1: 37.8 },
  { text: 'Minimum match', t0: 49.9, t1: 52.1 },
  { text: 'No passage matched well enough', t0: 52.2, t1: 54.9 },
  { text: 'Logged in Content gaps for review', t0: 55.9, t1: 58.6 },
];

export function captions() {
  return [...STATEMENTS, ...LABELS].map((s) => ({ text: s.text, t0: s.t0, t1: s.t1 }));
}
const labelWin = (text) => LABELS.find((l) => l.text === text);

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
const mixCol = (p, c, k) => { p.r = lerp(p.r, c[0], k); p.g = lerp(p.g, c[1], k); p.b = lerp(p.b, c[2], k); };
const AMBER = [0.961, 0.624, 0.039];
const CARD = [0.992, 0.992, 0.988];
// The lens bezel reaches 1.35 x core radius; rings, waves and ripples start there.
const RIM = CORE_R * 1.35;

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
const weakRank = new Int8Array(N).fill(-1);
L.weak.forEach((i, k) => { weakRank[i] = k; });

// Storm tiles with a special role in the open and the stakes.
function special(skip) {
  for (let i = 0; i < N; i++) if (L.slots[i].field && L.docOf[i] < 0 && L.mark.markOf[i] < 0 && !skip.includes(i)) return i;
  return 0;
}
const FOCUS = special([]);
const WHIP = special([FOCUS]);
const GUESS0 = special([FOCUS, WHIP]);
const GUESS = [GUESS0, special([FOCUS, WHIP, GUESS0])];

// Program walls: tiles lying on the three wedge boundaries stand up as palisades.
const WALL_ANGLES = L.WEDGES.map((w) => w.a0);
const wallOf = new Int8Array(N).fill(-1);
for (let i = 0; i < N; i++) {
  const s = L.slots[i];
  if (i === HERO || L.docOf[i] >= 0 || s.r < RIM) continue;
  for (let k = 0; k < 3; k++) if (Math.abs(angDiff(s.deg, WALL_ANGLES[k])) < 1.8) wallOf[i] = k;
}

// End slate: every tile folds into the mark; tiles without their own cell
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
// Keys: t, eye, target, fov, roll (or an explicit up vector). Segments ease
// in-out between consecutive keys; the up vector is interpolated and renormalised.
const CAM_KEYS = [
  { t: 0, e: [930, 1560, 250], g: [960, 640, 210], fov: 38 },
  { t: 8.5, e: [1080, 1950, 1250], g: [960, 560, 120], fov: 34 },
  { t: 18.6, e: [1020, 1880, 1180], g: [960, 590, 130], fov: 33 },
  { t: 20.8, e: [980, 1760, 760], g: [960, 610, 150], fov: 32 },
  { t: 22.6, e: [990, 1740, 760], g: [960, 600, 120], fov: 32, r: -0.22 },
  { t: 26.2, e: [770, 720, 2200], g: [770, 540, 0], fov: 30 },
  { t: 27.4, e: [760, 700, 2200], g: [760, 540, 0], fov: 30 },
  { t: 31.0, e: [745, 690, 2180], g: [745, 540, 0], fov: 30, r: 0.03 },
  // The search, seen low across the paper so the waves roll toward us.
  { t: 33.8, e: [820, 2060, 700], g: [980, 470, 0], fov: 34 },
  { t: 36.4, e: [720, 1440, 560], g: [860, 700, 60], fov: 34 },
  { t: 37.9, e: [880, 1240, 920], g: [960, 560, 30], fov: 33 },
  // Overhead for the receipt: the panel is drawn over the unfolded tile.
  { t: 40.4, e: [700, 540, 1830], g: [700, 540, 0], fov: 30 },
  { t: 45.5, e: [700, 540, 1810], g: [700, 540, 0], fov: 30 },
  { t: 47.0, e: [740, 800, 2150], g: [740, 540, 0], fov: 30 },
  // The second search, from the other side; then a held stop.
  { t: 49.3, e: [740, 800, 2150], g: [740, 540, 0], fov: 30 },
  { t: 50.6, e: [-260, 1000, 820], g: [880, 560, 20], fov: 34, up: [0, 0, 1] },
  { t: 52.2, e: [-220, 980, 830], g: [880, 560, 20], fov: 34, up: [0, 0, 1] },
  { t: 52.9, e: [-220, 980, 830], g: [880, 560, 20], fov: 34, up: [0, 0, 1] },
  { t: 56.8, e: [720, 760, 2150], g: [720, 540, 0], fov: 30 },
  { t: 58.4, e: [730, 780, 2160], g: [730, 540, 0], fov: 30 },
  { t: 60.6, e: [960, 1560, 2700], g: [960, 560, 0], fov: 30 },
  { t: 66.4, e: [930, 1520, 2620], g: [960, 560, 0], fov: 30, r: 0.05 },
  { t: 67.6, e: [960, 800, 2500], g: [960, 540, 0], fov: 30 },
  { t: 69.8, e: [1546, 634, 2600], g: [1546, 634, 0], fov: 30 },
  { t: DURATION, e: [1546, 634, 2500], g: [1546, 634, 0], fov: 30 },
];

// prefers-reduced-motion: no camera travel, no vortex spin, no tumbling, no
// handheld breath. The camera holds one pose per act and changes only under a
// short dissolve through the scene's own colour; every caption and state stays.
let REDUCED = false;
export function setReducedMotion(on) { REDUCED = !!on; }
export function isReduced() { return REDUCED; }
const REDUCED_CUTS = [22.9, 46.9, 58.6, 67.2];
const RC_GATHER = 22.9, RC_MARK = 67.2;
const REDUCED_POSES = [
  { e: [1080, 1950, 1250], g: [960, 560, 120], fov: 34 },
  { e: [700, 540, 1830], g: [700, 540, 0], fov: 30 },
  { e: [-220, 980, 830], g: [880, 560, 20], fov: 34, up: [0, 0, 1] },
  { e: [960, 1560, 2700], g: [960, 560, 0], fov: 30 },
  { e: [1546, 634, 2560], g: [1546, 634, 0], fov: 30 },
];
export function reducedDip(t) {
  if (!REDUCED) return 0;
  let d = 0;
  for (const c of REDUCED_CUTS) d = Math.max(d, clamp((0.5 - Math.abs(t - c)) / 0.35));
  return smooth(d);
}

function setCam(cam, e, g, r = 0, up = null) {
  cam.x = e[0]; cam.y = e[1]; cam.z = e[2];
  cam.tx = g[0]; cam.ty = g[1]; cam.tz = g[2];
  if (up) { const l = Math.hypot(...up); cam.ux = up[0] / l; cam.uy = up[1] / l; cam.uz = up[2] / l; }
  else { cam.ux = Math.sin(r); cam.uy = -Math.cos(r); cam.uz = 0; }
  return cam;
}
const keyUp = (k) => k.up ?? [Math.sin(k.r ?? 0), -Math.cos(k.r ?? 0), 0];

export function cameraAt(t) {
  if (REDUCED) {
    let k = 0;
    while (k < REDUCED_CUTS.length && t >= REDUCED_CUTS[k]) k++;
    const p = REDUCED_POSES[k];
    return setCam(defaultCam(p.fov), p.e, p.g, 0, p.up ?? null);
  }
  let k = 0;
  while (k < CAM_KEYS.length - 2 && t >= CAM_KEYS[k + 1].t) k++;
  const a = CAM_KEYS[k], b = CAM_KEYS[k + 1];
  const u = easeInOutCubic((t - a.t) / (b.t - a.t));
  const cam = defaultCam(lerp(a.fov, b.fov, u));
  const e = [0, 1, 2].map((j) => lerp(a.e[j], b.e[j], u));
  const g = [0, 1, 2].map((j) => lerp(a.g[j], b.g[j], u));
  if (a.up || b.up) { const ua = keyUp(a), ub = keyUp(b); setCam(cam, e, g, 0, [0, 1, 2].map((j) => lerp(ua[j], ub[j], u))); }
  else setCam(cam, e, g, lerp(a.r ?? 0, b.r ?? 0, u));
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

// Place a tile in camera space: screen point (sx, sy) in design px at distance d,
// facing the lens with a yaw, sized to (pw, ph) design px.
function placeInView(p, t, sx, sy, d, pw, ph, yaw = 0, roll = 0) {
  const cam = cameraAt(t);
  const { f, r, u } = camBasis(cam);
  const k = (d * Math.tan((cam.fov * Math.PI) / 360)) / 540;
  const x = (sx - 960) * k, y = -(sy - 540) * k;
  p.x = cam.x + f[0] * d + r[0] * x + u[0] * y;
  p.y = cam.y + f[1] * d + r[1] * x + u[1] * y;
  p.z = cam.z + f[2] * d + r[2] * x + u[2] * y;
  const n = [-f[0] + r[0] * yaw, -f[1] + r[1] * yaw, -f[2] + r[2] * yaw];
  const nl = Math.hypot(...n);
  p.rx = Math.asin(clamp(-n[1] / nl, -1, 1));
  p.ry = Math.atan2(n[0] / nl, n[2] / nl);
  p.rz = roll;
  p.w = pw * k; p.h = ph * k;
}

// ---------------------------------------------------------------- poses
function P() { return { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, w: 10, h: 10, r: 1, g: 1, b: 1, a: 1, lines: 0, glow: 0, hue: 0 }; }
const A = P(), B = P(), O = P(), A0 = P(), G = P(), GR = P();

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
  const clear = REDUCED ? 0 : ramp(t, 18.8, 21.4);
  const rho = (190 + 1280 * Math.pow(R0[i], 0.72)) * (1 + 0.55 * clear);
  const arm = Math.floor(R1[i] * 3);
  const th0 = (arm * TAU) / 3 + Math.log(rho / 190) * 1.35 + (R2[i] - 0.5) * 1.1;
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

// Cold open, first event: one sheet whips across the lens as the light comes on.
function applyWhip(t, p) {
  if (REDUCED || t < 0.05 || t > 1.15) { if (t < gatherStart(WHIP)) p.a = 0; return; }
  const u = clamp((t - 0.05) / 1.1);
  placeInView(p, t, lerp(2500, -700, easeInOutSine(u)), 470 + 120 * Math.sin(u * 3), 330, 520, 380, (u - 0.5) * 1.6, 0.4 - u * 0.5);
  const c = COLORS.paperWarm;
  p.r = c[0]; p.g = c[1]; p.b = c[2]; p.lines = 1; p.glow = 0; p.a = 1;
}

// Cold open, the plant: a passage carrying the answer drifts toward the lens,
// turns as it passes (legible around 5 to 6.7 s), then leaves the frame.
function applyFocus(t, p) {
  if (t < 3.6 || t > 7.8) { if (t < gatherStart(FOCUS)) p.a = 0; return; }
  const c = COLORS.paper;
  if (REDUCED) {
    placeInView(p, t, 820, 330, 620, 380, 264, 0, 0);
    p.r = c[0]; p.g = c[1]; p.b = c[2]; p.lines = 0; p.glow = 0.7; p.hue = 2;
    p.a = ramp(t, 4.4, 5.0) * (1 - ramp(t, 6.8, 7.4));
    return;
  }
  const u = (t - 3.6) / 4.2;
  // Approach and slow near the lens (u 0 to 0.52), then accelerate out.
  const near = u < 0.52;
  const ua = easeOutCubic(u / 0.52), ub = easeInCubic((u - 0.52) / 0.48);
  const sx = near ? lerp(1500, 860, ua) : lerp(860, -700, ub);
  const sy = near ? lerp(320, 400, ua) : lerp(400, 450, (u - 0.52) / 0.48);
  const d = near ? lerp(1500, 600, ua) : lerp(600, 420, ub);
  placeInView(p, t, sx, sy, d, 400, 278, lerp(0.75, -0.55, easeInOutSine(u)), 0.1 * Math.sin(u * 3.2));
  p.r = c[0]; p.g = c[1]; p.b = c[2]; p.lines = 0; p.a = 1;
  p.glow = 0.7 * ramp(t, 4.4, 5.0) * (1 - ramp(t, 7.2, 7.7)); p.hue = 2;
}

// The stakes: two passages leave the storm and turn into the two bare answers.
const GUESS_CARDS = [{ x: 520, y: 330, w: 380, h: 250 }, { x: 1020, y: 330, w: 380, h: 250 }];
function applyGuess(k, t, p) {
  const gi = GUESS[k];
  if (t < 9.9) return;
  if (t > 11.6 || REDUCED) { if (t < gatherStart(gi)) p.a = 0; return; }
  const c = GUESS_CARDS[k];
  const t0 = 9.9 + k * 0.3;
  const u = easeInOutCubic((t - t0) / 0.9);
  placeInView(G, t, c.x + c.w / 2, c.y + c.h / 2, 700, c.w, c.h, 0, 0);
  // Targets unwrapped once against the storm pose at the turn's start.
  poseStorm(gi, t0, GR);
  const un = (tgt, r0) => tgt + TAU * Math.round((r0 - tgt) / TAU);
  p.x = lerp(p.x, G.x, u); p.y = lerp(p.y, G.y, u); p.z = lerp(p.z, G.z, u);
  p.rx = lerp(p.rx, un(G.rx, GR.rx), u);
  p.ry = lerp(p.ry, un(G.ry + Math.PI, GR.ry) - Math.PI * u, u);
  p.rz = lerp(p.rz, un(G.rz, GR.rz), u);
  p.w = lerp(p.w, G.w, u); p.h = lerp(p.h, G.h, u);
  mixCol(p, CARD, u); p.lines = 1 - u;
  p.a = 1 - ramp(t, 10.9 + k * 0.3, 11.2 + k * 0.3);
}

// The search for a source: each card sends five threads down into the storm.
// Targets are storm passages below the card (screen y 640 to 790, above the
// statement), picked from the pose at 14.6 s once per motion mode.
const THREAD_T = 14.6;
const threadCache = {};
function threadTiles() {
  const key = REDUCED ? 'r' : 'f';
  if (threadCache[key]) return threadCache[key];
  const cam = cameraAt(THREAD_T);
  const cand = [];
  for (let i = 0; i < N; i++) {
    if (L.docOf[i] >= 0 || i === FOCUS || i === WHIP || GUESS.includes(i) || i === HERO) continue;
    if (gatherStart(i) < 22 || R1[i] < 0.1 || R1[i] > 0.93) continue;
    poseStorm(i, THREAD_T, G);
    const pr = project(cam, G.x, G.y, G.z);
    if (pr.depth > 50 && pr.sy > 640 && pr.sy < 790) cand.push({ i, sx: pr.sx, sy: pr.sy });
  }
  const used = new Set();
  const out = GUESS_CARDS.map((c, k) => [-170, -85, 0, 85, 170].map((dx, j) => {
    const tx = c.x + c.w / 2 + dx, ty = 700 + ((j + k) % 2) * 50;
    let best = null, bd = Infinity;
    for (const q of cand) {
      if (used.has(q.i)) continue;
      const d = Math.hypot(q.sx - tx, q.sy - ty);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) used.add(best.i);
    return best ? best.i : -1;
  }));
  threadCache[key] = out;
  return out;
}
const threadArrive = (k, j) => 14.5 + j * 0.1 + k * 0.05;
const DIM = [0.3, 0.31, 0.35];
function applyThreadTile(i, t, p) {
  const tt = threadTiles();
  let k = -1, j = -1;
  for (let a = 0; a < 2 && k < 0; a++) { const b = tt[a].indexOf(i); if (b >= 0) { k = a; j = b; } }
  if (k < 0) return;
  const ta = threadArrive(k, j);
  const g = 0.9 * pulse(t, ta, ta + 0.8);
  if (g > p.glow) { p.glow = g; p.hue = 2; }
  const back = easeInOutCubic((t - 17.4) / 0.8);
  if (!REDUCED) {
    const flip = easeInOutCubic((t - ta - 0.2) / 0.5) - back;
    p.rx += Math.PI * flip;
    p.lines *= 1 - flip;
  }
  mixCol(p, DIM, 0.55 * ramp(t, ta + 0.4, ta + 0.9) * (1 - back));
}

// Two document pages that arrive whole and are cut into 5 x 7 passages.
const PAGE = { cell: 42 };
function poseDoc(i, t, p) {
  const d = L.docs[L.docOf[i]];
  const side = d.page === 0 ? -1 : 1;
  const home = { x: 960 + side * 250, y: 600, z: 150 };
  const inU = easeOutQuart((t - 19.3 - d.page * 0.25) / 1.6);
  const cut = easeOutCubic((t - (21.8 + d.row * 0.12 + d.page * 0.05)) / 0.4);
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
  p.lines = 1; p.glow = 0.35 * pulse(t, 21.8 + d.row * 0.12, 22.25 + d.row * 0.12); p.hue = 0;
}

// Archive slot, with the program wedges and the inhale before the implosion.
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
    const H = 110;
    p.x = lerp(s.x, CENTER.x + Math.cos(a) * s.r, up);
    p.y = lerp(s.y, CENTER.y + Math.sin(a) * s.r, up);
    const dr = a - s.rz;
    p.rz = s.rz + (dr - Math.PI * Math.round(dr / Math.PI)) * up;
    p.rx = (Math.PI / 2) * up;
    p.w = lerp(s.w, Math.max(s.w, 20) * 1.2, up);
    p.h = lerp(s.h, H, up);
    p.z = lerp(s.z, H / 2 + 2, up);
    p.lines = lerp(s.lines, 0.15, up);
    mixCol(p, COLORS.paperWarm, up * 0.6);
  }
  // Inhale: the whole archive lifts and breathes outward before it implodes.
  const inhale = REDUCED ? 0 : easeOutCubic((t - 67.0) / 0.8);
  if (inhale > 0) {
    p.x = CENTER.x + (p.x - CENTER.x) * (1 + 0.05 * inhale);
    p.y = CENTER.y + (p.y - CENTER.y) * (1 + 0.05 * inhale);
    p.z += 60 * inhale;
  }
}

function poseMark(i, t, p) {
  const c = CELLS[markCell[i]];
  const layer = markLayer[i];
  p.x = c.x; p.y = c.y; p.z = c.z - layer * 1.2;
  p.rx = 0; p.ry = 0; p.rz = c.rz;
  p.w = c.w * (layer > 0 ? 0.9 : 1.05); p.h = c.h * (layer > 0 ? 0.9 : 1.05);
  const col = COLORS[c.colKey];
  p.r = col[0]; p.g = col[1]; p.b = col[2];
  // The tile mosaic hands over to the drawn sheets (ui lockup): sheets 68.95 to 69.3, tiles out by 69.35.
  p.a = 1 - ramp(t, 69.0, 69.35);
  p.lines = 0.1; p.glow = 0; p.hue = 0;
}

// Blend two poses. `ref` (optional) is pose A at the transition's start: target
// angles are unwrapped against it once, so a spinning source never re-picks
// its direction mid-flight.
function blend(a, b, u, i, lift, out, ref = null) {
  const up = easeInOutSine(u);
  out.x = lerp(a.x, b.x, up);
  out.y = lerp(a.y, b.y, up);
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const arc = Math.sin(Math.PI * up) * (R3[i] - 0.5) * 2 * Math.min(180, len * 0.25);
  out.x += (-dy / len) * arc;
  out.y += (dx / len) * arc;
  const zu = backOut(u, 0.7);
  out.z = lerp(a.z, b.z, zu) + Math.sin(Math.PI * clamp(u)) * lift;
  if (REDUCED) { out.rx = b.rx; out.ry = b.ry; out.rz = b.rz; }
  else if (ref) {
    const un = (tgt, r0) => tgt + TAU * Math.round((r0 - tgt) / TAU);
    out.rx = lerp(a.rx, un(b.rx, ref.rx), up);
    out.ry = lerp(a.ry, un(b.ry, ref.ry), up);
    out.rz = lerp(a.rz, un(b.rz, ref.rz), up);
  } else {
    out.rx = a.rx + wrap(b.rx - a.rx) * up;
    out.ry = a.ry + wrap(b.ry - a.ry) * up;
    out.rz = a.rz + wrap(b.rz - a.rz) * up;
  }
  out.w = lerp(a.w, b.w, up); out.h = lerp(a.h, b.h, up);
  out.r = lerp(a.r, b.r, u); out.g = lerp(a.g, b.g, u); out.b = lerp(a.b, b.b, u);
  out.a = lerp(a.a, b.a, u); out.lines = lerp(a.lines, b.lines, u);
  out.glow = lerp(a.glow, b.glow, u); out.hue = lerp(a.hue, b.hue, u);
}

// Gather timing: the pages' passages file in first and seed the inner rings.
function gatherStart(i) {
  if (REDUCED) return RC_GATHER;
  const s = L.slots[i];
  const d = L.docOf[i];
  if (d >= 0) { const doc = L.docs[d]; return 22.6 + doc.row * 0.07 + doc.col * 0.03 + doc.page * 0.1; }
  return 23.2 + 2.0 * ((s.r - 232) / 588) + R3[i] * 0.45;
}
function gatherDur(i) { return L.docOf[i] >= 0 ? 1.4 : 1.5; }
function markStart(i) {
  const s = L.slots[i];
  return 67.8 + R2[i] * 0.25 + (s.field ? 0.08 : 0);
}
const MARK_DUR = 0.8;

function basePose(i, t, out) {
  const isDoc = L.docOf[i] >= 0;
  if (REDUCED) {
    if (t < RC_GATHER) { if (isDoc) poseDoc(i, t, out); else poseStorm(i, t, out); }
    else if (t < RC_MARK) poseArchive(i, t, out);
    else poseMark(i, t, out);
    return;
  }
  const g0 = gatherStart(i), gd = gatherDur(i);
  if (t < g0) {
    if (isDoc) poseDoc(i, t, out); else poseStorm(i, t, out);
    return;
  }
  const m0 = markStart(i);
  if (t < g0 + gd) {
    if (isDoc) { poseDoc(i, t, A); poseDoc(i, g0, A0); } else { poseStorm(i, t, A); poseStorm(i, g0, A0); }
    poseArchive(i, t, B);
    blend(A, B, (t - g0) / gd, i, isDoc ? 60 : 90 + R1[i] * 140, out, A0);
    return;
  }
  if (t < m0) { poseArchive(i, t, out); return; }
  if (t < m0 + MARK_DUR) {
    poseArchive(i, t, A); poseMark(i, t, B);
    const u = (t - m0) / MARK_DUR;
    // Implosion: accelerate in, spiralling around the core, and slam down.
    const ui = easeInCubic(u);
    blend(A, B, ui, i, 30, out);
    if (!REDUCED) {
      const sw = Math.sin(Math.PI * ui) * (0.9 + 0.6 * R1[i]);
      const dx = out.x - CENTER.x, dy = out.y - CENTER.y;
      out.x = CENTER.x + dx * Math.cos(sw) - dy * Math.sin(sw);
      out.y = CENTER.y + dx * Math.sin(sw) + dy * Math.cos(sw);
    }
    const cu = ramp(t, m0 + MARK_DUR * 0.6, m0 + MARK_DUR);
    out.r = lerp(A.r, B.r, cu); out.g = lerp(A.g, B.g, cu); out.b = lerp(A.b, B.b, cu);
    return;
  }
  poseMark(i, t, out);
  // Sheets land with a small spring.
  const land = t - m0 - MARK_DUR;
  if (land < 0.35) out.z += 10 * (1 - backOut(land / 0.35, 1.4));
}

// ---------------------------------------------------------------- retrieval
const SEARCHES = [
  { t0: 34.0, dur: 1.6, hit: true },
  { t0: 49.6, dur: 1.6, hit: false },
];
const WAVE_R0 = RIM, WAVE_R1 = 820;
function waveRadius(sr, t) { return WAVE_R0 + (WAVE_R1 - WAVE_R0) * easeOutCubic((t - sr.t0) / sr.dur); }
const EXACT_T0 = 35.2, EXACT_STEP = 0.08;
const THRESH = { r: 520, z: 200 };
const WEAK_Z = 84;
const WEAK_CARD = { w: 64, h: 50 };
// The bar rises 49.9 to 50.5 (after the question row settles) and is gone before the stop statement (54.8).
function barAmount(t) { return easeOutCubic((t - 49.9) / 0.6) * (1 - ramp(t, 54.3, 54.9)); }

// The exact-word hit the label points at: the first one (after the hero) that
// sits well inside the frame at 35.6 s, picked once per motion mode.
const exactTick = {};
function exactTickTile() {
  const key = REDUCED ? 'r' : 'f';
  if (exactTick[key] !== undefined) return exactTick[key];
  const cam = cameraAt(35.6);
  let pick = L.exact[1] ?? L.exact[0];
  for (const i of L.exact) {
    if (i === HERO) continue;
    const p = project(cam, L.slots[i].x, L.slots[i].y, L.slots[i].z + 40);
    if (p.depth > 0 && p.sx > 420 && p.sx < 1500 && p.sy > 260 && p.sy < 820) { pick = i; break; }
  }
  exactTick[key] = pick;
  return pick;
}

// A weak candidate's rise: up 50.8 to 51.9 (staggered), held, down from 52.9.
function weakRise(wk, t) {
  return easeOutCubic((t - 50.8 - wk * 0.08) / 0.8) * (1 - easeInOutCubic((t - 52.9 - wk * 0.03) / 0.6));
}

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
  }
  // Exact words: each hit snaps up and turns amber, one after another.
  const ek = exactRank[i];
  if (ek >= 0 && t > EXACT_T0 && t < 37.6) {
    const th = EXACT_T0 + ek * EXACT_STEP;
    if (t > th) {
      const k = Math.exp(-(t - th) * 3.2);
      const on = easeOutCubic((t - th) / 0.12) * (1 - ramp(t, 36.8, 37.4));
      p.z += 40 * on;
      mixCol(p, AMBER, on);
      p.glow = Math.max(p.glow, (0.35 + 0.65 * k) * (i === HERO ? 1 : 1 - ramp(t, 36.9, 37.5)));
      p.hue = Math.max(p.hue, on);
    }
  }
  // Rerank: the shortlist rises as a set, the best passage highest.
  const sk = shortRank[i];
  if (sk >= 0 && i !== HERO && t > 36.0 && t < 38.2) {
    const up = easeOutCubic((t - 36.0 - sk * 0.05) / 0.4) * (1 - easeInOutCubic((t - 37.1) / 0.7));
    p.z += up * (40 + (7 - sk) * 12);
    p.glow = Math.max(p.glow, up * 0.6);
  }
  // The refused question: weak candidates rise toward the bar, fall short, hold, settle.
  const wk = weakRank[i];
  if (wk >= 0 && t > 50.2 && t < 53.8) {
    const rise = weakRise(wk, t);
    if (rise > 0) {
      // Stand upright, turned toward the lens, and grow to a readable card.
      const cam = cameraAt(t);
      const rzF = Math.atan2(cam.y - p.y, cam.x - p.x) + Math.PI / 2;
      const a = L.slots[i].a;
      p.x = lerp(p.x, CENTER.x + Math.cos(a) * THRESH.r, rise);
      p.y = lerp(p.y, CENTER.y + Math.sin(a) * THRESH.r, rise);
      p.z = lerp(p.z, WEAK_Z, rise);
      p.rx = (Math.PI / 2) * rise; p.ry = 0;
      p.rz = p.rz + wrap(rzF - p.rz) * rise;
      p.w = lerp(p.w, WEAK_CARD.w, rise); p.h = lerp(p.h, WEAK_CARD.h, rise);
      // Ruled lines would run vertically on a standing card; show it plain paper.
      p.lines *= 1 - rise;
      mixCol(p, CARD, 0.85 * rise);
      p.glow = Math.max(p.glow, 0.5 * rise);
    }
  }
}

// The hero passage: lift, fly into the core, come back out, turn over and
// unfold into the citation panel, then return to its slot.
function applyHero(t, p) {
  if (t < 36.0 || t > 46.7) return;
  const s = L.slots[HERO];
  const home = { ...p };
  if (t < 39.0) {
    const lift = easeOutCubic((t - 36.0) / 0.6);
    const toCore = easeInOutCubic((t - 37.2) / 0.7);
    let x = home.x, y = home.y, z = home.z + lift * 170;
    const w = home.w * (1 + lift * 1.4), h = home.h * (1 + lift * 1.4);
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
  const flip = REDUCED ? 0 : easeInOutCubic((t - 39.4) / 0.8);
  const unfold = easeInOutCubic((t - 40.1) / 0.7);
  const back = easeInOutCubic((t - 45.4) / 1.2);
  p.a = ramp(t, 39.0, 39.15);
  let x = CENTER.x, y = CENTER.y + 40 * out, z = lerp(40, 190, out);
  let w = lerp(16, 120, out), h = lerp(16, 90, out);
  x = lerp(x, PANEL.x, unfold); y = lerp(y, PANEL.y, unfold); z = lerp(z, PANEL.z, unfold);
  w = lerp(w, PANEL.w, unfold); h = lerp(h, PANEL.h, unfold);
  p.rx = 0.35 * Math.sin(Math.PI * flip) * (1 - unfold);
  p.ry = TAU * flip;
  p.rz = 0;
  p.lines = 1 - unfold; p.glow = 0.7 * (1 - unfold) * out; p.hue = 0;
  const c = COLORS.paper;
  p.r = lerp(c[0], CARD[0], unfold); p.g = lerp(c[1], CARD[1], unfold); p.b = lerp(c[2], CARD[2], unfold);
  if (t > 45.2 && REDUCED) {
    if (t < 45.9) { p.x = PANEL.x; p.y = PANEL.y; p.z = PANEL.z; p.w = PANEL.w; p.h = PANEL.h; p.a = 1 - ramp(t, 45.2, 45.65); return; }
    p.x = s.x; p.y = s.y; p.z = s.z; p.w = s.w; p.h = s.h; p.rx = 0; p.ry = 0; p.rz = s.rz;
    p.r = s.col[0]; p.g = s.col[1]; p.b = s.col[2]; p.lines = s.lines; p.glow = 0; p.a = ramp(t, 45.95, 46.5);
    return;
  }
  if (t > 45.4) {
    x = lerp(PANEL.x, s.x, back); y = lerp(PANEL.y, s.y, back);
    z = lerp(PANEL.z, s.z, back) + Math.sin(Math.PI * back) * 60;
    w = lerp(PANEL.w, s.w, back); h = lerp(PANEL.h, s.h, back);
    p.rz = wrap(s.rz) * back; p.ry = 0; p.rx = 0; p.lines = lerp(0, s.lines, back); p.glow = 0; p.a = 1;
    p.r = lerp(CARD[0], s.col[0], back); p.g = lerp(CARD[1], s.col[1], back); p.b = lerp(CARD[2], s.col[2], back);
  }
  p.x = x; p.y = y; p.z = z; p.w = w; p.h = h;
}

// Program scope: a sweep inside Program A that runs to its walls and stops there.
const SWEEP = { t0: 61.4, from: -70, speed: 60 };
function wallHitTime(k) { return SWEEP.t0 + Math.abs(angDiff(WALL_ANGLES[k], SWEEP.from)) / SWEEP.speed; }
function applyScope(i, t, p) {
  if (t < SWEEP.t0 || t > 66.4) return;
  const fade = 1 - ramp(t, 65.2, 66.4);
  const k = wallOf[i];
  if (k === 0 || k === 1) {
    const th = wallHitTime(k);
    const hit = t > th ? Math.exp(-(t - th) * 2.2) : 0;
    mixCol(p, AMBER, 0.6 * hit * fade);
    p.glow = Math.max(p.glow, 0.9 * hit * fade);
    p.hue = 1;
    return;
  }
  if (L.wedgeOf[i] !== 0 || k >= 0) return;
  const d = angDiff(L.slots[i].deg, SWEEP.from);
  const lo = angDiff(WALL_ANGLES[0], SWEEP.from), hi = angDiff(WALL_ANGLES[1], SWEEP.from);
  const sp = Math.max(0, (t - SWEEP.t0) * SWEEP.speed);
  const reach = d < 0 ? Math.max(lo, -sp) : Math.min(hi, sp);
  const inside = d < 0 ? d >= reach : d <= reach;
  if (!inside) return;
  const edge = Math.abs(d - reach);
  const th = wallHitTime(d < 0 ? 0 : 1);
  const settle = t > th ? Math.exp(-(t - th) * 2.5) : 1;
  const on = (0.45 + 0.4 * settle * Math.exp(-Math.pow(edge / 6, 2))) * fade;
  // Swept passages lift to card white with a cobalt edge: light, not a tint.
  mixCol(p, CARD, 0.7 * on);
  p.glow = Math.max(p.glow, on * 0.8);
  p.z += 6 * on;
}

// Ripples: lift (and on the first two, light) running out from the core.
const RIPPLES = [26.9, 37.95, 68.6];
function applyRipple(i, t, p) {
  for (const t0 of RIPPLES) {
    const u = t - t0;
    if (u < 0 || u > 2.2) continue;
    const dist = Math.hypot(p.x - CENTER.x, p.y - CENTER.y);
    const r = RIM + u * 700;
    const env = Math.exp(-Math.pow((dist - r) / 70, 2)) * Math.exp(-u * 1.1);
    if (!REDUCED) p.z += 12 * env;
    if (t0 < 60) p.glow = Math.max(p.glow, 0.3 * env);
  }
}

// ---------------------------------------------------------------- frame state
const INK = [0.043, 0.063, 0.125], CREAM = [0.91, 0.902, 0.871];
const fs = {
  t: 0, cam: null, tiles, count: N,
  ground: { ink: 1, lines: 0, linesX: CENTER.x, linesY: CENTER.y },
  light: { az: 0, el: 0.5, warmth: 0, intensity: 1 },
  shadow: 1,
  core: { x: CENTER.x, y: CENTER.y, r: CORE_R, on: 0, glow: 0, dim: 0, bezel: 1 },
  waves: [],
  beams: [],
  post: { exposure: 1, bloom: 0.6, vignette: 0.35, grain: 0.4, fade: 0, fadeColor: INK },
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
  fs.ground.lines = ramp(t, 22.6, 26.0) * (1 - ramp(t, 67.5, 69.5));
  fs.ground.linesX = CENTER.x; fs.ground.linesY = CENTER.y;
  fs.light.warmth = dawn;
  fs.light.az = lerp(lerp(-3.0, -2.6, ramp(t, 0, 2)), -2.25, dawn);
  fs.light.el = lerp(0.42, 0.85, dawn);
  // Lights on: the room is dark for the first beat, then the key comes up.
  fs.light.intensity = lerp(REDUCED ? 0.9 : 0.9 * easeOutCubic((t - 0.05) / 0.9), 1.0, dawn);
  fs.shadow = lerp(0.65, 1, dawn);
  fs.post.exposure = 1 - 0.1 * ramp(t, 52.9, 53.5) * (1 - ramp(t, 56.8, 57.8));
  fs.post.bloom = lerp(0.9, 0.55, dawn);
  fs.post.vignette = lerp(0.5, 0.28, dawn);
  fs.post.grain = lerp(0.5, 0.32, dawn);
  const dip = reducedDip(t);
  fs.post.fade = Math.max(1 - ramp(t, 0, 0.3), dip);
  fs.post.fadeColor = dip > 0 && fs.ground.ink < 0.5 ? CREAM : INK;
  fs.haze = 0.0003 * (1 - dawn);
  fs.tileEdge = 1;

  // Core: a glimmer marks where the passages are headed, then it ignites.
  const c = fs.core;
  c.x = CENTER.x; c.y = CENTER.y;
  c.r = lerp(CORE_R, MARK.coreR, easeInOutCubic((t - 68.0) / 1.8));
  c.on = 0.3 * ramp(t, 22.6, 23.4) + 0.7 * ramp(t, 25.8, 26.9);
  c.glow = 0.25 * c.on + 0.8 * pulse(t, 37.8, 39.6) + 0.25 * pulse(t, 33.9, 34.6)
    + 0.5 * ramp(t, 67.0, 67.8) * (1 - ramp(t, 68.6, 69.4)) + 0.35 * ramp(t, 69.0, 70.5);
  c.dim = ramp(t, 52.9, 53.5) * (1 - ramp(t, 57.8, 58.8));
  // The bezel outline goes once the core has grown into the mark.
  c.bezel = 1 - ramp(t, 69.0, 69.6);

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
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: WAVE_R0 + u * 580, width: 5, intensity: 0.8 * Math.sin(Math.PI * u), hue: 1 });
  }
  // Impact of the implosion: one cobalt ring out to the frame edge.
  if (t > 68.6 && t < 69.3 && !REDUCED) {
    const u = (t - 68.6) / 0.6;
    // Opaque until 69.2 (the renderer strokes it solid at intensity >= 0.67), then out.
    fs.waves.push({ x: CENTER.x, y: CENTER.y, r: MARK.coreR * 1.35 + easeOutCubic(u) * 1300, width: 60, intensity: 1 - ramp(t, 69.2, 69.3), hue: 0 });
  }

  // Tiles.
  for (let i = 0; i < N; i++) {
    basePose(i, t, O);
    if (i === WHIP) applyWhip(t, O);
    else if (i === FOCUS) applyFocus(t, O);
    else if (i === GUESS[0]) applyGuess(0, t, O);
    else if (i === GUESS[1]) applyGuess(1, t, O);
    else if (t > 14.2 && t < 18.3) applyThreadTile(i, t, O);
    if ((t > 34 && t < 38.2) || (t > 49.6 && t < 53.8)) applyRetrieval(i, t, O);
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
  // (The stop draws no beams: the dashed ring and the shortfall are 2D, see drawThreshold.)
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
  const dip = reducedDip(t);
  ctx.save();
  if (dip > 0) ctx.globalAlpha *= 1 - dip;
  drawVoice(ctx, t);
  if (ui) drawProduct(ctx, t, ui, cam, proj, REDUCED);
  ctx.restore();
}

function drawProduct(ctx, t, ui, cam, proj, reduced) {
  const theme = t < 21.6 ? 'dark' : 'light';
  const lw = (text) => labelWin(text);
  const label = (o) => ui.label(ctx, { size: 20, theme: 'light', reduced, ...o });

  drawThreshold(ctx, t, proj);

  drawShortfall(ctx, t, proj);

  // The passage that drifts past in the cold open carries the answer.
  if (t > 4.4 && t < 7.6 && ui.tileText) {
    const a = ramp(t, 4.6, 5.0) * (1 - ramp(t, 7.0, 7.4)) * tiles[FOCUS * STRIDE + 11];
    if (a > 0.001) ui.tileText(ctx, { quad: tileQuad(cam, FOCUS), lines: EXCERPT_LINES.filter(Boolean), alpha: a, ink: '#21201C' });
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

  // The stakes: two bare answers, born from the storm, neither with a source.
  const gOut = 1 - ramp(t, 17.8, 18.6);
  GUESS_CARDS.forEach((c, k) => {
    const a = (reduced ? ramp(t, 10.6 + k * 0.3, 11.2 + k * 0.3) : ramp(t, 10.75 + k * 0.3, 11.0 + k * 0.3)) * gOut;
    if (a <= 0.001) return;
    ui.guessCard(ctx, { x: c.x, y: c.y + ramp(t, 17.8, 18.6) * 14, w: c.w, h: c.h, text: k ? '$15' : '$5', kicker: 'No source', alpha: a, progress: 1, crack: 0, theme: 'light' });
  });
  drawFrayedThreads(ctx, t, reduced, proj);

  // The turn: titles ride above the pages until the cut.
  if (t > 19.3 && t < 24.2) {
    const la = ramp(t, 19.9, 20.5) * (1 - ramp(t, 21.0, 21.4));
    for (let pg = 0; pg < 2; pg++) {
      const side = pg === 0 ? -1 : 1;
      const inU = easeOutQuart((t - 19.3 - pg * 0.25) / 1.6);
      const top = proj(960 + side * 250 + side * (1 - inU) * 1300, 600 - 3.4 * 43 * Math.cos(-0.55), 150 - 3.4 * 43 * Math.sin(-0.55) + 40);
      if (la > 0.001) ui.label(ctx, { text: pg === 0 ? COPY.doc1 : COPY.doc2, x: top.sx, y: top.sy - 24, t: 1, t0: 0, t1: 99, theme, align: 'center', size: 20, alpha: la, reduced });
    }
    for (const text of ['Approved documents', 'Split into passages']) {
      ui.label(ctx, { text, x: 960, y: 150, t, t0: lw(text).t0, t1: lw(text).t1, theme, align: 'center', size: 20, swatch: 'cobalt', reduced });
    }
  }

  // Ask: composer, the question held while the search runs, the search told where it happens.
  const q1 = t < 46.7;
  const q = q1 ? COPY.q1 : COPY.q2;
  const pressAt = q1 ? 33.8 : 49.4;
  const compIn = q1 ? 31.2 : 46.8;
  const compA = ramp(t, compIn, compIn + 0.6) * (1 - ramp(t, pressAt + 0.1, pressAt + 0.5));
  const chars = Math.floor(clamp((t - (compIn + 0.4)) / 2.0) * q.length);
  if (compA > 0.001) {
    ui.composer(ctx, {
      x: 96, y: 790, w: 840, text: q, chars, caretOn: Math.floor(t * 2) % 2 === 0, alpha: compA, theme: 'light',
      progress: easeOutQuart((t - compIn) / 0.6), press: pulse(t, pressAt - 0.1, pressAt + 0.3),
    });
  }
  // The question lifts out of the composer and waits at the top while the search runs.
  const cardAt = q1 ? 38.0 : 53.5;
  const rowA = ramp(t, pressAt + 0.05, pressAt + 0.45) * (1 - ramp(t, cardAt + 0.1, cardAt + 0.3));
  if (rowA > 0.001 && ui.questionRow) {
    const u = easeOutCubic((t - pressAt) / 0.45);
    ui.questionRow(ctx, { x: 96, y: lerp(800, 250, u), w: 760, text: q, alpha: rowA, progress: 1 });
  }
  const wa = (-20 * Math.PI) / 180;
  const wp = proj(CENTER.x + Math.cos(wa) * 560, CENTER.y + Math.sin(wa) * 560, 0);
  const wr = waveRadius(SEARCHES[0], clamp(t, SEARCHES[0].t0, SEARCHES[0].t0 + SEARCHES[0].dur));
  const wf = proj(CENTER.x + Math.cos(wa) * wr, CENTER.y + Math.sin(wa) * wr, 0);
  label({ text: 'Meaning', x: wp.sx + 30, y: wp.sy - 70, tick: { x: wf.sx, y: wf.sy }, t, t0: lw('Meaning').t0, t1: lw('Meaning').t1, swatch: 'cobalt' });
  const ek = exactTickTile();
  const ep = proj(L.slots[ek].x, L.slots[ek].y, 30);
  const eq = ek * STRIDE, en = proj(tiles[eq], tiles[eq + 1], tiles[eq + 2]);
  label({ text: 'Exact words', x: ep.sx + 40, y: ep.sy + 70, tick: { x: en.sx, y: en.sy }, t, t0: lw('Exact words').t0, t1: lw('Exact words').t1, swatch: 'amber' });
  const hs = proj(L.slots[HERO].x, L.slots[HERO].y, 170);
  const hk = HERO * STRIDE;
  const hn = proj(tiles[hk], tiles[hk + 1], tiles[hk + 2]);
  label({ text: 'Best passage', x: hs.sx - 60, y: hs.sy - 60, tick: { x: hn.sx, y: hn.sy }, t, t0: lw('Best passage').t0, t1: lw('Best passage').t1, align: 'right', swatch: 'cobalt' });

  // The answer, then its receipt: the passage unfolds into the source panel.
  if (t > 37.9 && t < 46.7) {
    const aA = 1 - ramp(t, 45.6, 46.4);
    const card = ui.answerCard(ctx, {
      x: 96, y: 250, w: 760, question: COPY.q1, answer: COPY.a1, citeIndex: 1, docTitle: COPY.doc1,
      progress: easeOutQuart((t - 38.0) / 0.5), receiptProgress: easeOutQuart((t - 38.7) / 0.5),
      chipHot: ramp(t, 39.2, 39.6) * (1 - ramp(t, 44.6, 45.4)), alpha: aA, theme: 'light', questionAlpha: 1,
    });
    const pa = ramp(t, 40.7, 41.0) * (1 - ramp(t, 45.2, 45.5));
    if (pa > 0.001) {
      const tl = proj(PANEL.x - PANEL.w / 2, PANEL.y - PANEL.h / 2, PANEL.z);
      const br = proj(PANEL.x + PANEL.w / 2, PANEL.y + PANEL.h / 2, PANEL.z);
      const panel = ui.citationPanel(ctx, {
        x: tl.sx, y: tl.sy, w: br.sx - tl.sx, h: br.sy - tl.sy, docTitle: COPY.doc1, version: 1, section: 'Standard Fees',
        excerpt: EXCERPT, highlightRow: '| Basic | $5 |', progress: easeOutQuart((t - 40.7) / 0.5), alpha: pa, surface: false,
      });
      const anchor = card && (card.chipAnchor || card.chipCenter);
      const target = panel && (panel.rowAnchor || (panel.row && { x: panel.row.x - 8, y: panel.row.y + panel.row.h / 2 }));
      if (anchor && target) drawThread(ctx, anchor, target, pa, reduced ? ramp(t, 41.0, 41.4) : clamp((t - 41.0) / 0.6));
    }
  }

  // The stop: the bar, the fall short, the refusal, the gap.
  const ba = (118 * Math.PI) / 180;
  const bp = proj(CENTER.x + Math.cos(ba) * THRESH.r, CENTER.y + Math.sin(ba) * THRESH.r, THRESH.z);
  label({ text: 'Minimum match', x: 1840, y: 200, align: 'right', tick: { x: bp.sx, y: bp.sy }, t, t0: lw('Minimum match').t0, t1: lw('Minimum match').t1, swatch: 'amber' });
  label({ text: 'No passage matched well enough', x: 1840, y: 200, align: 'right', tick: { x: bp.sx, y: bp.sy }, t, t0: lw('No passage matched well enough').t0, t1: lw('No passage matched well enough').t1, swatch: 'amber' });
  if (t > 53.4 && t < 58.7) {
    const ra = ramp(t, 53.5, 53.9) * (1 - ramp(t, 57.9, 58.6));
    ui.refusalCard(ctx, { x: 96, y: 250, w: 760, question: COPY.q2, answer: COPY.refusal, hint: COPY.refusalHint, progress: easeOutQuart((t - 53.5) / 0.5), alpha: ra, flagged: 0, questionAlpha: 1 });
    // The gap lands in the right column, bottom-aligned, so the stop statement
    // owns the bottom-left band alone (gap card height 278 at w 760; bottom at 985,
    // clear of the viewer controls).
    if (t > 55.6) {
      const u = easeOutQuart((t - 55.7) / 0.7);
      const ga = ramp(t, 55.7, 56.1) * (1 - ramp(t, 57.9, 58.6));
      const w = lw('Logged in Content gaps for review');
      const gy = 985 - 278;
      ui.label(ctx, { text: w.text, x: 1010, y: gy - 34, t, t0: w.t0, t1: w.t1, theme: 'light', size: 20, align: 'left', reduced });
      ui.gapItem(ctx, { x: 1010, y: gy + (1 - u) * 16, w: 760, question: COPY.q2, progress: u, alpha: ga, time: 'now' });
    }
  }

  // Program scope tags, one per wedge, on the outer band.
  if (t > 60.2 && t < 67.4) {
    const ta = ramp(t, 60.4, 61.0) * (1 - ramp(t, 66.4, 67.2));
    const hues = [262, 48, 168];
    L.WEDGES.forEach((w, k) => {
      const m = (((w.a0 + w.a1) / 2) * Math.PI) / 180;
      const p = proj(CENTER.x + Math.cos(m) * 730, CENTER.y + Math.sin(m) * 730, 0);
      ui.programTag(ctx, { x: p.sx, y: p.sy, name: w.name, hue: hues[k], alpha: ta, theme: 'light' });
    });
  }

  // Statements.
  for (const s of STATEMENTS) {
    if (t < s.t0 - 0.05 || t > s.t1 + 0.05) continue;
    ui.statement(ctx, { ...s, size: s.align === 'left' ? 60 : 66, maxWidth: s.maxWidth ?? 1400, t, reduced });
  }

  // End slate: the tiles hand over to the drawn sheets around the real glass lens.
  if (t > 69.0) {
    const m = proj(MARK.x, MARK.y, 0);
    ui.lockup(ctx, {
      x: m.sx, y: m.sy, scale: (m.scale * MARK.size) / 330, markAlpha: 0,
      sheetsAlpha: ramp(t, 68.95, 69.3), holeR: fs.core.r * m.scale,
      tAlpha: ramp(t, 69.4, 70.1), wordAlpha: ramp(t, 69.6, 70.5), tagline: COPY.tagline, taglineAlpha: ramp(t, 70.4, 71.3),
      url: COPY.url, urlAlpha: ramp(t, 71.2, 72.0), theme: 'light', layout: 'horizontal', reduced,
    });
  }
}

// The bar a passage must clear: a dashed amber ring rising over the archive at
// THRESH.z, with its soft shadow on the paper. Dashes scale with depth.
function drawThreshold(ctx, t, proj) {
  const bar = barAmount(t);
  if (bar <= 0.001) return;
  const z = lerp(THRESH.z * 0.5, THRESH.z, bar);
  const n = 48, sub = 6;
  const pts = (zz) => {
    const out = [];
    for (let j = 0; j <= n * sub; j++) {
      const a = (j / (n * sub)) * TAU;
      out.push(proj(CENTER.x + Math.cos(a) * THRESH.r, CENTER.y + Math.sin(a) * THRESH.r, zz));
    }
    return out;
  };
  const ring = pts(z), shade = pts(18);
  // Keep the ring off the question row (x 96..856, y ~250..296) while it shows.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 1920, 1080);
  ctx.rect(80, 214, 800, 92);
  ctx.clip('evenodd');
  // Adds dash j to the current path; returns its width, or 0 when behind the eye.
  const dash = (arr, j) => {
    const a = j * sub, b = a + Math.round(sub * 0.6);
    if (arr[a].depth <= 1 || arr[b].depth <= 1) return 0;
    ctx.moveTo(arr[a].sx, arr[a].sy);
    for (let q = a + 1; q <= b; q++) ctx.lineTo(arr[q].sx, arr[q].sy);
    return clamp(arr[a + 2].scale * 4.2, 2.5, 9);
  };
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Shadow on the paper: three widening low-alpha strokes stand in for a blur
  // (a canvas filter stalls the first frame that uses it).
  ctx.globalAlpha *= bar * 0.5;
  ctx.beginPath();
  let ws = 0, nw = 0;
  for (let j = 0; j < n; j++) { const w = dash(shade, j); if (w) { ws += w; nw++; } }
  const sw = nw ? ws / nw : 4;
  for (const [k, a] of [[3.4, 0.08], [2.4, 0.1], [1.4, 0.14]]) {
    ctx.strokeStyle = `rgba(33, 32, 28, ${a})`;
    ctx.lineWidth = sw * k;
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha *= bar;
  for (let j = 0; j < n; j++) {
    ctx.beginPath();
    const w = dash(ring, j);
    if (!w) continue;
    ctx.strokeStyle = '#8A5300'; ctx.lineWidth = w + 2.5; ctx.stroke();
    ctx.strokeStyle = '#F59F0A'; ctx.lineWidth = w; ctx.stroke();
  }
  ctx.restore();
  ctx.restore();
}

// The fall-short: above each weak candidate, an amber tick at the bar's height
// and a dotted ink guide from the candidate's top edge up to it.
function drawShortfall(ctx, t, proj) {
  const bar = barAmount(t);
  if (bar <= 0.001 || t < 50.3 || t > 53.8) return;
  const zBar = lerp(THRESH.z * 0.5, THRESH.z, bar);
  ctx.save();
  ctx.lineCap = 'round';
  L.weak.forEach((i, wk) => {
    const rise = weakRise(wk, t);
    if (rise <= 0.02) return;
    const k = i * STRIDE;
    const a = L.slots[i].a;
    const quad = tileQuad(fs.cam, i).slice().sort((p, q) => p[1] - q[1]);
    const top = { sx: (quad[0][0] + quad[1][0]) / 2, sy: Math.min(quad[0][1], quad[1][1]) };
    const ringAt = (da) => proj(CENTER.x + Math.cos(a + da) * THRESH.r, CENTER.y + Math.sin(a + da) * THRESH.r, zBar);
    const tick = ringAt(0);
    ctx.globalAlpha = bar * rise;
    // Guide: the distance still to go, straight up from the card to the bar.
    // Shown only while the card holds at full height.
    ctx.globalAlpha = bar * ramp(rise, 0.9, 1);
    ctx.strokeStyle = 'rgba(33, 32, 28, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 5]);
    ctx.beginPath(); ctx.moveTo(top.sx, top.sy - 4); ctx.lineTo(tick.sx, tick.sy + 6); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = bar * rise;
    // Notch: the part of the bar this passage needed to reach, thicker on the ring.
    const w = clamp(tick.scale * 4.2, 2.5, 9) + 4;
    ctx.beginPath();
    for (let q = -6; q <= 6; q++) { const r = ringAt((q / 6) * 0.05); if (q === -6) ctx.moveTo(r.sx, r.sy); else ctx.lineTo(r.sx, r.sy); }
    ctx.strokeStyle = '#8A5300'; ctx.lineWidth = w + 2.5; ctx.stroke();
    ctx.strokeStyle = '#F59F0A'; ctx.lineWidth = w; ctx.stroke();
  });
  ctx.restore();
}

// The stakes: from each guess a thread searches the storm for a source; the
// passages it reaches light, turn over blank and dim. The threads fray and fade.
function drawFrayedThreads(ctx, t, reduced, proj) {
  if (t < 14.2 || t > 16.2) return;
  const fray = ramp(t, 15.0, 15.8);
  const a = ramp(t, 14.2, 14.4) * (1 - ramp(t, 15.6, 16.2));
  const tt = threadTiles();
  GUESS_CARDS.forEach((c, k) => {
    const y0 = c.y + c.h + 4;
    ctx.save();
    ctx.globalAlpha *= a * 0.9;
    ctx.strokeStyle = '#7DB0FF';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    tt[k].forEach((i, j) => {
      if (i < 0) return;
      const ta = threadArrive(k, j);
      const grow = reduced ? 1 : easeOutCubic((t - 14.2) / (ta - 14.2));
      const q = i * STRIDE;
      const e = proj(tiles[q], tiles[q + 1], tiles[q + 2]);
      const x0 = c.x + c.w / 2 + (j - 2) * 44, x1 = e.sx, y1 = Math.max(e.sy, y0 + 40);
      // Cubic whose control points keep y increasing: the thread never climbs into a card.
      const pt = (u) => {
        const v = 1 - u;
        const cy0 = y0 + (y1 - y0) * 0.55, cy1 = y1 - (y1 - y0) * 0.25;
        return [v * v * v * x0 + 3 * v * v * u * x0 + 3 * v * u * u * x1 + u * u * u * x1 + Math.sin(u * 9 + j + k * 2) * 10 * u * v * 4,
          v * v * v * y0 + 3 * v * v * u * cy0 + 3 * v * u * u * cy1 + u * u * u * y1];
      };
      const n = 40;
      ctx.beginPath();
      let pen = false;
      for (let m = 0; m <= n * grow; m++) {
        const u = m / n;
        // Fraying: the far end breaks into ever shorter dashes.
        const gap = fray * u > 0.15 && ((m * 7 + j * 3 + k) % Math.max(2, Math.round(6 - 5 * fray * u))) === 0;
        if (gap) { pen = false; continue; }
        const [x, y] = pt(u);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });
    ctx.restore();
  });
}

// The caller's voice: a thin line across the lower frame, driven by a
// deterministic speech envelope.
function drawVoice(ctx, t) {
  const a = ramp(t, 0.6, 1.4) * (1 - ramp(t, 5.0, 6.2));
  if (a <= 0.001) return;
  const speaking = (u) => pulse(u, 1.8, 4.6) * (0.6 + 0.4 * Math.sin(u * 7.1) * Math.sin(u * 3.3));
  ctx.save();
  ctx.globalAlpha *= a * 0.8;
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

// A cobalt thread from the citation chip to the source line; its head runs
// from the chip to the line as it draws.
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
  ctx.globalAlpha *= a;
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
