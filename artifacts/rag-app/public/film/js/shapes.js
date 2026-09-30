// Static layouts, computed once at load. Every tile owns one archive slot for
// the whole film; the storm, the document pages and the mark are other poses
// of the same tiles, so identity survives every morph.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CENTER = { x: 960, y: 540 };
export const CORE_R = 118;

// Palette (sRGB 0..1). Paper follows the hero art; accents follow the tokens.
const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const COLORS = {
  paper: hex('#F2ECDF'),
  paperWarm: hex('#EDE3D1'),
  paperCool: hex('#E9E6DC'),
  sage: hex('#AEBAA9'),
  sageDeep: hex('#93A597'),
  coral: hex('#D8683A'),
  coralLight: hex('#E2825A'),
  cobalt: hex('#0040AB'),
  ink: hex('#21201C'),
};

// Bands of the archive, inner to outer. Angles in degrees, 0 = +x, clockwise
// on screen (y is down). Each sector: [a0, a1, colour, z offset].
const BANDS = [
  { r0: 146, r1: 232, cell: 11.5, z: 4, lines: 0.25,
    sectors: [[-180, 180, 'paper', 0]] },
  { r0: 244, r1: 342, cell: 15, z: 12, lines: 0.5,
    sectors: [[-160, -96, 'paper', 4], [-92, -20, 'sage', 0], [-16, 70, 'paper', 6], [74, 118, 'paper', 0], [122, 196, 'sage', 2]] },
  { r0: 354, r1: 452, cell: 19, z: 7, lines: 0.7,
    sectors: [[-176, -120, 'paper', 8], [-116, -50, 'paper', 2], [-46, 8, 'sage', 10], [12, 92, 'paper', 4], [96, 150, 'paper', 12], [154, 180, 'paper', 0]] },
  { r0: 466, r1: 590, cell: 26, z: 16, lines: 0.85,
    sectors: [[-150, -104, 'paper', 0], [-84, -30, 'paper', 6], [18, 44, 'coral', 10], [46, 58, 'coral', 4], [64, 128, 'paper', 2], [150, 206, 'sage', 8]] },
  { r0: 604, r1: 1020, cell: 17, z: 1.5, lines: 0.12, field: true,
    sectors: [[-180, 180, 'paperCool', 0]] },
];

function inSector(deg, s) {
  let d = deg;
  while (d < s[0]) d += 360;
  while (d >= s[0] + 360) d -= 360;
  return d <= s[1];
}

function tint(rng, key) {
  const base = COLORS[key];
  const j = (rng() - 0.5) * 0.035;
  const k = key === 'paper' || key === 'paperCool' ? (rng() < 0.18 ? COLORS.paperWarm : base) : base;
  return [k[0] + j, k[1] + j, k[2] + j * 1.2];
}

export function buildLayout(seed = 7) {
  const rng = mulberry32(seed);
  const slots = [];
  BANDS.forEach((b, bi) => {
    const rows = Math.max(1, Math.floor((b.r1 - b.r0) / b.cell));
    const rot = rng() * 0.5;
    for (let j = 0; j < rows; j++) {
      const r = b.r0 + (j + 0.5) * ((b.r1 - b.r0) / rows);
      const m = Math.floor((2 * Math.PI * r) / b.cell);
      for (let k = 0; k < m; k++) {
        const a = ((k + 0.5) / m) * Math.PI * 2 + rot;
        let deg = (a * 180) / Math.PI;
        deg = ((deg + 180) % 360 + 360) % 360 - 180;
        const sec = b.sectors.find((s) => inSector(deg, s));
        if (!sec) continue;
        // The outer field thins with distance so the archive dissolves into the table.
        if (b.field) {
          const f = (r - b.r0) / (b.r1 - b.r0);
          if (rng() < 0.18 + f * f * 0.8) continue;
          if (Math.sin(a * 5 + r * 0.013) > 0.72 && rng() < 0.8) continue;
        }
        const c = tint(rng, sec[2]);
        slots.push({
          band: bi, r, a, deg,
          x: CENTER.x + r * Math.cos(a),
          y: CENTER.y + r * Math.sin(a),
          z: b.z + sec[3] + (b.field ? 0 : rng() * 0.8),
          rz: a + Math.PI / 2,
          w: b.cell * (b.field ? 0.82 : 0.9),
          h: ((b.r1 - b.r0) / rows) * (b.field ? 0.82 : 0.9),
          col: c,
          colKey: sec[2],
          lines: b.lines,
          field: !!b.field,
        });
      }
    }
  });

  const n = slots.length;
  const R = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (const arr of R) arr[i] = rng();

  // Document tiles: 2 pages of 5 x 7 passages, taken from bands 1 to 3 so they
  // land inside the archive. The hero passage (the Standard Fees table) is
  // page 0, row 3, col 2.
  const docCandidates = [];
  for (let i = 0; i < n; i++) if (slots[i].band >= 1 && slots[i].band <= 2 && slots[i].colKey === 'paper') docCandidates.push(i);
  const docs = [];
  const used = new Set();
  const PAGE_COLS = 5, PAGE_ROWS = 7;
  for (let p = 0; p < 2; p++) {
    for (let row = 0; row < PAGE_ROWS; row++) {
      for (let col = 0; col < PAGE_COLS; col++) {
        let idx;
        do idx = docCandidates[Math.floor(rng() * docCandidates.length)]; while (used.has(idx));
        used.add(idx);
        docs.push({ tile: idx, page: p, row, col });
      }
    }
  }
  // Put the hero passage in a clearly visible slot: band 2, lower-left of the core.
  let hero = docs.find((d) => d.page === 0 && d.row === 3 && d.col === 2);
  {
    let best = -1, bestD = 1e9;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (s.band !== 1 || s.colKey !== 'paper' || used.has(i)) continue;
      const d = Math.abs(s.deg - 140) + Math.abs(s.r - 300) * 0.3;
      if (d < bestD) { bestD = d; best = i; }
    }
    used.delete(hero.tile);
    hero.tile = best;
    used.add(best);
  }
  const docOf = new Int16Array(n).fill(-1);
  docs.forEach((d, k) => { docOf[d.tile] = k; });

  // Retrieval roles: semantic neighbours (glow on the meaning wave), exact-word
  // matches (amber), and the reranked shortlist that lifts.
  const semantic = new Uint8Array(n);
  const exact = [];
  const shortlist = [];
  const byDistToHero = [];
  for (let i = 0; i < n; i++) {
    if (slots[i].field) continue;
    const dx = slots[i].x - slots[hero.tile].x, dy = slots[i].y - slots[hero.tile].y;
    byDistToHero.push([Math.hypot(dx, dy) + R[0][i] * 260, i]);
  }
  byDistToHero.sort((a, b) => a[0] - b[0]);
  for (let k = 0; k < 90; k++) semantic[byDistToHero[k][1]] = 1;
  docs.filter((d) => d.page === 0).forEach((d) => { semantic[d.tile] = 1; });
  // Exact-word matches: the cancellation doc's fee passages plus a few look-alikes elsewhere.
  for (const d of docs) if (d.page === 0 && (d.row === 3 || d.row === 2) && exact.length < 6) exact.push(d.tile);
  for (let k = 0; exact.length < 11; k++) {
    const i = Math.floor(R[1][k] * n);
    if (!slots[i].field && slots[i].band <= 3 && !exact.includes(i)) exact.push(i);
  }
  if (!exact.includes(hero.tile)) exact[0] = hero.tile;
  shortlist.push(hero.tile);
  for (const i of exact) if (shortlist.length < 5 && !shortlist.includes(i)) shortlist.push(i);
  for (let k = 0; shortlist.length < 7; k++) { const i = byDistToHero[5 + k * 3][1]; if (!shortlist.includes(i)) shortlist.push(i); }

  // Program wedges for the scope chapter: A, B, C.
  const WEDGES = [
    { name: 'Program A', a0: -150, a1: -30, hue: 262 },
    { name: 'Program B', a0: -30, a1: 90, hue: 168 },
    { name: 'Program C', a0: 90, a1: 210, hue: 48 },
  ];
  const wedgeOf = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let d = slots[i].deg;
    for (let w = 0; w < 3; w++) {
      let dd = d;
      while (dd < WEDGES[w].a0) dd += 360;
      while (dd >= WEDGES[w].a0 + 360) dd -= 360;
      if (dd < WEDGES[w].a1) { wedgeOf[i] = w; break; }
    }
  }

  const mark = buildMark(slots, R, rng);

  return { slots, n, R, docs, docOf, hero, semantic, exact, shortlist, WEDGES, wedgeOf, mark, PAGE_COLS, PAGE_ROWS };
}

// The Truenote mark as a mosaic: a mineral-green sheet rotated -21deg and a
// persimmon sheet rotated 19deg behind the cobalt lens (the archive core).
export const MARK = { x: CENTER.x, y: CENTER.y, size: 420, coreR: 151 };

function superellipseInside(u, v, n = 3.2) {
  return Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), n) <= 1;
}

function buildMark(slots, R, rng) {
  const cell = 9.5;
  const cells = [];
  const sheets = [
    { rot: (-21 * Math.PI) / 180, dx: -0.1, dy: 0.05, col: 'sage', z: 18 },
    { rot: (19 * Math.PI) / 180, dx: 0.11, dy: -0.05, col: 'coral', z: 30 },
  ];
  const S = MARK.size * 0.72;
  sheets.forEach((sh, si) => {
    const half = S / 2;
    for (let gy = -half + cell / 2; gy < half; gy += cell) {
      for (let gx = -half + cell / 2; gx < half; gx += cell) {
        if (!superellipseInside(gx / half, gy / half)) continue;
        const c = Math.cos(sh.rot), s = Math.sin(sh.rot);
        const x = MARK.x + sh.dx * MARK.size + gx * c - gy * s;
        const y = MARK.y + sh.dy * MARK.size + gx * s + gy * c;
        // Skip cells hidden under the lens.
        if (Math.hypot(x - MARK.x, y - MARK.y) < MARK.coreR * 0.97) continue;
        cells.push({ x, y, z: sh.z + rng() * 0.6, rz: sh.rot, w: cell * 0.9, h: cell * 0.9, colKey: sh.col, sheet: si });
      }
    }
  });
  // Assign the tiles nearest the core (inner bands) to mark cells, by angle
  // order so the flight paths don't cross much.
  const pool = [];
  for (let i = 0; i < slots.length; i++) if (!slots[i].field) pool.push(i);
  pool.sort((a, b) => slots[a].r - slots[b].r);
  const take = pool.slice(0, cells.length);
  const ang = (x, y) => Math.atan2(y - MARK.y, x - MARK.x);
  take.sort((a, b) => slots[a].a - slots[b].a || 0);
  const cellsSorted = cells.map((c, k) => [ang(c.x, c.y), k]).sort((p, q) => p[0] - q[0]);
  const markOf = new Int32Array(slots.length).fill(-1);
  const takeSorted = take.map((i) => [Math.atan2(Math.sin(slots[i].a), Math.cos(slots[i].a)), i]).sort((p, q) => p[0] - q[0]);
  for (let k = 0; k < cellsSorted.length; k++) markOf[takeSorted[k][1]] = cellsSorted[k][1];
  return { cells, markOf };
}
