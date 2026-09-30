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
export const CORE_R = 170;

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
  { r0: 232, r1: 312, cell: 12, z: 8, lines: 0.05,
    sectors: [[-180, 180, 'paper', 0]] },
  { r0: 324, r1: 414, cell: 15, z: 26, lines: 0.12,
    sectors: [[-160, -96, 'paper', 10], [-92, -20, 'sage', 0], [-16, 70, 'paper', 14], [74, 118, 'paper', 0], [122, 196, 'sage', 6]] },
  { r0: 426, r1: 514, cell: 19, z: 14, lines: 0.18,
    sectors: [[-176, -120, 'paper', 18], [-116, -50, 'paper', 4], [-46, 8, 'sage', 22], [12, 92, 'paper', 8], [96, 150, 'paper', 26], [154, 180, 'paper', 0]] },
  { r0: 526, r1: 630, cell: 24, z: 40, lines: 0.22,
    sectors: [[-150, -104, 'paper', 0], [-84, -30, 'paper', 14], [18, 44, 'coral', 22], [46, 58, 'coral', 8], [64, 128, 'paper', 4], [150, 206, 'sage', 18]] },
  { r0: 644, r1: 820, cell: 15, z: 3, lines: 0.04, field: true,
    sectors: [[-176, -64, 'paperCool', 0], [-60, 58, 'paperCool', 2], [62, 176, 'paperCool', 1]] },
];

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
    rng(); // kept so the seed sequence below is stable
    // Each row divides each sector evenly, so every sector ends on a straight
    // radial cut instead of a staircase of whole tiles.
    for (let j = 0; j < rows; j++) {
      const r = b.r0 + (j + 0.5) * ((b.r1 - b.r0) / rows);
      for (const sec of b.sectors) {
        const a0 = (sec[0] * Math.PI) / 180, span = ((sec[1] - sec[0]) * Math.PI) / 180;
        const m = Math.max(1, Math.round((span * r) / b.cell));
        for (let k = 0; k < m; k++) {
          const a = a0 + ((k + 0.5) / m) * span;
          let deg = (a * 180) / Math.PI;
          deg = ((deg + 180) % 360 + 360) % 360 - 180;
          const c = tint(rng, sec[2]);
          slots.push({
            band: bi, r, a, deg,
            x: CENTER.x + r * Math.cos(a),
            y: CENTER.y + r * Math.sin(a),
            z: b.z + sec[3] + (b.field ? 0 : rng() * 0.8),
            rz: a + Math.PI / 2,
            w: (span * r) / m,
            h: (b.r1 - b.r0) / rows,
            col: c,
            colKey: sec[2],
            lines: b.lines,
            field: !!b.field,
          });
        }
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
  for (let i = 0; i < n; i++) if (slots[i].band <= 1 && slots[i].colKey === 'paper') docCandidates.push(i);
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
      const d = Math.abs(s.deg - 140) + Math.abs(s.r - 370) * 0.3;
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

  // Weak candidates for the refused question: five passages spread along the
  // near side of the ring from the stop camera (where the ring runs level on
  // screen), clear of the walls at 90 and 210.
  const weak = [];
  for (const [deg, band] of [[114, 2], [134, 3], [154, 2], [174, 3], [194, 2]]) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < n; i++) {
      const s = slots[i];
      if (s.band !== band || s.colKey === 'coral' || i === hero.tile || used.has(i) || weak.includes(i)) continue;
      const d = Math.abs(((s.deg - deg + 540) % 360) - 180) + Math.abs(s.r - (band === 2 ? 470 : 578)) * 0.2;
      if (d < bd) { bd = d; best = i; }
    }
    weak.push(best);
  }

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

  return { slots, n, R, docs, docOf, hero, semantic, exact, shortlist, weak, WEDGES, wedgeOf, mark, PAGE_COLS, PAGE_ROWS };
}

// The Truenote mark as a mosaic: a mineral-green sheet rotated -21deg and a
// persimmon sheet rotated 19deg behind the cobalt lens (the archive core).
export const MARK = { x: CENTER.x, y: CENTER.y, size: 420, coreR: 150 };

// Inside a rounded square of half-size h with corner radius r, inset by m.
function roundedInside(x, y, h, r, m) {
  const hx = h - m, rr = Math.max(0, r - m);
  const qx = Math.abs(x) - (hx - rr), qy = Math.abs(y) - (hx - rr);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= rr;
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
        if (!roundedInside(gx, gy, half, 0.48 * S, cell * 0.6)) continue;
        const c = Math.cos(sh.rot), s = Math.sin(sh.rot);
        const x = MARK.x + sh.dx * MARK.size + gx * c - gy * s;
        const y = MARK.y + sh.dy * MARK.size + gx * s + gy * c;
        // Skip cells hidden under the lens.
        if (Math.hypot(x - MARK.x, y - MARK.y) < MARK.coreR + cell * 0.8) continue;
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
