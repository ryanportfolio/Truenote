// Truenote promo film: 2D canvas component library for captions and product UI.
//
// Contract: pure draw functions. No clocks, no randomness, no state kept between
// calls. The caller passes a 2D context already scaled so 1 unit = 1 design px
// of a 1920x1080 frame. Animation comes only from numeric props (t with window
// times, or progress 0..1). Every function save()s and restore()s the context.
//
// Type: Georgia for display, Verdana for UI, a system mono stack for labels.
// Product UI is the app's /chat surface scaled for a phone feed (14 px answer body -> 32 px,
// cards <= 760 px wide); tokens are DESIGN.md's, copy is whatever the caller passes.

export const FONTS = {
  display: 'Georgia, Cambria, "Times New Roman", serif',
  ui: 'Verdana, Geneva, "DejaVu Sans", sans-serif',
  mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
};

export const TOKENS = {
  canvas: '#E8E6DE', // --background (cream)
  ink: '#21201C', // --foreground
  card: '#FDFDFC',
  secondary: '#F9F9F8',
  muted: '#F1F0EF',
  mutedFg: '#5C5A50', // 5.54:1 on cream, 6.80:1 on card
  border: '#DAD9D6',
  primary: '#0040AB', // 7.24:1 on cream, 8.89:1 on card
  accent: '#005DE5',
  onPrimary: '#FAFAF7',
  success: '#39594D',
  warning: '#F59F0A',
  warningFg: '#322801', // 12.3:1 on warning/20 over card
  archiveInk: '#042761', // oklch(29% 0.11 260)
  green: '#579B8A', // oklch(64% 0.075 176)
  coral: '#DB7244', // oklch(66.5% 0.145 43)
  night: '#0B1020',
  // Dark-theme text colours.
  paper: '#F1EFE8', // 15:1 on night, 11.4:1 on archive ink
  cobaltOnDark: '#7DB0FF', // the /about page's cobalt-on-dark: 6.49:1 on archive ink, 8.59:1 on night
  greenOnDark: '#7FC3AE', // 7.0:1 on archive ink
  labelInk: '#48463E', // film label ink on light: 7.9:1 on cream (mutedFg is 5.5:1, too thin over the dawn)
};

// Product refusal text (api-server generation/answer.ts). Default for refusalCard.
export const REFUSAL_TEXT =
  "I couldn't find this in the knowledge base. Please escalate or check the source documents directly.";

// Scrim alpha under text, per surface. Measured on the film's densest frames
// (storm t 3, 8, 17; rings t 39, 58) so the worst pixel under text passes
// 4.5:1 for labels and 3:1 for large statement text. See the lab's measure script.
export const SCRIM = { statementDark: 0.8, statementLight: 0.3, labelDark: 0.94, labelLight: 0.95, callerDark: 0.82, callerLight: 0.9, questionLight: 0.9 };

const EASE_STAGGER = 0.07; // statement word stagger, s
const WORD_IN = 0.6; // statement word arrival, s
const EXIT = 0.45; // statement exit, s

// ---------------------------------------------------------------- math

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeOutQuart = (v) => 1 - Math.pow(1 - clamp01(v), 4);
export const smoothstep = (v) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const easeInCubic = (v) => {
  const x = clamp01(v);
  return x * x * x;
};
const lerp = (a, b, k) => a + (b - a) * k;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function hexRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgba(hex, a) {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}
function mixHex(a, b, k) {
  const x = hexRgb(a);
  const y = hexRgb(b);
  const c = x.map((v, i) => Math.round(lerp(v, y[i], k)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** oklch -> 'rgb(r,g,b)' (sRGB, gamut-clipped). Pure. */
export function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (x) => {
    const v = Math.max(0, Math.min(1, x));
    return Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
  };
  return `rgb(${enc(lin[0])},${enc(lin[1])},${enc(lin[2])})`;
}

/** Program identity swatch, DESIGN.md: oklch(75% 0.06 h). */
export const programSwatch = (hue) => oklchToRgb(0.75, 0.06, hue);

// Deterministic PRNG for fixed geometry (crack paths). Seeded from props only.
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- canvas helpers

function setFont(ctx, { family = FONTS.ui, size = 24, weight = 400, italic = false, track = 0 }) {
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${family}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(track * size).toFixed(2)}px`;
  return track * size;
}
function textW(ctx, s) {
  // measureText includes letterSpacing after the last glyph; drop it.
  const ls = 'letterSpacing' in ctx ? parseFloat(ctx.letterSpacing) || 0 : 0;
  return s ? ctx.measureText(s).width - ls : 0;
}
function devScale(ctx) {
  const m = ctx.getTransform();
  return Math.hypot(m.a, m.b) || 1;
}
// Canvas shadows ignore the current transform; scale them so they match the design frame.
function shadow(ctx, color, blur, ox = 0, oy = 0) {
  const k = devScale(ctx);
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * k;
  ctx.shadowOffsetX = ox * k;
  ctx.shadowOffsetY = oy * k;
}
function noShadow(ctx) {
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}
// Feathered shape: draw the shape far off-frame and cast only its blurred shadow
// into place, so the scrim has no hard edge.
function softScrim(ctx, x, y, w, h, r, color, blur) {
  const k = devScale(ctx);
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * k;
  ctx.shadowOffsetX = 20000 * k;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#000';
  rrPath(ctx, x - 20000, y, w, h, r);
  ctx.fill();
  ctx.restore();
}
function rrPath(ctx, x, y, w, h, r) {
  const rad = Array.isArray(r) ? r : [r, r, r, r];
  const lim = Math.min(w, h) / 2;
  const [tl, tr, br, bl] = rad.map((v) => Math.max(0, Math.min(v, lim)));
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}
// Soft corners for the mark: cubic corners a touch squarer than a circle arc.
function squirclePath(ctx, x, y, w, h, rad) {
  const k = 0.36; // control-point pull; 0.448 = circular arc, lower = squarer shoulder
  const [tl, tr, br, bl] = rad;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.bezierCurveTo(x + w - tr * k, y, x + w, y + tr * k, x + w, y + tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.bezierCurveTo(x + w, y + h - br * k, x + w - br * k, y + h, x + w - br, y + h);
  ctx.lineTo(x + bl, y + h);
  ctx.bezierCurveTo(x + bl * k, y + h, x, y + h - bl * k, x, y + h - bl);
  ctx.lineTo(x, y + tl);
  ctx.bezierCurveTo(x, y + tl * k, x + tl * k, y, x + tl, y);
  ctx.closePath();
}

// Surfaces: product cards keep DESIGN.md's light tokens on either ground; the
// theme only changes the shadow so the card sits on ink as well as on cream.
function cardSurface(ctx, x, y, w, h, r, theme, { fill = TOKENS.card, border = TOKENS.border, lift = 1 } = {}) {
  ctx.save();
  if (theme === 'dark') {
    shadow(ctx, `rgba(0,0,0,${0.34 * lift})`, 60, 0, 24);
  } else {
    shadow(ctx, rgba(TOKENS.ink, 0.07 * lift), 56, 0, 20);
  }
  rrPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (theme === 'dark') shadow(ctx, 'rgba(0,0,0,0.25)', 4, 0, 2);
  else shadow(ctx, rgba(TOKENS.ink, 0.06), 4, 0, 2);
  ctx.fill();
  noShadow(ctx);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.restore();
}

// Lucide icon paths (24-unit viewBox), stroked.
const ICONS = {
  copy: ['M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z', 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  thumbsUp: ['M7 10v12', 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z'],
  thumbsDown: ['M17 14V2', 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  check: ['M20 6 9 17l-5-5'],
  book: ['M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z', 'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'],
};
function icon(ctx, name, x, y, size, color, weight = 2) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = weight;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  for (const d of ICONS[name]) ctx.stroke(new Path2D(d));
  ctx.restore();
}

function greedyLines(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textW(ctx, next) > maxW) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Greedy wrap at the narrowest width that keeps the same line count, so the
// last line is never a lone word when it can be avoided.
function balancedText(ctx, text, maxW) {
  const n = greedyLines(ctx, text, maxW).length;
  if (n <= 1) return greedyLines(ctx, text, maxW);
  let lo = maxW * 0.4;
  let hi = maxW;
  for (let k = 0; k < 16; k += 1) {
    const mid = (lo + hi) / 2;
    if (greedyLines(ctx, text, mid).length <= n) hi = mid;
    else lo = mid;
  }
  return greedyLines(ctx, text, hi);
}
// Card text: full measure, rebalanced only when the last line would be a lone word.
function niceText(ctx, text, maxW) {
  const lines = greedyLines(ctx, text, maxW);
  if (lines.length > 1 && !/\s/.test(lines[lines.length - 1].trim())) return balancedText(ctx, text, maxW);
  return lines;
}
function clampLines(ctx, text, maxW, n) {
  const lines = greedyLines(ctx, text, maxW);
  if (lines.length <= n) return niceText(ctx, text, maxW);
  if (lines.length <= n) return lines;
  const out = lines.slice(0, n);
  let last = `${out[n - 1]} ${lines[n]}`;
  while (last.length > 1 && textW(ctx, `${last}…`) > maxW) last = last.slice(0, -1).trimEnd();
  out[n - 1] = `${last}…`;
  return out;
}

// Wrap measured items ({w}) at width W with a fixed gap between items.
function wrapItems(items, W, gapOf) {
  const lines = [];
  let line = [];
  let lw = 0;
  for (const it of items) {
    const add = line.length ? gapOf(line[line.length - 1]) + it.w : it.w;
    if (line.length && lw + add > W) {
      lines.push(line);
      line = [it];
      lw = it.w;
    } else {
      line.push(it);
      lw += add;
    }
  }
  if (line.length) lines.push(line);
  return lines;
}
// Balanced wrap: fewest lines at maxW, then the narrowest measure that keeps
// that count, then no single-word last line.
function balancedLines(items, maxW, gapOf) {
  const n = wrapItems(items, maxW, gapOf).length;
  if (n <= 1) return wrapItems(items, maxW, gapOf);
  let lo = Math.max(...items.map((i) => i.w));
  let hi = maxW;
  for (let k = 0; k < 24; k += 1) {
    const mid = (lo + hi) / 2;
    if (wrapItems(items, mid, gapOf).length <= n) hi = mid;
    else lo = mid;
  }
  const lines = wrapItems(items, hi, gapOf);
  const last = lines[lines.length - 1];
  const prev = lines[lines.length - 2];
  if (last.length === 1 && prev && prev.length >= 3) last.unshift(prev.pop());
  return lines;
}
const lineWidth = (line, gapOf) => line.reduce((s, it, i) => s + it.w + (i ? gapOf(line[i - 1]) : 0), 0);

// ---------------------------------------------------------------- statement

function parseStatement(text, accent) {
  const acc = new Set(accent || []);
  return String(text)
    .trim()
    .split(/\s+/)
    .map((raw, i) => {
      let word = raw;
      let italic = acc.has(i);
      // Inline markup is also accepted: *word* marks an accent word.
      const m = /^\*(.+?)\*([.,;:!?]*)$/.exec(word);
      if (m) {
        word = m[1] + m[2];
        italic = true;
      }
      let punct = '';
      if (italic) {
        const p = /^(.*?)([.,;:!?]+)$/.exec(word);
        if (p && p[1]) {
          word = p[1];
          punct = p[2];
        }
      }
      return { word, punct, italic };
    });
}

/** Reading budget in seconds for a statement (250 ms per word + 1 s, never under 20 frames). */
export function statementDuration(text) {
  const n = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(20 / 60, n * 0.25 + 1);
}
/** Seconds from t0 until the last word has settled. Schedule t1 >= t0 + arrive + duration + 0.45. */
export function statementArrive(text) {
  const n = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0, n - 1) * EASE_STAGGER + WORD_IN;
}

/**
 * Large Georgia statement, words staggered in, one italic cobalt accent.
 * (x, y): align 'center' -> centre of the text block; 'left' -> left edge, vertical centre.
 * y is the vertical centre of the whole block, not a baseline: h = lines * size *
 * lineHeight and the block spans y - h/2 .. y + h/2. Lines break at the narrowest
 * measure that keeps the minimum line count, and a one-word last line borrows a word.
 * Returns the block rect { x, y, w, h, lines } (all lines, static layout; words sit
 * up to 10 px lower while arriving and 8 px higher while exiting) or null when not on screen.
 */
export function statement(ctx, props) {
  const {
    text = '',
    accent = [],
    x = 960,
    y = 540,
    align = 'center',
    size = 64,
    maxWidth = 1500,
    t = 0,
    t0 = 0,
    t1 = Infinity,
    theme = 'dark',
    scrim = null,
    lineHeight = 1.14,
    reduced = false,
  } = props;
  if (t < t0 || t > t1) return null;
  const words = parseStatement(text, accent);
  if (!words.length) return null;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  ctx.fontKerning = 'normal';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const track = -0.02;
  const face = (italic) => ({ family: FONTS.display, size, weight: 600, italic, track });
  setFont(ctx, face(false));
  const space = textW(ctx, 'a a') - textW(ctx, 'aa');
  const items = words.map((wd, i) => {
    setFont(ctx, face(wd.italic));
    const ww = textW(ctx, wd.word);
    setFont(ctx, face(false));
    const pw = wd.punct ? textW(ctx, wd.punct) : 0;
    // Italic overhangs its advance; give the next word a hair of air.
    return { ...wd, i, ww, pw, w: ww + pw + (wd.italic && !wd.punct ? size * 0.03 : 0) };
  });
  const gapOf = () => space;
  const lines = balancedLines(items, maxWidth, gapOf);
  const lh = size * lineHeight;
  const h = lines.length * lh;
  const widths = lines.map((l) => lineWidth(l, gapOf));
  const w = Math.max(...widths);
  const top = y - h / 2;
  const left = align === 'center' ? x - w / 2 : x;

  const ink = theme === 'dark' ? TOKENS.paper : TOKENS.ink;
  const acc = theme === 'dark' ? TOKENS.cobaltOnDark : TOKENS.primary;
  const exitK = Number.isFinite(t1) ? smoothstep((t - (t1 - EXIT)) / EXIT) : 0;
  const exitA = 1 - exitK;
  const drift = reduced ? 0 : -8 * exitK;

  const S = scrim ?? (theme === 'dark' ? SCRIM.statementDark : SCRIM.statementLight);
  if (S > 0) {
    // A block-shaped scrim (uniform under every word) inside a wide feather.
    const sa = smoothstep((t - t0) / 0.5) * exitA;
    const sc = theme === 'dark' ? TOKENS.night : TOKENS.canvas;
    ctx.save();
    ctx.globalAlpha = G0 * (sa);
    softScrim(ctx, left - size * 1.6, top - size * 1.1, w + size * 3.2, h + size * 2.2, size * 1.4, rgba(sc, S * 0.5), size * 1.6);
    softScrim(ctx, left - size * 0.9, top - size * 0.5, w + size * 1.8, h + size * 1.0, size * 0.8, rgba(sc, S), size * 0.7);
    ctx.restore();
  }

  lines.forEach((line, li) => {
    const lw = widths[li];
    let cx = align === 'center' ? x - lw / 2 : x;
    const base = top + lh * (li + 0.5) + size * 0.34;
    line.forEach((it, k) => {
      if (k) cx += space;
      const start = t0 + (reduced ? 0 : it.i * EASE_STAGGER);
      const p = (t - start) / (reduced ? 0.5 : WORD_IN);
      if (p > 0) {
        const e = easeOutQuart(p);
        const a = clamp01(p * 1.5) * e * exitA;
        const rise = reduced ? 0 : (1 - e) * 10;
        ctx.globalAlpha = G0 * (a);
        setFont(ctx, face(it.italic));
        ctx.fillStyle = it.italic ? acc : ink;
        ctx.fillText(it.word, cx, base + rise + drift);
        if (it.punct) {
          setFont(ctx, face(false));
          ctx.fillStyle = ink;
          ctx.fillText(it.punct, cx + it.ww + size * 0.02, base + rise + drift);
        }
      }
      cx += it.w;
    });
  });
  ctx.restore();
  return { x: left, y: top, w, h, lines: lines.length };
}

// ---------------------------------------------------------------- label

/**
 * Small mono uppercase label with an optional leader line to tick = {x, y}.
 * (x, y): text anchor point (align left|center|right), y = text middle.
 * swatch: 'cobalt'|'amber'|'green'|'coral'|null draws a key square before the text
 * (amber can't be text on cream, so waves are keyed by swatch, not by text colour).
 */
export function label(ctx, props) {
  const {
    text = '',
    x = 0,
    y = 0,
    t = 0,
    t0 = -Infinity,
    t1 = Infinity,
    theme = 'dark',
    align = 'left',
    size = 20,
    tick = null,
    swatch = null,
    alpha = 1,
    track = 0.14,
    scrim = null,
    reduced = false,
  } = props;
  if (t < t0 || t > t1) return null;
  const inK = Number.isFinite(t0) ? (t - t0) / 0.4 : 1;
  const outK = Number.isFinite(t1) ? smoothstep((t - (t1 - 0.35)) / 0.35) : 0;
  const e = easeOutQuart(inK);
  const a = alpha * clamp01(inK * 1.4) * (1 - outK);
  if (a <= 0) return null;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  setFont(ctx, { family: FONTS.mono, size, weight: 400, track });
  const s = String(text).toUpperCase();
  const tw = textW(ctx, s);
  const sw = swatch ? size * 0.62 : 0;
  const sg = swatch ? size * 0.72 : 0;
  const w = tw + sw + sg;
  // Keep the box inside the frame (40..1880): flip the alignment to the other side
  // of the tick when it would run off an edge, then clamp.
  let al = align;
  let ax = x;
  if (al === 'left' && x + w > 1880) {
    al = 'right';
    ax = tick ? tick.x - 30 : 1880;
  } else if (al === 'right' && x - w < 40) {
    al = 'left';
    ax = tick ? tick.x + 30 : 40;
  }
  let left = al === 'center' ? ax - w / 2 : al === 'right' ? ax - w : ax;
  left = Math.max(40, Math.min(1880 - w, left));
  const color = theme === 'dark' ? rgba(TOKENS.paper, 0.86) : TOKENS.labelInk;
  const rise = reduced ? 0 : (1 - e) * 4;

  if (tick) {
    const tk = reduced ? 1 : easeOutQuart(Number.isFinite(t0) ? (t - t0 - 0.1) / 0.6 : 1);
    const bx0 = left - 12;
    const bx1 = left + w + 12;
    let sx;
    let sy;
    if (Math.abs(tick.y - y) > size * 1.6) {
      sx = Math.max(left, Math.min(left + w, tick.x));
      sy = tick.y > y ? y + size * 0.9 : y - size * 0.9;
    } else {
      sx = tick.x > left + w / 2 ? bx1 : bx0;
      sy = y;
    }
    const ex = lerp(sx, tick.x, tk);
    const ey = lerp(sy, tick.y, tk);
    ctx.globalAlpha = G0 * (a * 0.8);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    if (tk > 0.9) {
      const ra = (tk - 0.9) / 0.1;
      ctx.globalAlpha = G0 * (a * ra);
      ctx.beginPath();
      ctx.arc(tick.x, tick.y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(tick.x, tick.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  const S = scrim ?? (theme === 'dark' ? SCRIM.labelDark : SCRIM.labelLight);
  if (S > 0) {
    ctx.globalAlpha = G0 * (a);
    const sc = theme === 'dark' ? rgba(TOKENS.night, S) : rgba(TOKENS.canvas, S);
    // Two passes: a wide feather plus a tighter core so the worst pixel under the text is covered.
    softScrim(ctx, left - size * 1.2, y - size * 1.4 + rise, w + size * 2.4, size * 2.8, size * 1.4, sc, size * 1.4);
    softScrim(ctx, left - size * 0.5, y - size * 0.8 + rise, w + size, size * 1.6, size * 0.8, sc, size * 0.6);
  }
  ctx.globalAlpha = G0 * (a);
  if (swatch) {
    const sc = {
      cobalt: theme === 'dark' ? TOKENS.cobaltOnDark : TOKENS.primary,
      amber: TOKENS.warning,
      green: theme === 'dark' ? TOKENS.greenOnDark : TOKENS.green,
      coral: TOKENS.coral,
    }[swatch] || swatch;
    ctx.fillStyle = sc;
    rrPath(ctx, left, y - sw / 2 + rise, sw, sw, 2);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.fillText(s, left + sw + sg, y + rise);
  ctx.restore();
  return { x: left, y: y - size * 0.7, w, h: size * 1.4 };
}

// ---------------------------------------------------------------- call bar

/**
 * Call-in-progress strip: live dot, label, timer; the caller's words below as a
 * ruled quote, typed by callerProgress. status 'answered' swaps the dot for a
 * check and the label for answeredText (crossfade by statusProgress).
 * (x, y) = top-left. Returns { x, y, w, h, pill: {x,y,w,h} }.
 */
export function callBar(ctx, props) {
  const {
    x = 96,
    y = 96,
    t = 0,
    timer = '00:00',
    status = 'live',
    caller = null,
    callerProgress = 1,
    alpha = 1,
    theme = 'dark',
    label: lab = 'Call in progress',
    answeredText = 'Answered with source',
    statusProgress = 1,
    callerSize = 36,
    callerMaxWidth = 1100,
  } = props;
  if (alpha <= 0) return null;
  const dark = theme === 'dark';
  const text = dark ? TOKENS.paper : TOKENS.ink;
  const sub = dark ? rgba(TOKENS.paper, 0.72) : TOKENS.mutedFg;
  const ans = status === 'answered' ? easeOutQuart(statusProgress) : 0;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  ctx.globalAlpha = G0 * (alpha);
  ctx.textBaseline = 'middle';
  const H = 64;
  const padX = 28;
  setFont(ctx, { family: FONTS.mono, size: 18, track: 0.14 });
  const l1 = String(lab).toUpperCase();
  const l2 = String(answeredText).toUpperCase();
  const lw = Math.max(textW(ctx, l1), status === 'answered' ? textW(ctx, l2) : 0);
  setFont(ctx, { family: FONTS.mono, size: 22, track: 0.04 });
  const tw = textW(ctx, timer);
  const W = padX + 22 + 16 + lw + 24 + 1.5 + 24 + tw + padX;

  // Pill surface.
  rrPath(ctx, x, y, W, H, H / 2);
  if (dark) {
    ctx.fillStyle = rgba(TOKENS.night, 0.74);
    ctx.fill();
    ctx.fillStyle = rgba(TOKENS.paper, 0.06);
    ctx.fill();
    ctx.strokeStyle = rgba(TOKENS.paper, 0.2);
  } else {
    shadow(ctx, rgba(TOKENS.ink, 0.06), 20, 0, 6);
    ctx.fillStyle = TOKENS.card;
    ctx.fill();
    noShadow(ctx);
    ctx.strokeStyle = TOKENS.border;
  }
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const cy = y + H / 2;
  const dx = x + padX + 11;
  // Live dot with a deterministic pulse from t.
  if (ans < 1) {
    const ph = (((t % 1.6) + 1.6) % 1.6) / 1.6;
    ctx.globalAlpha = G0 * (alpha * (1 - ans));
    ctx.beginPath();
    ctx.arc(dx, cy, 7 + 12 * easeOutQuart(ph), 0, Math.PI * 2);
    ctx.fillStyle = rgba(TOKENS.coral, 0.35 * (1 - ph));
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = TOKENS.coral;
    ctx.fill();
  }
  if (ans > 0) {
    ctx.globalAlpha = G0 * (alpha * ans);
    ctx.beginPath();
    ctx.arc(dx, cy, 11 * lerp(0.8, 1, ans), 0, Math.PI * 2);
    ctx.fillStyle = dark ? TOKENS.greenOnDark : TOKENS.success;
    ctx.fill();
    icon(ctx, 'check', dx - 7, cy - 7, 14, dark ? TOKENS.night : TOKENS.onPrimary, 3.4);
  }
  const lx = x + padX + 22 + 16;
  setFont(ctx, { family: FONTS.mono, size: 18, track: 0.14 });
  ctx.fillStyle = text;
  if (ans < 1) {
    ctx.globalAlpha = G0 * (alpha * (1 - ans));
    ctx.fillText(l1, lx, cy + 1 - 6 * ans);
  }
  if (ans > 0) {
    ctx.globalAlpha = G0 * (alpha * ans);
    ctx.fillText(l2, lx, cy + 1 + 6 * (1 - ans));
  }
  ctx.globalAlpha = G0 * (alpha);
  const dvx = lx + lw + 24;
  ctx.fillStyle = dark ? rgba(TOKENS.paper, 0.22) : TOKENS.border;
  ctx.fillRect(dvx, cy - 12, 1.5, 24);
  setFont(ctx, { family: FONTS.mono, size: 22, track: 0.04 });
  ctx.fillStyle = sub;
  ctx.fillText(timer, dvx + 1.5 + 24, cy + 1);

  let h = H;
  let callerRect = null;
  if (caller) {
    setFont(ctx, { family: FONTS.display, size: callerSize, italic: true, weight: 400 });
    const lines = balancedText(ctx, caller, callerMaxWidth);
    const total = lines.join(' ').length;
    const shown = clamp01(callerProgress) * total;
    const lh = callerSize * 1.34;
    const qy = y + H + 28;
    const qx = x + 4;
    const qh = lines.length * lh;
    const ruleA = smoothstep(callerProgress * 8);
    if (ruleA > 0) {
      ctx.globalAlpha = G0 * (alpha * ruleA);
      // Scrim follows the typed text, so it never smears ahead of the words.
      let usedW = 0;
      const widest = Math.max(1, ...lines.map((l) => {
        const n = Math.max(0, Math.min(l.length, shown - usedW));
        usedW += l.length + 1;
        return textW(ctx, l.slice(0, Math.ceil(n)));
      }));
      softScrim(ctx, qx - 40, qy - 16, widest + 28 + 80, qh + 32, 32, dark ? rgba(TOKENS.night, SCRIM.callerDark * 0.5) : rgba(TOKENS.canvas, SCRIM.callerLight * 0.5), 56);
      softScrim(ctx, qx - 20, qy - 4, widest + 28 + 40, qh + 8, 24, dark ? rgba(TOKENS.night, SCRIM.callerDark) : rgba(TOKENS.canvas, SCRIM.callerLight), 24);
    }
    ctx.globalAlpha = G0 * (alpha * ruleA);
    ctx.fillStyle = dark ? TOKENS.warning : TOKENS.warning;
    ctx.fillRect(qx, qy + 4, 3, qh - 8);
    ctx.globalAlpha = G0 * (alpha);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = text;
    let used = 0;
    let caret = null;
    lines.forEach((ln, i) => {
      const base = qy + lh * i + lh * 0.5 + callerSize * 0.32;
      const n = Math.max(0, Math.min(ln.length, shown - used));
      const whole = Math.floor(n);
      const frac = n - whole;
      const tx = qx + 28;
      if (whole > 0) ctx.fillText(ln.slice(0, whole), tx, base);
      const pw = textW(ctx, ln.slice(0, whole));
      if (frac > 0 && whole < ln.length) {
        ctx.globalAlpha = G0 * (alpha * frac);
        ctx.fillText(ln[whole], tx + pw, base);
        ctx.globalAlpha = G0 * (alpha);
      }
      if (n > 0 && n < ln.length + 1) caret = { x: tx + pw + (frac > 0 ? textW(ctx, ln[whole] || '') * frac : 0), base };
      used += ln.length + 1;
    });
    if (callerProgress > 0 && callerProgress < 1 && caret && (t * 2) % 2 < 1.4) {
      ctx.fillStyle = dark ? rgba(TOKENS.paper, 0.8) : TOKENS.ink;
      ctx.fillRect(caret.x + 3, caret.base - callerSize * 0.74, 2, callerSize * 0.9);
    }
    h = H + 28 + qh;
    setFont(ctx, { family: FONTS.display, size: callerSize, italic: true, weight: 400 });
    callerRect = { x: qx, y: qy, w: 28 + Math.max(...lines.map((l) => textW(ctx, l))), h: qh };
  }
  ctx.restore();
  return { x, y, w: W, h, pill: { x, y, w: W, h: H }, caller: callerRect };
}

// ---------------------------------------------------------------- composer

/**
 * The /chat ask box. (x, y) = top-left, w = width. Text typed by `chars`.
 * press 0..1 shows the Ask button being pressed. focus 0..1 (default: on while typing).
 * Returns { x, y, w, h, button: {x,y,w,h}, caret: {x,y} }.
 */
export function composer(ctx, props) {
  const {
    x = 160,
    y = 700,
    w = 880,
    text = '',
    chars = Infinity,
    caretOn = false,
    alpha = 1,
    theme = 'light',
    progress = 1,
    press = 0,
    focus = null,
    placeholder = '',
    labelText = 'Ask a question',
    buttonText = 'Ask',
    hintKey = 'Enter',
    hintText = 'to ask',
  } = props;
  const e = easeOutQuart(progress);
  const a = alpha * clamp01(progress * 1.4);
  if (a <= 0) return null;
  const pad = 24;
  const bodySize = 28;
  const lh = bodySize * 1.5;
  const innerW = w - pad * 2;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  ctx.translate(0, (1 - e) * 8);
  ctx.globalAlpha = G0 * (a);
  const shown = String(text).slice(0, Math.max(0, Math.floor(Math.min(chars, text.length))));
  setFont(ctx, { size: bodySize });
  const lines = shown ? greedyLines(ctx, shown, innerW) : [];
  const inputH = Math.max(lh * 2, lines.length * lh);
  const H = pad + 20 + 20 + inputH + 20 + 56 + pad;
  const foc = focus === null ? (chars > 0 || caretOn ? 1 : 0) : focus;

  ctx.save();
  if (theme === 'dark') shadow(ctx, 'rgba(0,0,0,0.4)', 84, 0, 32);
  else shadow(ctx, rgba(TOKENS.ink, 0.1), 84, 0, 32);
  rrPath(ctx, x, y, w, H, 28);
  ctx.fillStyle = TOKENS.card;
  ctx.fill();
  shadow(ctx, rgba(TOKENS.ink, 0.05), 9, 0, 3);
  ctx.fill();
  noShadow(ctx);
  if (foc > 0) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = rgba(TOKENS.primary, 0.11 * foc);
    rrPath(ctx, x - 3, y - 3, w + 6, H + 6, 31);
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = foc > 0 ? mixHex('#DCDBD8', TOKENS.primary, 0.65 * foc) : rgba(TOKENS.ink, 0.14);
  rrPath(ctx, x, y, w, H, 28);
  ctx.stroke();
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  setFont(ctx, { size: 18, weight: 600, track: 0.13 });
  ctx.fillStyle = TOKENS.primary;
  ctx.fillText(String(labelText).toUpperCase(), x + pad, y + pad + 16);

  const iy = y + pad + 20 + 20;
  setFont(ctx, { size: bodySize });
  let caret = { x: x + pad, y: iy };
  if (lines.length) {
    ctx.fillStyle = TOKENS.ink;
    lines.forEach((ln, i) => {
      ctx.fillText(ln, x + pad, iy + lh * i + lh * 0.5 + bodySize * 0.36);
    });
    const li = lines.length - 1;
    caret = { x: x + pad + textW(ctx, lines[li]) + 2, y: iy + lh * li };
  } else if (placeholder) {
    ctx.fillStyle = TOKENS.mutedFg;
    ctx.fillText(placeholder, x + pad, iy + lh * 0.5 + bodySize * 0.36);
  }
  if (caretOn) {
    ctx.fillStyle = TOKENS.ink;
    ctx.fillRect(caret.x + 1, caret.y + (lh - bodySize * 1.1) / 2, 2.5, bodySize * 1.1);
  }

  // Footer row: kbd hint, Ask pill.
  const fy = iy + inputH + 20;
  const midY = fy + 28;
  ctx.textBaseline = 'middle';
  if (hintKey) {
    setFont(ctx, { family: FONTS.mono, size: 18 });
    const kw = textW(ctx, hintKey) + 20;
    rrPath(ctx, x + pad, midY - 16, kw, 32, 8);
    ctx.fillStyle = TOKENS.muted;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = TOKENS.border;
    ctx.stroke();
    ctx.fillStyle = TOKENS.ink;
    ctx.fillText(hintKey, x + pad + 10, midY + 1);
    setFont(ctx, { size: 20 });
    ctx.fillStyle = TOKENS.mutedFg;
    ctx.fillText(hintText, x + pad + kw + 10, midY + 1);
  }
  setFont(ctx, { size: 26 });
  const bw = Math.max(168, textW(ctx, buttonText) + 72);
  const bh = 56;
  const bx = x + w - pad - bw;
  const by = fy;
  const pk = clamp01(press);
  ctx.save();
  // Disabled (opacity 50%) until there is text, as in the app.
  if (!lines.length) ctx.globalAlpha *= 0.5;
  const sc = 1 - 0.03 * Math.sin(pk * Math.PI);
  ctx.translate(bx + bw / 2, by + bh / 2);
  ctx.scale(sc, sc);
  ctx.translate(-(bx + bw / 2), -(by + bh / 2));
  shadow(ctx, rgba(TOKENS.primary, 0.25 * (1 - pk * 0.5)), 16, 0, 6);
  rrPath(ctx, bx, by, bw, bh, bh / 2);
  ctx.fillStyle = pk > 0 ? mixHex(TOKENS.primary, TOKENS.accent, Math.sin(pk * Math.PI) * 0.8) : TOKENS.primary;
  ctx.fill();
  noShadow(ctx);
  ctx.fillStyle = TOKENS.onPrimary;
  ctx.textAlign = 'center';
  ctx.fillText(buttonText, bx + bw / 2, by + bh / 2 + 1);
  ctx.restore();

  ctx.restore();
  const dy = (1 - e) * 8;
  return {
    x,
    y: y + dy,
    w,
    h: H,
    button: { x: bx, y: by + dy, w: bw, h: bh },
    caret: { x: caret.x, y: caret.y + dy },
  };
}

// ---------------------------------------------------------------- question row

const Q_SIZE = 26;
const Q_LH = Q_SIZE * 1.5;

function drawQuestion(ctx, x, y, w, question, theme, a) {
  const dark = theme === 'dark';
  ctx.save();
  ctx.globalAlpha *= a;
  const bs = 44;
  setFont(ctx, { size: Q_SIZE });
  const qLines = niceText(ctx, question, w - bs - 16);
  const qw = Math.max(...qLines.map((l) => textW(ctx, l)));
  const qh = Math.max(bs, 4 + qLines.length * Q_LH);
  softScrim(ctx, x - 20, y - 12, bs + 16 + qw + 40, qh + 24, 24, dark ? rgba(TOKENS.night, SCRIM.labelDark) : rgba(TOKENS.canvas, SCRIM.questionLight), 24);
  rrPath(ctx, x, y, bs, bs, 14);
  ctx.fillStyle = dark ? TOKENS.paper : TOKENS.ink;
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, { family: FONTS.display, size: 22, weight: 600 });
  ctx.fillStyle = dark ? TOKENS.night : TOKENS.card;
  ctx.fillText('Q', x + bs / 2, y + bs / 2 + 22 * 0.35);
  ctx.textAlign = 'left';
  setFont(ctx, { size: Q_SIZE });
  const lines = qLines;
  const lh = Q_LH;
  ctx.fillStyle = dark ? TOKENS.paper : TOKENS.ink;
  lines.forEach((ln, i) => ctx.fillText(ln, x + bs + 16, y + 4 + lh * i + lh * 0.5 + Q_SIZE * 0.36));
  ctx.restore();
  return Math.max(bs, 4 + lines.length * lh);
}
function measureQuestion(ctx, w, question) {
  ctx.save();
  setFont(ctx, { size: Q_SIZE });
  const n = greedyLines(ctx, question, w - 44 - 16).length;
  ctx.restore();
  return Math.max(44, 4 + n * Q_LH);
}

/**
 * The "Q" chip + question, exactly as answerCard and refusalCard echo it (same
 * x/y/w gives the same pixels), so the question can stay on screen between Ask and
 * the card. progress: 4 px rise + fade. Returns { x, y, w, h }.
 */
export function questionRow(ctx, props) {
  const { x = 96, y = 300, w = 760, text = '', alpha = 1, progress = 1, theme = 'light' } = props;
  const a = alpha * clamp01(progress * 1.4);
  if (a <= 0 || !text) return null;
  const dy = (1 - easeOutQuart(progress)) * 4;
  ctx.save();
  ctx.globalAlpha *= a;
  const h = drawQuestion(ctx, x, y + dy, w, text, theme, 1);
  ctx.restore();
  return { x, y: y + dy, w, h };
}

// ---------------------------------------------------------------- answer card

function tokenizeAnswer(answer, citeIndex) {
  const out = [];
  let hasChip = false;
  for (const raw of String(answer).split(/\s+/).filter(Boolean)) {
    const m = /^(.*?)\[(\d+)\]([.,;:]?)$/.exec(raw);
    if (m) {
      if (m[1]) out.push({ kind: 'word', s: m[1] });
      out.push({ kind: 'chip', n: m[2], tail: m[3] });
      hasChip = true;
    } else {
      const b = /^\*\*(.+?)\*\*([.,;:!?]*)$/.exec(raw);
      if (b) out.push({ kind: 'word', s: b[1], bold: true, tail: b[2] });
      else out.push({ kind: 'word', s: raw.replace(/\*\*/g, '') });
    }
  }
  if (!hasChip && citeIndex != null) out.push({ kind: 'chip', n: String(citeIndex), tail: '' });
  return out;
}

/**
 * Answer card faithful to AnswerView: question echo row, card with the
 * gradient hairline, ANSWER kicker, body with inline [n] chip, receipt strip
 * (count medallion + "<receiptLabel> · <docTitle>"), footer icons.
 * progress: 0..0.45 card arrives (8 px rise + fade), 0.3..1 words print.
 * receiptProgress: receipt strip's own 6 px rise + fade. chipHot 0..1 glows the chip.
 * Returns { rect, chip: {x,y,w,h}, chipCenter: {x,y}, receipt: {x,y,w,h}, question: {x,y,w,h} }.
 */
export function answerCard(ctx, props) {
  const {
    x = 160,
    y = 160,
    w = 880,
    question = '',
    answer = '',
    citeIndex = 1,
    docTitle = '',
    progress = 1,
    receiptProgress = 1,
    chipHot = 0,
    alpha = 1,
    theme = 'light',
    sourceCount = 1,
    receiptLabel = null,
    kicker = 'Answer',
    showQuestion = true,
    questionAlpha = 1,
    footer = true,
  } = props;
  const cardK = easeOutQuart(progress / 0.45);
  const a = alpha * clamp01((progress / 0.45) * 1.4);
  const pad = 32;
  const bodySize = 32;
  const lh = 46;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  let qh = 0;
  if (showQuestion && question) qh = measureQuestion(ctx, w, question) + 28;
  const cy = y + qh;
  const innerW = w - pad * 2;

  // Layout the answer body with the inline chip.
  const toks = tokenizeAnswer(answer, citeIndex);
  setFont(ctx, { size: bodySize });
  const space = textW(ctx, 'a a') - textW(ctx, 'aa');
  const chipSize = 26;
  const items = toks.map((tk) => {
    if (tk.kind === 'word') {
      setFont(ctx, { size: bodySize, weight: tk.bold ? 600 : 400 });
      const bw = textW(ctx, tk.s);
      setFont(ctx, { size: bodySize });
      const tw = tk.tail ? textW(ctx, tk.tail) : 0;
      return { ...tk, bw, w: bw + tw };
    }
    setFont(ctx, { size: chipSize, weight: 400 });
    const cw = textW(ctx, `[${tk.n}]`) + 32;
    setFont(ctx, { size: bodySize });
    const tw = tk.tail ? textW(ctx, tk.tail) : 0;
    return { ...tk, cw, tw, w: cw + 8 + tw };
  });
  // Full measure unless the last line would hold one word (the chip does not count).
  let lines = wrapItems(items, innerW, () => space);
  const lastWords = lines[lines.length - 1].filter((it) => it.kind === 'word').length;
  if (lines.length > 1 && lastWords <= 1) lines = balancedLines(items, innerW, () => space);
  const bodyH = lines.length * lh;
  const RS = 24; // receipt text
  const RM = 28; // medallion radius
  setFont(ctx, { size: RS, weight: 400, track: 0.04 });
  const rLabel = receiptLabel || (sourceCount === 1 ? 'Source passage' : 'Source passages');
  const rPrefix = `${rLabel} · `.toUpperCase();
  const rTitle = String(docTitle).toUpperCase();
  const rTextW = innerW - 20 * 2 - RM * 2 - 16;
  const rFits = textW(ctx, rPrefix + rTitle) <= rTextW;
  const receiptH = rFits ? RM * 2 + 32 : 2 * 34 + 32;
  const kickH = 24;
  const H = 4 + pad + kickH + 20 + bodyH + (docTitle ? 28 + receiptH : 0) + (footer ? 28 + 1.5 + 20 + 36 : 0) + pad - 4;

  const dy = (1 - cardK) * 8;
  ctx.globalAlpha = G0 * (a);
  // The echo does not ride the card's arrival: same pixels as questionRow(), clean handover.
  if (qh && questionAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = G0 * (alpha * questionAlpha);
    drawQuestion(ctx, x, y, w, question, theme, 1);
    ctx.restore();
  }
  ctx.translate(0, dy);

  cardSurface(ctx, x, cy, w, H, 28, theme);
  // Gradient hairline along the top edge (answer-surface::before).
  ctx.save();
  rrPath(ctx, x, cy, w, H, 28);
  ctx.clip();
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, TOKENS.primary);
  g.addColorStop(0.5, TOKENS.green);
  g.addColorStop(1, TOKENS.coral);
  ctx.globalAlpha = G0 * (a * 0.65);
  ctx.fillStyle = g;
  ctx.fillRect(x, cy, w, 4);
  ctx.restore();

  // Kicker.
  let yy = cy + 4 + pad - 4;
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  ctx.arc(x + pad + 7, yy + kickH / 2, 14, 0, Math.PI * 2);
  ctx.fillStyle = rgba(TOKENS.success, 0.12);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + pad + 7, yy + kickH / 2, 7, 0, Math.PI * 2);
  ctx.fillStyle = TOKENS.success;
  ctx.fill();
  setFont(ctx, { size: 20, weight: 600, track: 0.14 });
  ctx.fillText(String(kicker).toUpperCase(), x + pad + 28, yy + kickH / 2 + 1);
  yy += kickH + 20;

  // Body words print across progress 0.3..1.
  const nItems = items.length;
  let chipRect = null;
  let idx = 0;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, li) => {
    let cx = x + pad;
    const base = yy + lh * li + lh * 0.5 + bodySize * 0.36;
    line.forEach((it, k) => {
      if (k) cx += space;
      const start = 0.3 + (0.55 * idx) / Math.max(1, nItems);
      const wp = clamp01((progress - start) / 0.15);
      const wa = a * wp;
      if (it.kind === 'word') {
        ctx.globalAlpha = G0 * (wa);
        setFont(ctx, { size: bodySize, weight: it.bold ? 600 : 400 });
        ctx.fillStyle = TOKENS.ink;
        ctx.fillText(it.s, cx, base);
        if (it.tail) {
          setFont(ctx, { size: bodySize });
          ctx.fillText(it.tail, cx + it.bw, base);
        }
      } else {
        const chx = cx + 4;
        const chh = 44;
        const chy = base - bodySize * 0.36 - chh / 2;
        const hot = clamp01(chipHot);
        chipRect = { x: chx, y: chy + dy, w: it.cw, h: chh };
        ctx.globalAlpha = G0 * (wa);
        if (hot > 0) {
          ctx.save();
          shadow(ctx, rgba(TOKENS.primary, 0.55 * hot), 28, 0, 0);
          rrPath(ctx, chx, chy, it.cw, chh, chh / 2);
          ctx.fillStyle = rgba(TOKENS.primary, 0.2 * hot);
          ctx.fill();
          noShadow(ctx);
          ctx.lineWidth = 4;
          ctx.strokeStyle = rgba(TOKENS.primary, 0.22 * hot);
          rrPath(ctx, chx - 4, chy - 4, it.cw + 8, chh + 8, chh / 2 + 4);
          ctx.stroke();
          ctx.restore();
        }
        rrPath(ctx, chx, chy, it.cw, chh, chh / 2);
        ctx.fillStyle = TOKENS.card;
        ctx.fill();
        ctx.fillStyle = rgba(TOKENS.primary, 0.1 + 0.15 * hot);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = rgba(TOKENS.primary, 0.3 + 0.3 * hot);
        ctx.stroke();
        setFont(ctx, { size: chipSize });
        ctx.fillStyle = TOKENS.primary;
        ctx.textAlign = 'center';
        ctx.fillText(`[${it.n}]`, chx + it.cw / 2, chy + chh / 2 + chipSize * 0.36);
        ctx.textAlign = 'left';
        if (it.tail) {
          setFont(ctx, { size: bodySize });
          ctx.fillStyle = TOKENS.ink;
          ctx.fillText(it.tail, chx + it.cw + 4, base);
        }
      }
      cx += it.w;
      idx += 1;
    });
  });
  yy += bodyH;

  // Receipt strip.
  let receiptRect = null;
  if (docTitle) {
    yy += 28;
    const rk = easeOutQuart(receiptProgress);
    const ra = a * clamp01(receiptProgress * 1.5);
    const ry = yy + (1 - rk) * 6;
    receiptRect = { x: x + pad, y: ry + dy, w: innerW, h: receiptH };
    ctx.globalAlpha = G0 * (ra);
    rrPath(ctx, x + pad, ry, innerW, receiptH, 20);
    ctx.fillStyle = rgba(TOKENS.primary, 0.07);
    ctx.fill();
    const mx = x + pad + 20 + RM;
    const my = ry + receiptH / 2;
    ctx.beginPath();
    ctx.arc(mx, my, RM, 0, Math.PI * 2);
    ctx.fillStyle = TOKENS.primary;
    ctx.fill();
    setFont(ctx, { size: 26 });
    ctx.fillStyle = TOKENS.onPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(sourceCount), mx, my + 1);
    ctx.textAlign = 'left';
    setFont(ctx, { size: RS, track: 0.04 });
    ctx.fillStyle = TOKENS.primary;
    const tx = mx + RM + 16;
    const drawTitle = (s, px, py) => {
      ctx.fillText(s, px, py);
      const tw = textW(ctx, s);
      ctx.fillRect(px, py + 16, tw, 2);
    };
    if (rFits) {
      ctx.fillText(rPrefix, tx, my + 1);
      drawTitle(rTitle, tx + textW(ctx, rPrefix) + 0.04 * RS, my + 1);
    } else {
      ctx.fillText(rPrefix.trim(), tx, my - 16);
      drawTitle(rTitle, tx, my + 18);
    }
    yy += receiptH;
  }

  // Footer: hairline, copy + thumbs icons right-aligned.
  if (footer) {
    yy += 28;
    ctx.globalAlpha = G0 * (a);
    ctx.fillStyle = TOKENS.border;
    ctx.fillRect(x + pad, yy, innerW, 1.5);
    yy += 1.5 + 20;
    const ic = 32;
    const names = ['copy', 'thumbsUp', 'thumbsDown'];
    names.forEach((n, i) => {
      icon(ctx, n, x + w - pad - (names.length - i) * (ic + 20) + 20, yy + 2, ic, TOKENS.mutedFg, 1.8);
    });
  }
  ctx.restore();
  const rect = { x, y: cy + dy, w, h: H };
  return {
    rect,
    chip: chipRect,
    chipCenter: chipRect ? { x: chipRect.x + chipRect.w / 2, y: chipRect.y + chipRect.h / 2 } : null,
    chipAnchor: chipRect ? { x: chipRect.x + chipRect.w, y: chipRect.y + chipRect.h / 2 } : null,
    receipt: receiptRect,
    question: qh ? { x, y, w, h: qh - 28 } : null,
  };
}

// ---------------------------------------------------------------- citation panel

/**
 * Raw markdown lines for a section + table, written the way the seeded document
 * stores them ("| Basic | $5 |", "| --- | --- |"). Shared with tileText callers.
 */
export function markdownExcerpt(section, rows) {
  const lines = [];
  if (section) lines.push(`## ${section}`, '');
  if (rows && rows.length) {
    lines.push(`| ${rows[0].join(' | ')} |`);
    lines.push(`| ${rows[0].map(() => '---').join(' | ')} |`);
    rows.slice(1).forEach((r) => lines.push(`| ${r.join(' | ')} |`));
  }
  return lines;
}

/**
 * Source panel faithful to CitationPanel: eyebrow, doc title + version pill, close X,
 * the excerpt as raw markdown in a mono inset block (the product does not render or
 * tint rows). With `h`, the excerpt block grows to fill the panel: mono size fits
 * width and height (up to maxMono, default 30), leading opens up to 2.0.
 * Excerpt: `excerpt` (string, \n lines) or `section` + `rows` (first row = header),
 * via markdownExcerpt(). The excerpt renders verbatim, one ink, as the app's <pre>.
 * highlightRow: a substring of a line ("| Basic | $5 |"), or with rows an index into
 * rows (0 = header). That line's rect is returned for the thread. Nothing is tinted.
 * version: the "Version N" badge beside the title, as the app shows it.
 * surface: false draws only the content (no card fill, border or shadow) for a
 * panel whose paper is a lit 3D tile.
 * Returns { rect, row, rowAnchor: {x,y} (left edge, centred), excerpt, mono }.
 */
export function citationPanel(ctx, props) {
  const {
    x = 1060,
    y = 140,
    w = 720,
    h = null,
    docTitle = '',
    version = null,
    section = null,
    rows = null,
    excerpt = null,
    highlightRow = null,
    progress = 1,
    alpha = 1,
    theme = 'light',
    eyebrow = 'Source passage',
    linkText = null,
    surface = true,
    maxMono = 30,
  } = props;
  const e = easeOutQuart(progress);
  const a = alpha * clamp01(progress * 1.4);
  if (a <= 0) return null;
  let lines;
  let hiLine = -1;
  if (excerpt != null) {
    lines = String(excerpt).split('\n');
  } else {
    lines = markdownExcerpt(section, rows);
    if (typeof highlightRow === 'number' && rows) {
      const head = lines.length - rows.length - 1; // header line; separator follows it
      hiLine = highlightRow === 0 ? head : head + 1 + highlightRow;
    }
  }
  if (typeof highlightRow === 'string') hiLine = lines.findIndex((l) => l.includes(highlightRow));

  const dx = surface ? (1 - e) * 28 : 0;
  const px = x + dx;
  const padX = 28;
  const headH = 20 + 20 + 12 + 34 + 22;
  const inset = 24;
  const bodyPad = 28;
  const linkH = linkText ? 20 + 52 : 0;
  const units = lines.length;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  setFont(ctx, { family: FONTS.mono, size: 100 });
  const widest = Math.max(1, ...lines.map((l) => textW(ctx, l)));
  const availW = w - bodyPad * 2 - inset * 2;
  let mono = Math.min(maxMono, (100 * availW) / widest);
  let lead = 1.7;
  let H = h;
  let blockH;
  if (h != null) {
    blockH = h - headH - bodyPad * 2 - linkH;
    const textH = blockH - inset * 2;
    mono = Math.max(10, Math.min(mono, textH / (units * lead)));
    lead = Math.min(2.0, textH / (units * mono));
  } else {
    blockH = units * mono * lead + inset * 2;
    H = headH + bodyPad * 2 + blockH + linkH;
  }
  const lh = mono * lead;
  ctx.globalAlpha = G0 * (a);
  if (surface) {
    ctx.save();
    if (theme === 'dark') shadow(ctx, 'rgba(0,0,0,0.4)', 42, 0, 14);
    else shadow(ctx, rgba(TOKENS.ink, 0.1), 42, 0, 14);
    rrPath(ctx, px, y, w, H, 16);
    ctx.fillStyle = TOKENS.card;
    ctx.fill();
    shadow(ctx, rgba(TOKENS.ink, 0.06), 4, 0, 2);
    ctx.fill();
    noShadow(ctx);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = TOKENS.border;
    ctx.stroke();
    ctx.restore();
  }

  // Header.
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, { size: 20, track: 0.06 });
  // Darker than mutedFg: this sits on the tile's tan paper, not on a card.
  ctx.fillStyle = '#48463E';
  ctx.fillText(String(eyebrow).toUpperCase(), px + padX, y + 20 + 17);
  setFont(ctx, { size: 28 });
  ctx.fillStyle = TOKENS.ink;
  const ty = y + 20 + 20 + 12 + 17 + 10;
  ctx.fillText(docTitle, px + padX, ty);
  if (version != null) {
    const vx = px + padX + textW(ctx, docTitle) + 16;
    setFont(ctx, { size: 20 });
    const vs = `Version ${version}`;
    const vw = textW(ctx, vs) + 28;
    rrPath(ctx, vx, ty - 10 - 17, vw, 34, 17);
    ctx.fillStyle = TOKENS.muted;
    ctx.fill();
    ctx.fillStyle = TOKENS.mutedFg;
    ctx.textBaseline = 'middle';
    ctx.fillText(vs, vx + 14, ty - 10 + 1);
    ctx.textBaseline = 'alphabetic';
  }
  icon(ctx, 'x', px + w - padX - 26, y + headH / 2 - 13, 26, TOKENS.mutedFg, 2);
  ctx.fillStyle = TOKENS.border;
  ctx.fillRect(px + (surface ? 0 : padX), y + headH, w - (surface ? 0 : padX * 2), 1.5);

  // Excerpt inset: mono, vertically centred in the block.
  const ex = px + bodyPad;
  const ey = y + headH + bodyPad;
  const ew = w - bodyPad * 2;
  rrPath(ctx, ex, ey, ew, blockH, 12);
  ctx.fillStyle = surface ? TOKENS.muted : rgba(TOKENS.muted, 0.85);
  ctx.fill();
  ctx.save();
  rrPath(ctx, ex, ey, ew, blockH, 12);
  ctx.clip();
  setFont(ctx, { family: FONTS.mono, size: mono });
  let ly = ey + (blockH - units * lh) / 2;
  let rowRect = null;
  ctx.fillStyle = TOKENS.ink;
  lines.forEach((ln, i) => {
    const hh = lh;
    if (ln.trim()) ctx.fillText(ln, ex + inset, ly + hh * 0.5 + mono * 0.34);
    if (i === hiLine) rowRect = { x: ex + inset - 10, y: ly, w: textW(ctx, ln) + 20, h: hh };
    ly += hh;
  });
  ctx.restore();

  if (linkText) {
    const lky = ey + blockH + 20;
    setFont(ctx, { size: 22 });
    const lw = textW(ctx, linkText) + 28 + 12 + 40;
    rrPath(ctx, ex, lky, lw, 52, 26);
    ctx.fillStyle = TOKENS.secondary;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = TOKENS.border;
    ctx.stroke();
    icon(ctx, 'book', ex + 20, lky + 13, 26, TOKENS.ink, 1.8);
    ctx.fillStyle = TOKENS.ink;
    ctx.textBaseline = 'middle';
    ctx.fillText(linkText, ex + 20 + 28 + 12, lky + 27);
  }
  ctx.restore();
  return {
    rect: { x: px, y, w, h: H },
    row: rowRect,
    rowAnchor: rowRect ? { x: rowRect.x, y: rowRect.y + rowRect.h / 2 } : null,
    excerpt: { x: ex, y: ey, w: ew, h: blockH },
    mono,
  };
}

// ---------------------------------------------------------------- tile text

/**
 * Mono text printed on a projected paper tile. quad = [tl, tr, br, bl] in design px
 * (screen space). Mapped with the average affine of the quad's edges (fine for the
 * mild perspective of a top-down camera). Text auto-fits the tile inside `pad`
 * (fraction of the short side) with 1.5 leading; `size` caps it in tile units, where
 * the tile is 1000 units wide. highlight: index of a line inked in highlightInk.
 * Returns { size } in tile units.
 */
export function tileText(ctx, props) {
  const {
    quad,
    lines = [],
    alpha = 1,
    ink = TOKENS.ink,
    align = 'left',
    pad = 0.12,
    size = null,
    weight = 400,
    highlight = -1,
    highlightInk = TOKENS.primary,
  } = props;
  if (!quad || quad.length < 4 || alpha <= 0 || !lines.length) return null;
  const [tl, tr, br, bl] = quad;
  const ux = (tr[0] - tl[0] + br[0] - bl[0]) / 2;
  const uy = (tr[1] - tl[1] + br[1] - bl[1]) / 2;
  const vx = (bl[0] - tl[0] + br[0] - tr[0]) / 2;
  const vy = (bl[1] - tl[1] + br[1] - tr[1]) / 2;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1 || lv < 1) return null;
  const cx = (tl[0] + tr[0] + br[0] + bl[0]) / 4;
  const cy = (tl[1] + tr[1] + br[1] + bl[1]) / 4;
  const LW = 1000;
  const LH = (1000 * lv) / lu;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.transform(ux / LW, uy / LW, vx / LH, vy / LH, cx - ux / 2 - vx / 2, cy - uy / 2 - vy / 2);
  const p = pad * Math.min(LW, LH);
  setFont(ctx, { family: FONTS.mono, size: 100, weight });
  const widest = Math.max(1, ...lines.map((l) => textW(ctx, l)));
  let fs = Math.min((100 * (LW - p * 2)) / widest, (LH - p * 2) / (lines.length * 1.5));
  if (size) fs = Math.min(fs, size);
  setFont(ctx, { family: FONTS.mono, size: fs, weight });
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = align === 'center' ? 'center' : 'left';
  const lh = fs * 1.5;
  const top = (LH - lines.length * lh) / 2;
  lines.forEach((ln, i) => {
    ctx.fillStyle = i === highlight ? highlightInk : ink;
    ctx.fillText(ln, align === 'center' ? LW / 2 : p, top + lh * i + lh * 0.5 + fs * 0.34);
  });
  ctx.restore();
  return { size: fs };
}

// ---------------------------------------------------------------- refusal card

/**
 * Refusal card faithful to RefusalView: plain answer card (no gradient hairline),
 * amber chip, answer sentence, muted hint, "Mark as missing" whisper + thumbs.
 * flagged 0..1 crossfades the whisper to flaggedText.
 * Returns { rect, chip: {x,y,w,h}, flag: {x,y,w,h}, question }.
 */
export function refusalCard(ctx, props) {
  const {
    x = 520,
    y = 200,
    w = 880,
    question = '',
    answer = REFUSAL_TEXT,
    progress = 1,
    alpha = 1,
    theme = 'light',
    chipText = 'Not found in these documents',
    hint = null,
    flagText = 'Mark as missing',
    flaggedText = 'Marked as missing',
    flagged = 0,
    showQuestion = true,
    questionAlpha = 1,
    footer = true,
  } = props;
  const e = easeOutQuart(progress);
  const a = alpha * clamp01(progress * 1.4);
  if (a <= 0) return null;
  const pad = 32;
  const innerW = w - pad * 2;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  let qh = 0;
  if (showQuestion && question) qh = measureQuestion(ctx, w, question) + 28;
  // The refusal sentence is the card's primary text: a size up from answer body.
  const ansSize = 32;
  setFont(ctx, { size: ansSize });
  const ansLines = niceText(ctx, answer || REFUSAL_TEXT, innerW);
  const alh = ansSize * 1.45;
  setFont(ctx, { size: 24 });
  const hintLines = hint ? niceText(ctx, hint, innerW) : [];
  const hlh = 24 * 1.5;
  const chipH = 40;
  const H = pad + chipH + 20 + ansLines.length * alh + (hintLines.length ? 12 + hintLines.length * hlh : 0) + (footer ? 28 + 1.5 + 20 + 52 : 0) + pad;
  const dy = (1 - e) * 8;
  ctx.globalAlpha = G0 * (a);
  // The echo does not ride the card's arrival: same pixels as questionRow(), clean handover.
  if (qh && questionAlpha > 0) {
    ctx.save();
    ctx.globalAlpha = G0 * (alpha * questionAlpha);
    drawQuestion(ctx, x, y, w, question, theme, 1);
    ctx.restore();
  }
  ctx.translate(0, dy);
  const cy = y + qh;
  cardSurface(ctx, x, cy, w, H, 28, theme);

  let yy = cy + pad;
  setFont(ctx, { size: 20, weight: 600, track: 0.06 });
  const cs = String(chipText).toUpperCase();
  const cw = textW(ctx, cs) + 36;
  rrPath(ctx, x + pad, yy, cw, chipH, chipH / 2);
  ctx.fillStyle = TOKENS.card;
  ctx.fill();
  ctx.fillStyle = rgba(TOKENS.warning, 0.2);
  ctx.fill();
  ctx.fillStyle = TOKENS.warningFg;
  ctx.textBaseline = 'middle';
  ctx.fillText(cs, x + pad + 18, yy + chipH / 2 + 1);
  const chip = { x: x + pad, y: yy + dy, w: cw, h: chipH };
  yy += chipH + 20;

  ctx.textBaseline = 'alphabetic';
  setFont(ctx, { size: ansSize });
  ctx.fillStyle = TOKENS.ink;
  ansLines.forEach((ln, i) => ctx.fillText(ln, x + pad, yy + alh * i + alh * 0.5 + ansSize * 0.36));
  yy += ansLines.length * alh;
  if (hintLines.length) {
    yy += 12;
    setFont(ctx, { size: 24 });
    ctx.fillStyle = TOKENS.mutedFg;
    hintLines.forEach((ln, i) => ctx.fillText(ln, x + pad, yy + hlh * i + hlh * 0.5 + 24 * 0.36));
    yy += hintLines.length * hlh;
  }

  let flag = null;
  if (footer) {
    yy += 28;
    ctx.fillStyle = TOKENS.border;
    ctx.fillRect(x + pad, yy, innerW, 1.5);
    yy += 1.5 + 20;
    const fk = easeOutQuart(Number(flagged));
    setFont(ctx, { size: 22 });
    const fw = Math.max(textW(ctx, flagText), fk > 0 ? textW(ctx, flaggedText) : 0) + 20 + 24 + 12 + 22;
    rrPath(ctx, x + pad, yy, fw, 52, 26);
    ctx.fillStyle = fk > 0 ? mixHex(TOKENS.secondary, TOKENS.muted, fk) : TOKENS.secondary;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = TOKENS.border;
    ctx.stroke();
    icon(ctx, 'flag', x + pad + 20, yy + 14, 24, TOKENS.ink, 2);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = TOKENS.ink;
    if (fk < 1) {
      ctx.globalAlpha = G0 * (a * (1 - fk));
      ctx.fillText(flagText, x + pad + 20 + 24 + 12, yy + 27);
    }
    if (fk > 0) {
      ctx.globalAlpha = G0 * (a * fk);
      ctx.fillText(flaggedText, x + pad + 20 + 24 + 12, yy + 27);
    }
    ctx.globalAlpha = G0 * (a);
    flag = { x: x + pad, y: yy + dy, w: fw, h: 52 };
    const ic = 32;
    ['thumbsUp', 'thumbsDown'].forEach((n, i) => {
      icon(ctx, n, x + w - pad - (2 - i) * (ic + 20) + 20, yy + 10, ic, TOKENS.mutedFg, 1.8);
    });
  }
  ctx.restore();
  return {
    rect: { x, y: cy + dy, w, h: H },
    chip,
    flag,
    question: qh ? { x, y, w, h: qh - 28 } : null,
  };
}

// ---------------------------------------------------------------- guess card

function crackGeometry(x, y, w, h, seedStr) {
  const r = prng(hashStr(seedStr));
  const n = 8;
  const main = [];
  const baseY = y + h * (0.44 + (r() - 0.5) * 0.12);
  for (let i = 0; i <= n; i += 1) {
    const edge = i === 0 || i === n;
    const px = edge ? (i === 0 ? x - 6 : x + w + 6) : x + (w * i) / n + (r() - 0.5) * w * 0.05;
    const py = baseY + (r() - 0.5) * h * 0.16 + (i - n / 2) * h * 0.018;
    main.push([px, py]);
  }
  const k = 3 + Math.floor(r() * 3);
  const b0 = main[k];
  const branch = [
    b0,
    [b0[0] + (r() - 0.3) * w * 0.08, lerp(b0[1], y + h, 0.45)],
    [b0[0] + (r() - 0.2) * w * 0.16, y + h + 6],
  ];
  const TL = [x - 6, y - 6];
  const TR = [x + w + 6, y - 6];
  const BL = [x - 6, y + h + 6];
  const BR = [x + w + 6, y + h + 6];
  const top = [TL, TR, ...main.slice().reverse()];
  const left = [...main.slice(0, k + 1), branch[1], branch[2], BL];
  const right = [...main.slice(k), BR, branch[2], branch[1]];
  return { main, branch, k, pieces: [top, left, right] };
}
function polyPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
  ctx.closePath();
}
function partialPolyline(ctx, pts, frac) {
  if (frac <= 0) return;
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segs.push(l);
    total += l;
  }
  let left = total * clamp01(frac);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length && left > 0; i += 1) {
    const f = Math.min(1, left / segs[i - 1]);
    ctx.lineTo(lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f));
    left -= segs[i - 1];
  }
  ctx.stroke();
}

/**
 * Chapter-1 card: one confident bare answer, no receipt.
 * (x, y) top-left, w x h (default 360 x 240). crack 0..0.45 draws the fracture out
 * from an impact point, 0.45..1 separates three pieces and fades them.
 * theme 'light' = product card; 'dark' = translucent glass card for the ink ground.
 * Returns { rect, pieces: [{x, y}] (current piece centroids, for tile spawns) }.
 */
export function guessCard(ctx, props) {
  const {
    x = 600,
    y = 380,
    w = 360,
    h = 240,
    text = '',
    alpha = 1,
    crack = 0,
    theme = 'light',
    kicker = null,
    progress = 1,
  } = props;
  const e = easeOutQuart(progress);
  const a = alpha * clamp01(progress * 1.4);
  if (a <= 0) return null;
  const dark = theme === 'dark';
  const R = 28;
  const dy = (1 - e) * 8;
  const face = (cx, cyy) => {
    rrPath(ctx, cx, cyy, w, h, R);
    if (dark) {
      ctx.fillStyle = rgba(TOKENS.night, 0.78);
      ctx.fill();
    }
    ctx.fillStyle = dark ? 'rgba(241,239,232,0.09)' : TOKENS.card;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = dark ? rgba(TOKENS.paper, 0.24) : TOKENS.border;
    ctx.stroke();
    if (kicker) {
      ctx.textBaseline = 'middle';
      ctx.beginPath();
      ctx.arc(cx + 32 + 6, cyy + 42, 6, 0, Math.PI * 2);
      ctx.fillStyle = dark ? rgba(TOKENS.paper, 0.6) : TOKENS.mutedFg;
      ctx.fill();
      setFont(ctx, { size: 18, weight: 600, track: 0.14 });
      ctx.fillText(String(kicker).toUpperCase(), cx + 32 + 24, cyy + 43);
    }
    const fs = Math.min(h * 0.46, (w * 0.7) / Math.max(1, String(text).length * 0.5));
    setFont(ctx, { family: FONTS.display, size: fs, weight: 600, track: -0.02 });
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = dark ? TOKENS.paper : TOKENS.ink;
    ctx.fillText(text, cx + w / 2, cyy + h / 2 + fs * 0.34 + (kicker ? 14 : 0));
    ctx.textAlign = 'left';
  };
  const geo = crackGeometry(x, y + dy, w, h, `${text}|${w}x${h}`);
  const drawK = clamp01(crack / 0.45);
  const sepK = clamp01((crack - 0.45) / 0.55);
  const sep = sepK * sepK;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  ctx.globalAlpha = G0 * (a);
  let centroids = geo.pieces.map((p) => {
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
    const cyy = p.reduce((s, q) => s + q[1], 0) / p.length;
    return { x: cx, y: cyy };
  });
  if (sep <= 0) {
    ctx.save();
    if (!dark) shadow(ctx, rgba(TOKENS.ink, 0.08), 56, 0, 20);
    else shadow(ctx, 'rgba(0,0,0,0.35)', 56, 0, 20);
    rrPath(ctx, x, y + dy, w, h, R);
    ctx.fillStyle = dark ? 'rgba(241,239,232,0.02)' : TOKENS.card;
    ctx.fill();
    ctx.restore();
    face(x, y + dy);
    if (drawK > 0) {
      ctx.save();
      rrPath(ctx, x, y + dy, w, h, R);
      ctx.clip();
      const k = geo.k;
      const leftArm = geo.main.slice(0, k + 1).reverse();
      const rightArm = geo.main.slice(k);
      const strokeCrack = (pts, f) => {
        ctx.lineWidth = 3;
        ctx.strokeStyle = dark ? 'rgba(11,16,32,0.55)' : 'rgba(255,255,255,0.9)';
        ctx.save();
        ctx.translate(0, 1.5);
        partialPolyline(ctx, pts, f);
        ctx.restore();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = dark ? rgba(TOKENS.paper, 0.85) : rgba(TOKENS.ink, 0.62);
        partialPolyline(ctx, pts, f);
      };
      ctx.lineJoin = 'miter';
      strokeCrack(leftArm, drawK);
      strokeCrack(rightArm, drawK);
      strokeCrack(geo.branch, (drawK - 0.35) / 0.65);
      ctx.restore();
    }
  } else {
    const moves = [
      { vx: -0.3, vy: -1, d: 56, rot: -0.07 },
      { vx: -1, vy: 0.4, d: 80, rot: -0.12 },
      { vx: 1, vy: 0.5, d: 90, rot: 0.14 },
    ];
    centroids = geo.pieces.map((poly, i) => {
      const m = moves[i];
      const c = centroids[i];
      const ox = m.vx * m.d * sep;
      const oy = m.vy * m.d * sep + 160 * sep * sep;
      ctx.save();
      ctx.globalAlpha = G0 * (a * (1 - smoothstep((crack - 0.62) / 0.38)));
      ctx.translate(c.x + ox, c.y + oy);
      ctx.rotate(m.rot * sep);
      ctx.translate(-c.x, -c.y);
      polyPath(ctx, poly);
      ctx.clip();
      face(x, y + dy);
      // Fracture edge: a lit hairline along the broken side.
      polyPath(ctx, poly);
      ctx.lineWidth = 3;
      ctx.strokeStyle = dark ? rgba(TOKENS.paper, 0.55) : rgba(TOKENS.ink, 0.3);
      ctx.stroke();
      ctx.restore();
      return { x: c.x + ox, y: c.y + oy };
    });
  }
  ctx.restore();
  return { rect: { x, y: y + dy, w, h }, pieces: centroids };
}

// ---------------------------------------------------------------- gap item

/**
 * A row as it lands in the managers' Content gaps review queue (AdminGaps.tsx),
 * in the page's stacked (narrow) layout: question (2-line clamp), then the
 * relative time and signal badges (Refused / Flagged), "Fill this gap" whisper right.
 * header: draws the "Content gaps" title and the column head above the row.
 * progress: row slides down 8 px and fades in; a cobalt wash marks it new, then fades.
 * Returns { x, y, w, h, rect, row }: x/y/w/h is the whole drawn card (static layout,
 * independent of progress).
 */
export function gapItem(ctx, props) {
  const {
    x = 520,
    y = 620,
    w = 880,
    question = '',
    progress = 1,
    alpha = 1,
    theme = 'light',
    time = 'now',
    signals = ['refused'],
    header = true,
    title = 'Content gaps',
    column = 'Question',
    action = 'Fill this gap',
  } = props;
  if (alpha <= 0) return null;
  const e = easeOutQuart(progress);
  const ra = clamp01(progress * 1.4);
  const padX = 28;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  setFont(ctx, { size: 22 });
  const aw = action ? textW(ctx, action) + 40 : 0;
  const qW = w - padX * 2 - (aw ? aw + 32 : 0);
  setFont(ctx, { size: 24 });
  const qLines = clampLines(ctx, question, qW, 2);
  const rowH = 20 + qLines.length * 36 + 8 + 34 + 20;
  const titleH = header && title ? 76 : 0;
  const headH = header && column ? 48 : 0;
  const H = titleH + headH + rowH;
  ctx.globalAlpha = G0 * (alpha);
  cardSurface(ctx, x, y, w, H, 16, theme);
  let yy = y;
  ctx.textBaseline = 'alphabetic';
  if (titleH) {
    setFont(ctx, { family: FONTS.display, size: 32, weight: 600, track: -0.02 });
    ctx.fillStyle = TOKENS.ink;
    ctx.fillText(title, x + padX, yy + 50);
    yy += titleH;
  }
  if (headH) {
    ctx.fillStyle = TOKENS.border;
    if (titleH) ctx.fillRect(x, yy, w, 1.5);
    setFont(ctx, { size: 17, track: 0.06 });
    ctx.fillStyle = TOKENS.mutedFg;
    ctx.fillText(String(column).toUpperCase(), x + padX, yy + 31);
    yy += headH;
  }
  ctx.save();
  rrPath(ctx, x, y, w, H, 16);
  ctx.clip();
  ctx.fillStyle = TOKENS.border;
  if (yy > y) ctx.fillRect(x, yy, w, 1.5);
  const wash = 1 - smoothstep((progress - 0.55) / 0.45);
  if (wash > 0 && progress > 0) {
    ctx.globalAlpha = G0 * (alpha * ra * wash);
    ctx.fillStyle = rgba(TOKENS.primary, 0.07);
    ctx.fillRect(x, yy + 1.5, w, rowH - 1.5);
  }
  ctx.restore();
  const ry = yy + (1 - e) * -8;
  ctx.globalAlpha = G0 * (alpha * ra);
  if (progress > 0) {
    setFont(ctx, { size: 24 });
    ctx.fillStyle = TOKENS.ink;
    qLines.forEach((ln, i) => ctx.fillText(ln, x + padX, ry + 20 + 36 * i + 18 + 8.5));
    const my = ry + 20 + qLines.length * 36 + 8 + 17;
    ctx.textBaseline = 'middle';
    setFont(ctx, { size: 20 });
    ctx.fillStyle = TOKENS.mutedFg;
    ctx.fillText(time, x + padX, my + 1);
    let bx = x + padX + textW(ctx, time) + 16;
    for (const sg of signals) {
      const flagged = sg === 'flagged';
      const txt = flagged ? 'Flagged' : sg === 'refused' ? 'Refused' : String(sg);
      setFont(ctx, { size: 19 });
      const bw = textW(ctx, txt) + 28 + (flagged ? 24 : 0);
      rrPath(ctx, bx, my - 17, bw, 34, 17);
      ctx.fillStyle = TOKENS.card;
      ctx.fill();
      ctx.fillStyle = flagged ? rgba(TOKENS.warning, 0.2) : TOKENS.muted;
      ctx.fill();
      if (flagged) icon(ctx, 'flag', bx + 13, my - 9, 18, TOKENS.warningFg, 2);
      ctx.fillStyle = flagged ? TOKENS.warningFg : TOKENS.mutedFg;
      ctx.fillText(txt, bx + 14 + (flagged ? 24 : 0), my + 1);
      bx += bw + 8;
    }
    if (action) {
      setFont(ctx, { size: 22 });
      const ax = x + w - padX - aw;
      const ay = ry + rowH / 2;
      rrPath(ctx, ax, ay - 24, aw, 48, 24);
      ctx.fillStyle = TOKENS.secondary;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = TOKENS.border;
      ctx.stroke();
      ctx.fillStyle = TOKENS.ink;
      ctx.fillText(action, ax + 20, ay + 1);
    }
  }
  ctx.restore();
  return { x, y, w, h: H, rect: { x, y, w, h: H }, row: { x, y: yy, w, h: rowH } };
}

// ---------------------------------------------------------------- program tag

/**
 * Program name with its identity swatch dot, oklch(75% 0.06 hue).
 * (x, y): left edge, vertical centre. pill: draw the whisper pill around it.
 * Returns { x, y, w, h, dot: {x, y} }.
 */
export function programTag(ctx, props) {
  const { x = 0, y = 0, name = '', hue = 200, alpha = 1, theme = 'light', size = 24, pill = true, prefix = null, align = 'left' } = props;
  if (alpha <= 0) return null;
  const dark = theme === 'dark';
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  ctx.globalAlpha = G0 * (alpha);
  ctx.textBaseline = 'middle';
  setFont(ctx, { size });
  const nw = textW(ctx, name);
  setFont(ctx, { size: size * 0.85 });
  const pw = prefix ? textW(ctx, prefix) + 14 : 0;
  const dot = Math.round(size * 0.58);
  const padX = pill ? size * 0.8 : 0;
  const W = padX * 2 + pw + dot + 12 + nw;
  const H = size * 2;
  const left = align === 'center' ? x - W / 2 : x;
  if (pill) {
    rrPath(ctx, left, y - H / 2, W, H, H / 2);
    if (dark) {
      ctx.fillStyle = rgba(TOKENS.night, 0.74);
      ctx.fill();
    }
    ctx.fillStyle = dark ? rgba(TOKENS.paper, 0.07) : TOKENS.secondary;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = dark ? rgba(TOKENS.paper, 0.2) : TOKENS.border;
    ctx.stroke();
  } else {
    softScrim(ctx, left - 12, y - H / 2, W + 24, H, H / 2, dark ? rgba(TOKENS.night, 0.7) : rgba(TOKENS.canvas, 0.88), 28);
  }
  let cx = left + padX;
  if (prefix) {
    ctx.fillStyle = dark ? rgba(TOKENS.paper, 0.72) : TOKENS.mutedFg;
    ctx.fillText(prefix, cx, y + 1);
    cx += pw;
  }
  ctx.beginPath();
  ctx.arc(cx + dot / 2, y, dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = programSwatch(hue);
  ctx.fill();
  const dotC = { x: cx + dot / 2, y };
  cx += dot + 12;
  setFont(ctx, { size });
  ctx.fillStyle = dark ? TOKENS.paper : TOKENS.ink;
  ctx.fillText(name, cx, y + 1);
  ctx.restore();
  return { x: left, y: y - H / 2, w: W, h: H, dot: dotC };
}

// ---------------------------------------------------------------- lockup

const MARK_UNIT = 330; // mark box in world units; scale = design px per unit

// Mark sheet geometry shared by the tile formation and the vector sheets: 0.72*size
// squares, centres offset from the mark centre (unrotated), then rotated in place.
export const MARK_SHEETS = [
  { color: TOKENS.green, alpha: 0.58, rot: -21, dx: -0.1, dy: 0.05 },
  { color: TOKENS.coral, alpha: 0.72, rot: 19, dx: 0.11, dy: -0.05 },
];
const SHEET_RADII = [0.34, 0.48, 0.38, 0.46];

/** Draw the vector mark (sheets + core + T) centred at (cx, cy) with box size B. */
function drawMark(ctx, cx, cy, B, m, tA, theme, spread = 1, coreScale = 80 / 70) {
  const S = 0.72 * B;
  const rad = SHEET_RADII.map((v) => v * S);
  const f = B / 32; // CSS px -> this box
  const sheet = (color, alphaMul, rotDeg, tx, ty, k) => {
    if (k <= 0) return;
    ctx.save();
    ctx.globalAlpha *= k;
    ctx.translate(cx, cy);
    ctx.rotate(((rotDeg * lerp(0.35, 1, k)) * Math.PI) / 180);
    ctx.translate(tx * S * spread, ty * S * spread);
    squirclePath(ctx, -S / 2, -S / 2, S, S, rad);
    ctx.fillStyle = rgba(color, alphaMul);
    ctx.fill();
    ctx.restore();
  };
  const kBack = easeOutQuart(m / 0.6);
  const kMid = easeOutQuart((m - 0.15) / 0.6);
  const kCore = easeOutQuart((m - 0.3) / 0.7);
  sheet(TOKENS.green, 0.58, -21, -0.04, 0.02, kBack);
  sheet(TOKENS.coral, 0.72, 19, 0.05, -0.02, kMid);
  // Core: translateZ(10px) under perspective 80px -> 80/70 scale.
  const cs = S * coreScale;
  const crad = rad.map((v) => v * coreScale);
  if (kCore > 0) {
    ctx.save();
    ctx.globalAlpha *= kCore;
    const sc = lerp(0.94, 1, kCore);
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    shadow(ctx, rgba(TOKENS.archiveInk, theme === 'dark' ? 0.5 : 0.22), 10 * f, 0, 4 * f);
    squirclePath(ctx, -cs / 2, -cs / 2, cs, cs, crad);
    ctx.fillStyle = TOKENS.primary;
    ctx.fill();
    noShadow(ctx);
    // inset 0 1px 0 primary-foreground/0.3: a thin light rim along the top.
    ctx.save();
    squirclePath(ctx, -cs / 2, -cs / 2, cs, cs, crad);
    ctx.clip();
    const off = Math.max(1.5, f);
    const hg = ctx.createLinearGradient(0, -cs / 2, 0, -cs / 2 + off * 2.2);
    hg.addColorStop(0, 'rgba(250,250,247,0.3)');
    hg.addColorStop(1, 'rgba(250,250,247,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(-cs / 2, -cs / 2, cs, off * 2.2);
    ctx.restore();
    ctx.restore();
  }
  drawT(ctx, cx, cy, B * coreScale, tA);
}

function drawT(ctx, cx, cy, B, tA) {
  if (tA <= 0) return;
  // The T: 0.92rem in a 2rem box.
  const ts = ((0.92 * 16) / 32) * B;
  ctx.save();
  ctx.globalAlpha *= tA;
  setFont(ctx, { family: FONTS.display, size: ts, weight: 600 });
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = TOKENS.onPrimary;
  ctx.fillText('T', cx, cy + ts * 0.345);
  ctx.restore();
}

// Crisp vector sheets for the end slate, with a hole for the WebGL lens.
function drawSheets(ctx, cx, cy, B, alpha, holeR, theme) {
  const S = 0.72 * B;
  const rad = SHEET_RADII.map((v) => v * S);
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (holeR > 0) {
    const clip = new Path2D();
    clip.rect(cx - B * 2, cy - B * 2, B * 4, B * 4);
    clip.arc(cx, cy, holeR, 0, Math.PI * 2);
    ctx.clip(clip, 'evenodd');
  }
  // Opaque paper: each sheet's CSS colour-at-alpha is pre-composited over the
  // ground, so nothing below shows through at sheetsAlpha = 1. The overlap gets
  // the persimmon-over-green mix the translucent CSS mark shows.
  const ground = hexRgb(theme === 'dark' ? TOKENS.night : TOKENS.canvas);
  const over = (base, hex, k) => hexRgb(hex).map((v, i) => Math.round(lerp(base[i], v, k)));
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const solid = MARK_SHEETS.map((m) => over(ground, m.color, m.alpha));
  const overlap = over(solid[0], MARK_SHEETS[1].color, MARK_SHEETS[1].alpha);
  MARK_SHEETS.forEach((m, i) => {
    ctx.save();
    ctx.translate(cx + m.dx * B, cy + m.dy * B);
    ctx.rotate((m.rot * Math.PI) / 180);
    shadow(ctx, rgba(theme === 'dark' ? '#000000' : TOKENS.ink, theme === 'dark' ? 0.35 : 0.16), 20, 0, 4);
    squirclePath(ctx, -S / 2, -S / 2, S, S, rad);
    ctx.fillStyle = css(solid[i]);
    ctx.fill();
    ctx.restore();
  });
  // Overlap: clip to the green sheet, fill the persimmon sheet with the mixed colour.
  ctx.save();
  ctx.translate(cx + MARK_SHEETS[0].dx * B, cy + MARK_SHEETS[0].dy * B);
  ctx.rotate((MARK_SHEETS[0].rot * Math.PI) / 180);
  squirclePath(ctx, -S / 2, -S / 2, S, S, rad);
  ctx.rotate((-MARK_SHEETS[0].rot * Math.PI) / 180);
  ctx.translate(-(cx + MARK_SHEETS[0].dx * B), -(cy + MARK_SHEETS[0].dy * B));
  ctx.clip();
  ctx.translate(cx + MARK_SHEETS[1].dx * B, cy + MARK_SHEETS[1].dy * B);
  ctx.rotate((MARK_SHEETS[1].rot * Math.PI) / 180);
  squirclePath(ctx, -S / 2, -S / 2, S, S, rad);
  ctx.fillStyle = css(overlap);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// Layout shared by lockup() and lockupBounds(). No drawing.
function lockupLayout(ctx, p) {
  const { x = 960, y = 420, scale = 1, word = 'Truenote', tagline = '', url = '', layout = 'stacked', sheetsAlpha = 0, markAlpha = 1 } = p;
  const B = MARK_UNIT * scale;
  const stacked = layout !== 'horizontal';
  // Sheets reach ~0.58 B from the centre; the vector mark (spread 2.4) ~0.5 B.
  const reach = sheetsAlpha > 0 ? 0.58 * B : markAlpha > 0 ? 0.52 * B : 0.41 * B;
  const ws = stacked ? B * 0.44 : B * 0.56;
  ctx.save();
  setFont(ctx, { family: FONTS.display, size: ws, weight: 600, track: -0.025 });
  const ww = textW(ctx, word);
  const wx = stacked ? x - ww / 2 : x + reach + B * 0.16;
  const wBase = stacked ? y + reach + B * 0.2 + ws * 0.72 : y + ws * 0.345;
  const tx = stacked ? x : wx;
  const tAlign = stacked ? 'center' : 'left';
  let yy = wBase + ws * 0.28;
  let tag = null;
  if (tagline) {
    const ts = stacked ? Math.max(30, ws * 0.3) : Math.max(28, ws * 0.28);
    yy += ts * 1.25;
    setFont(ctx, { family: FONTS.display, size: ts, italic: true, weight: 400 });
    const tw = textW(ctx, tagline);
    tag = { ts, base: yy, x: tAlign === 'center' ? tx - tw / 2 : tx, w: tw };
    yy += ts * 0.5;
  }
  let u = null;
  if (url) {
    const us = Math.max(22, ws * 0.2);
    yy += us * 2.4;
    setFont(ctx, { family: FONTS.mono, size: us, track: 0.08 });
    const uw = textW(ctx, url);
    u = { us, base: yy, x: tAlign === 'center' ? tx - uw / 2 : tx, w: uw };
  }
  ctx.restore();
  const left = Math.min(x - reach, wx, tag ? tag.x : Infinity, u ? u.x : Infinity);
  const right = Math.max(x + reach, wx + ww, tag ? tag.x + tag.w : -Infinity, u ? u.x + u.w : -Infinity);
  const top = Math.min(y - reach, wBase - ws * 0.75);
  const bottom = Math.max(y + reach, yy + 10);
  return { B, stacked, ws, ww, wx, wBase, tx, tAlign, tag, u, reach, rect: { x: left, y: top, w: right - left, h: bottom - top } };
}

/** Bounding box the lockup would occupy with these props, without drawing: centre it with this. */
export function lockupBounds(ctx, props) {
  return lockupLayout(ctx, props).rect;
}

/**
 * End slate. The anchor (x, y) is the mark centre; the mark box is 330 * scale
 * design px (the .brand-mark box; sheets and core are 72% of it).
 * markAlpha 0..1 builds the full vector mark (sheets fan in, then the core).
 * With the mark in WebGL: markAlpha 0, sheetsAlpha 0..1 draws only the two sheets
 * (MARK_SHEETS geometry, crisp, soft shadow) with a hole of radius holeR at the
 * centre so the lens shows through; tAlpha draws the Georgia T.
 * layout 'stacked' (default) or 'horizontal'.
 * Returns { rect (full bounding box), mark: {x, y, size}, word: {x,y,w,h} }.
 */
export function lockup(ctx, props) {
  const {
    x = 960,
    y = 420,
    markAlpha = 1,
    sheetsAlpha = 0,
    holeR = 0,
    tAlpha = null,
    wordAlpha = 1,
    word = 'Truenote',
    tagline = '',
    taglineAlpha = 1,
    url = '',
    urlAlpha = 1,
    theme = 'light',
    layout = 'stacked',
    spread = 2.4,
    coreScale = 1,
    scrim = 0,
  } = props;
  const L = lockupLayout(ctx, props);
  const { B } = L;
  const dark = theme === 'dark';
  const ink = dark ? TOKENS.paper : TOKENS.ink;
  const sub = dark ? rgba(TOKENS.paper, 0.74) : TOKENS.mutedFg;
  const urlC = dark ? TOKENS.cobaltOnDark : TOKENS.primary;
  ctx.save();
  const G0 = ctx.globalAlpha; // caller alpha: multiply, never replace
  if (scrim > 0) {
    ctx.globalAlpha = G0 * (scrim * Math.max(clamp01(markAlpha), clamp01(wordAlpha), clamp01(sheetsAlpha)));
    const sc = dark ? rgba(TOKENS.night, 0.8) : rgba(TOKENS.canvas, 0.9);
    const r = L.rect;
    softScrim(ctx, r.x - B * 0.3, r.y - B * 0.3, r.w + B * 0.6, r.h + B * 0.6, B * 0.6, sc, B * 0.6);
    ctx.globalAlpha = G0 * (1);
  }
  if (sheetsAlpha > 0) drawSheets(ctx, x, y, B, clamp01(sheetsAlpha), holeR, theme);
  if (markAlpha > 0) {
    drawMark(ctx, x, y, B, markAlpha, tAlpha ?? clamp01((markAlpha - 0.55) / 0.45), theme, spread, coreScale);
  } else if ((tAlpha ?? 0) > 0) {
    drawT(ctx, x, y, B * coreScale, tAlpha);
  }
  const wk = easeOutQuart(wordAlpha);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (wordAlpha > 0) {
    ctx.globalAlpha = G0 * (clamp01(wordAlpha));
    setFont(ctx, { family: FONTS.display, size: L.ws, weight: 600, track: -0.025 });
    ctx.fillStyle = ink;
    ctx.fillText(word, L.wx, L.wBase + (1 - wk) * 8);
  }
  if (L.tag && taglineAlpha > 0) {
    const k = easeOutQuart(taglineAlpha);
    ctx.globalAlpha = G0 * (clamp01(taglineAlpha));
    setFont(ctx, { family: FONTS.display, size: L.tag.ts, italic: true, weight: 400 });
    ctx.fillStyle = sub;
    ctx.fillText(tagline, L.tag.x, L.tag.base + (1 - k) * 6);
  }
  if (L.u && urlAlpha > 0) {
    const k = easeOutQuart(urlAlpha);
    ctx.globalAlpha = G0 * (clamp01(urlAlpha));
    setFont(ctx, { family: FONTS.mono, size: L.u.us, track: 0.08 });
    ctx.fillStyle = urlC;
    ctx.fillText(url, L.u.x, L.u.base + (1 - k) * 4);
  }
  ctx.restore();
  return {
    rect: L.rect,
    mark: { x, y, size: B },
    word: { x: L.wx, y: L.wBase - L.ws * 0.72, w: L.ww, h: L.ws },
  };
}
