// WebGL2 renderer for the promo film. render(frameState) is a pure function of
// its input: no feedback buffers, no clocks, grain seeded from round(t * 60).
//
// Frame passes
//   1. shadow   Tiles' light-projected silhouettes and vertical AO footprints,
//               rasterised onto the table plane but addressed in camera screen
//               space (with a guard band), MAX-blended. R = ground shadow,
//               G = topmost occluder height (for tile-on-tile shadows), B = AO.
//   2. scene    MSAA MRT: attachment 0 = lit, unlit-exact scene colour (linear),
//               attachment 1 = emitted light. Ground (ray-cast full-screen pass
//               with the lens, pencil lines and waves), instanced tiles with
//               alpha-to-coverage after a depth prepass, then a blended pass for
//               fading tiles (card-sized sheets anywhere, every tile on a light
//               table) with a one-layer stencil, beams (tint into scene, light
//               additive).
//   3. bloom    Emitted light only: quarter + eighth res, separable gaussian.
//   4. output   Scene gets a soft shoulder above 0.86 linear only (cream and
//               cobalt pass untouched); light is tone-mapped on its own and
//               screen-blended over it. Vignette, fade, grain, 1 LSB dither.

import { cameraMatrices, defaultCam } from './camera.js';

export const STRIDE = 16;
const MAX_WAVES = 8;
const MAX_BEAMS = 128;
const GUARD = 1.18; // shadow buffer covers 18% beyond each screen edge
const SHADOW_SCALE = 0.75; // shadow buffer resolution relative to the canvas
// Master look constants.
const SHADOW_K = [0.74, 0.07, 0.32, 0.35]; // darkness at z=0, penumbra per unit height, AO strength, AO radius per unit height
const HAZE = 0;                            // distance haze per world unit beyond the camera target

const hexLin = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return c.map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
};
const hexSrgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

const CREAM = '#E8E6DE';
const INK = '#0B1026';
const fin = (v, d) => (Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// Ground colour along the dawn (u = 1 - ground.ink): archive ink, deep cobalt ink, a low
// amber glow, golden light, cream. Stops are OKLCH (L, C, hue deg) or hex; the shader
// interpolates in OKLab and runs the light's side of the table ahead of the far side.
const linToOklab = ([r, g, b]) => {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const q = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * q,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * q,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * q];
};
const oklabToLin = ([L, a, b]) => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const q = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * q,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * q,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * q];
};
const lch = (L, C, h) => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
const toLch = ([L, a, b]) => [L, Math.hypot(a, b), Math.atan2(b, a)];
const lchLab = ([L, C, h]) => [L, C * Math.cos(h), C * Math.sin(h)];
const LCH_INK = toLch(linToOklab(hexLin('#0B1026')));
const LCH_COBALT = toLch(linToOklab(hexLin('#13245A')));
const LCH_DAWN = toLch(linToOklab(hexLin('#DCE3EE')));
const LCH_CREAM = toLch(linToOklab(hexLin('#E8E6DE')));
const HUE_BLUE = LCH_COBALT[2];
// ink -> deep cobalt ink -> saturated morning blue -> cold dawn white (held) -> cream. All but the
// last segment share one hue; the only low-chroma crossing (dawn white -> cream) spans 0.035 of
// the ramp (about 0.11 s over a 3.2 s dawn).
const DAWN_STOPS = [
  [0.0, LCH_INK], [0.28, LCH_COBALT], [0.5, [0.55, 0.105, HUE_BLUE]], [0.7, [0.78, 0.06, HUE_BLUE]],
  [0.9, LCH_DAWN], [0.955, LCH_DAWN], [0.99, LCH_CREAM],
];
const DAWN_U = new Float32Array(DAWN_STOPS.map((d) => d[0]));
const DAWN_LAB = new Float32Array(DAWN_STOPS.flatMap((d) => d[1])); // L, C, hue (radians)
const hueMix = (h0, h1, k) => { let d = h1 - h0; d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return h0 + d * k; };
function dawnGround(ink) {
  const u = 1 - clamp01(ink);
  if (u >= 1) return hexLin('#E8E6DE');
  let c = DAWN_STOPS[0][1];
  const last = DAWN_STOPS.length - 1;
  for (let i = 1; i < last; i++) {
    const k = clamp01((u - DAWN_STOPS[i - 1][0]) / (DAWN_STOPS[i][0] - DAWN_STOPS[i - 1][0]));
    const n = DAWN_STOPS[i][1];
    c = [c[0] + (n[0] - c[0]) * k, c[1] + (n[1] - c[1]) * k, hueMix(c[2], n[2], k)];
  }
  // last segment in OKLab, as in the shader (no hue sweep between two near-neutrals)
  const k = clamp01((u - DAWN_STOPS[last - 1][0]) / (DAWN_STOPS[last][0] - DAWN_STOPS[last - 1][0]));
  const a0 = lchLab(c), a1 = lchLab(DAWN_STOPS[last][1]);
  return oklabToLin(a0.map((v, i) => v + (a1[i] - v) * k)).map((v) => Math.max(0, v));
}

const DEFAULTS = {
  ground: { ink: 0, lines: 0, linesX: 960, linesY: 540 },
  light: { az: -2.356, el: 0.72, warmth: 0.6, intensity: 1 },
  shadow: 1,
  core: { x: 960, y: 540, r: 118, on: 0, glow: 0, dim: 0 },
  post: { exposure: 1, bloom: 1, vignette: 0.35, grain: 0.5, fade: 0 },
};

// ---------------------------------------------------------------- GLSL

const COMMON = `
precision highp float;
precision highp int;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3. - 2. * f);
  float a = hash12(i), b = hash12(i + vec2(1., 0.)), c = hash12(i + vec2(0., 1.)), d = hash12(i + vec2(1., 1.));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 3; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= .5; } return s / .875; }
float fbm4(vec2 p){ float s = 0., a = .5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= .5; } return s / .9375; }
float max3(vec3 v){ return max(v.r, max(v.g, v.b)); }
// Clamp to [0, 6e4] and map NaN to 0 (NaN fails every comparison, so step() on it picks 0).
vec3 clean(vec3 v){ vec3 ok = step(-1., v) * step(v, vec3(6e4)); return clamp(v, 0., 6e4) * ok; }
// Box-filtered coverage of the interval [a0, a1] by a pixel of width fw centred at x.
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)); }
vec3 toSrgbC(vec3 c){ c = clamp(c, 0., 1.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
// mix a linear colour toward a linear target, interpolating in sRGB (how paint and print mix)
vec3 mixS(vec3 a, vec3 b, float t){ return toLin(mix(toSrgbC(a), toSrgbC(b), clamp(t, 0., 1.))); }
float boxCov(float a0, float a1, float x, float fw){ return clamp((min(x + .5 * fw, a1) - max(x - .5 * fw, a0)) / fw, 0., 1.); }
`;

// Shadow darkness, penumbra width and AO, all as functions of occluder height.
const SHADOW_CURVES = `
uniform float uShadowAmt;
uniform vec4 uShadowK; // darkness, penumbra per unit height, AO strength, AO radius per unit height
// uFlightK is set (to the light-table weight) only for the ground shadow pass, so tiles in flight
// keep a firm shadow on a light table while tile-on-tile shadows keep the plain height falloff.
// It is not a copy of uDayG: every other program that uses these curves leaves it at 0.
uniform float uFlightK;
float darkAt(float z){
  float d = uShadowAmt * uShadowK.x / (1. + pow(max(z, 0.) / 70., 1.4));
  return max(d, uFlightK * uShadowAmt * uShadowK.x * .5 * (1. - smoothstep(700., 1100., z)));
}
float penW(float z){ return min(2.2 + uShadowK.y * z, mix(44., 16., uFlightK)); }
float aoAmt(float z){ return uShadowAmt * uShadowK.z / (1. + z / 18.) * (1. - smoothstep(50., 90., z)); }
float aoRad(float z){ return 3. + uShadowK.w * z; }
`;

const LIGHT_UNIFORMS = `
uniform vec3 uL;      // unit vector towards the key light
uniform vec3 uAmb;    // ambient irradiance
uniform vec3 uKey;    // key irradiance, scaled so a flat, unshadowed surface gets exactly uIntensity
uniform float uWrap;
float wrapDiff(float nl){ return max((nl + uWrap) / (1. + uWrap), 0.); }
${SHADOW_CURVES}
`;

const WAVES = `
uniform vec4 uWaveA[${MAX_WAVES}]; // x, y, r, width
uniform vec4 uWaveB[${MAX_WAVES}]; // intensity, hue
uniform int uWaveN;
uniform vec3 uCobaltE;
uniform vec3 uAmberE;
// Emitted light of the search waves at p, and a multiplicative tint for the surface under the line.
uniform float uDayG; // 1 on a light table (ground.ink < 0.4), 0 on ink; light is additive only at night
// Search waves. Night: emitted light plus an ink tint. Day: an opaque cobalt (#0040AB) or amber
// (#F59F0A) stroke 0.2 x width wide (at least ~2 px) with a soft shadow on the paper.
float waveFront = 0.; // set by waveField: soft band a few tiles wide around cobalt wave fronts
void waveField(vec2 p, float px, float haloK, out vec3 em, out vec3 tint, out float cov, out vec3 scol, out float shade){
  em = vec3(0.); tint = vec3(1.); cov = 0.; scol = vec3(0.); shade = 0.; waveFront = 0.;
  for (int i = 0; i < ${MAX_WAVES}; i++){
    if (i >= uWaveN) break;
    vec4 A = uWaveA[i]; vec4 B = uWaveB[i];
    float w = max(A.w, 1.);
    float dr = length(p - A.xy) - A.z;
    float lw = max(w * .07, px * 1.1);
    float line = exp(-dr * dr / (lw * lw));
    float halo = exp(-dr * dr / (w * w * .3));
    float trail = step(dr, 0.) * exp(min(dr, 0.) / (w * 2.5)) * smoothstep(0., w * 2., A.z + dr);
    vec3 col = mix(uCobaltE, uAmberE, B.y);
    em += col * B.x * (line * .9 + haloK * (halo * .16 + trail * .035));
    vec3 tc = mix(vec3(.015, .108, .85), vec3(.6, .165, .004), B.y);
    tint *= mix(vec3(1.), tc, clamp(min(B.x * 1.6, 1.) * line * .9 + haloK * B.x * halo * .1, 0., 1.));
    float sw = max(w * .11, px * max(w * .11, .9)); // at least 0.22 x width in screen px (60 -> 13 px)
    float k = clamp(B.x * 1.5, 0., 1.);
    float c = boxCov(-sw, sw, dr, px) * k;
    scol = mix(scol, mix(vec3(0., .0513, .4125), vec3(.913, .347, .0033), B.y), step(cov, c));
    cov = max(cov, c);
    float od = max(abs(dr) - sw, 0.);
    float ss = sw * .8 + 2.;
    shade = max(shade, k * .16 * exp(-od * od / (ss * ss)));
    float band = max(w, 20.) * 1.3;
    waveFront = max(waveFront, clamp(B.x, 0., 1.) * (1. - step(.5, B.y)) * exp(-dr * dr / (band * band)));
  }
}
uniform float uHaze;
uniform float uHazeRef;
float hazeAt(float dist){ return 1. - exp(-max(dist - uHazeRef, 0.) * uHaze); }
`;

const ROT = `
mat3 rotXYZ(vec3 r){
  float cx = cos(r.x), sx = sin(r.x), cy = cos(r.y), sy = sin(r.y), cz = cos(r.z), sz = sin(r.z);
  mat3 Rx = mat3(1., 0., 0., 0., cx, sx, 0., -sx, cx);
  mat3 Ry = mat3(cy, 0., -sy, 0., 1., 0., sy, 0., cy);
  mat3 Rz = mat3(cz, sz, 0., -sz, cz, 0., 0., 0., 1.);
  return Rz * Ry * Rx;
}
`;

const TILE_ATTRIBS = `
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA; // x y z rx
layout(location = 2) in vec4 iB; // ry rz w h
layout(location = 3) in vec4 iC; // r g b alpha
layout(location = 4) in vec4 iD; // lines glow hue seed
`;

const VS_FULL = `#version 300 es
layout(location = 0) in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0., 1.); }`;

// ---- shadow pass: two footprints per tile. quad 0 = light-projected shadow + occluder
// height, quad 1 = vertical AO footprint (skipped above z = 90).
const VS_SHADOW = `#version 300 es
${COMMON}
layout(location = 0) in vec3 aCorner; // x, y, quad id
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB;
layout(location = 3) in vec4 iC;
layout(location = 4) in vec4 iD;
${ROT}
${SHADOW_CURVES}
uniform mat4 uSVP;
uniform vec3 uL;
uniform float uDayG;
out vec2 vG;
flat out vec3 vC0; flat out vec3 vN; flat out vec3 vTx; flat out vec3 vTy; flat out vec2 vHalf; flat out vec2 vAQ;
void main(){
  mat3 R = rotXYZ(vec3(iA.w, iB.x, iB.y));
  vec3 tx = R[0], ty = R[1];
  // same seam-closing growth as the tile pass, so a flush sheet casts one shadow, not a grid
  vec2 hs = .5 * (max(iB.zw, vec2(0.)) + smoothstep(.992, .999, abs(R[2].z)) * 1.6 * step(1e-3, iB.zw));
  float q = aCorner.z;
  vec2 mn = vec2(1e9), mx = vec2(-1e9);
  float zmax = 0., zmin = 1e9;
  for (int k = 0; k < 4; k++){
    vec2 s = vec2(float(k & 1) * 2. - 1., float(k >> 1) * 2. - 1.);
    vec3 c = iA.xyz + tx * s.x * hs.x + ty * s.y * hs.y;
    float z = max(c.z, 0.);
    vec2 g = mix(c.xy - uL.xy * (z / uL.z), c.xy, q);
    mn = min(mn, g); mx = max(mx, g);
    zmax = max(zmax, z); zmin = min(zmin, z);
  }
  float pad = mix(1.5 + penW(zmax), 1.5 + aoRad(zmax), q);
  mn -= pad; mx += pad;
  vec2 g = mix(mn, mx, aCorner.xy + .5);
  vG = g;
  vC0 = iA.xyz; vN = R[2]; vTx = tx; vTy = ty; vHalf = max(hs, vec2(1e-3)); vAQ = vec2(clamp(iC.a, 0., 1.), q);
  float live = step(1e-4, iC.a) * step(1e-4, uShadowAmt) * step(zmax, 4000.) * (1. - q * step(90., zmin));
  gl_Position = mix(vec4(2., 2., 2., 1.), uSVP * vec4(g, 0., 1.), live);
}`;

const FS_SHADOW = `#version 300 es
${COMMON}
${SHADOW_CURVES}
uniform vec3 uL;
uniform float uHScale;
in vec2 vG;
flat in vec3 vC0; flat in vec3 vN; flat in vec3 vTx; flat in vec3 vTy; flat in vec2 vHalf; flat in vec2 vAQ;
out vec4 o;
float sgnNZ(float x){ return step(0., x) * 2. - 1.; }
void main(){
  vec3 p = vec3(vG, 0.);
  vec3 n = vN;
  vec3 dc = vC0 - p;
  float alpha = vAQ.x, q = vAQ.y;
  // Ray from the ground point towards the light (q = 0) or straight up (q = 1), hit on the tile plane.
  vec3 dir = mix(uL, vec3(0., 0., 1.), q);
  float dn = dot(dir, n); dn = sgnNZ(dn) * max(abs(dn), mix(1e-3, .05, q));
  float sl = dot(dc, n) / dn;
  vec3 h = p + dir * sl;
  vec2 lp = vec2(dot(h - vC0, vTx), dot(h - vC0, vTy));
  // Gradient of the tile-local coordinates over the ground gives distances in ground units.
  vec2 gx = vTx.xy - (dot(dir, vTx) / dn) * n.xy;
  vec2 gy = vTy.xy - (dot(dir, vTy) / dn) * n.xy;
  vec2 d = (abs(lp) - vHalf) / vec2(max(length(gx), 1e-3), max(length(gy), 1e-3));
  float sdf = length(max(d, 0.)) + min(max(d.x, d.y), 0.);
  float front = step(0., sl);
  float zh = max(h.z, 0.) * front;
  // full shadow up to the tile edge, soft only outside it, so flush neighbours join seamlessly
  float cov = (1. - smoothstep(0., 2. * penW(zh), sdf)) * front;
  float dark = cov * darkAt(zh) * alpha;
  float inside = step(max(abs(lp.x) - vHalf.x, abs(lp.y) - vHalf.y), 0.) * front;
  float keep = step(hash12(floor(gl_FragCoord.xy) + fract(vC0.xy * .013) * 97.), alpha);
  float hgt = zh * inside * keep * uHScale;
  float r = aoRad(zh);
  float ao = (1. - smoothstep(0., r, sdf)) * aoAmt(zh) * alpha * front;
  o = mix(vec4(dark, hgt, 0., 0.), vec4(0., 0., ao, 0.), q);
}`;

// ---- ground pass (full screen, ray-cast to z = 0)
const FS_GROUND = `#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
${WAVES}
uniform mat4 uInvVP;
uniform mat4 uVP;
uniform vec2 uRes;
uniform float uGuard;
uniform sampler2D uShadowTex;
uniform vec3 uCream;
uniform vec3 uInkCol;
uniform float uInk;
uniform float uLines;
uniform vec2 uLinesC;
uniform vec4 uCore;   // x, y, r, on
uniform vec3 uCore2;  // glow, dim, bezel
uniform vec3 uCobalt;
uniform vec3 uEye;
uniform float uT;
uniform vec3 uAir;
uniform vec3 uBase;   // table colour along the dawn ramp (linear)
uniform float uDawn;  // 0 at either end of the dawn, 1 mid-way
uniform vec2 uGlowC;  // centre of the dawn wash (camera target)
uniform float uDawnU[7];
uniform vec3 uDawnLab[7]; // OKLCH stops: L, C, hue (radians)
uniform float uDawnP; // dawn progress 1 - ink
vec3 oklabToLin(vec3 c){
  float l = c.x + .3963377774 * c.y + .2158037573 * c.z;
  float m = c.x - .1055613458 * c.y - .0638541728 * c.z;
  float s = c.x - .0894841775 * c.y - 1.291485548 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return max(vec3(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
                  -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
                  -.0041960863 * l - .7034186147 * m + 1.707614701 * s), 0.);
}
vec3 dawnColor(float u){
  vec3 c = uDawnLab[0];
  for (int i = 1; i < 6; i++){
    float k = clamp((u - uDawnU[i - 1]) / (uDawnU[i] - uDawnU[i - 1]), 0., 1.);
    vec3 n = uDawnLab[i];
    float dh = mod(n.z - c.z + 3.14159265, 6.2831853) - 3.14159265;
    c = vec3(mix(c.xy, n.xy, k), c.z + dh * k);
  }
  // last segment (cold dawn white -> cream): a straight OKLab crossing between two near-neutral
  // colours, so the moving dawn front never shows a green or pink hue sweep
  vec3 n6 = uDawnLab[6];
  float k6 = clamp((u - uDawnU[5]) / (uDawnU[6] - uDawnU[5]), 0., 1.);
  vec3 lab = mix(vec3(c.x, c.y * cos(c.z), c.y * sin(c.z)), vec3(n6.x, n6.y * cos(n6.z), n6.y * sin(n6.z)), k6);
  return oklabToLin(lab);
}
layout(location = 0) out vec4 oScene;
layout(location = 1) out vec4 oLight;

float hairline(float d, float px, float hw){
  float w = max(hw, .5 * px);
  return boxCov(-w, w, d, px) * min(1., 2. * hw / px + .35);
}

// Lens coordinates (units of r) of the layer 'dep' r below the glass, seen along the view ray.
vec2 lensQ(vec3 P, vec3 rdn, float dep){
  vec3 X = P + rdn * (dep * uCore.z / max(-rdn.z, .05));
  return (X.xy - uCore.xy) / uCore.z;
}

float pencil(vec2 p, float px){
  vec2 q = p - uLinesC;
  float r = length(q);
  float a = 0.;
  float R[9] = float[9](205., 292., 372., 468., 636., 842., 1060., 1330., 1760.);
  float W[9] = float[9](.55, .7, .45, .8, .65, .9, .6, .75, .55);
  for (int i = 0; i < 9; i++) a = max(a, hairline(r - R[i], px, .42) * W[i]);
  // Long rulings through and around the centre, with tick marks.
  float hy = q.y + 262.;
  a = max(a, hairline(hy, px, .38) * .85 * smoothstep(-1900., -1400., q.x) * smoothstep(1500., 900., q.x));
  a = max(a, hairline(q.y - 406., px, .38) * .55 * smoothstep(-1900., -1500., q.x) * smoothstep(-200., -600., q.x));
  a = max(a, hairline(q.x + 1228., px, .38) * .7);
  a = max(a, hairline(q.x + 462., px, .38) * .55 * smoothstep(-900., -700., q.y) * smoothstep(300., 0., q.y));
  a = max(a, hairline(q.x - 4., px, .34) * .35 * smoothstep(-700., -560., q.y) * smoothstep(-160., -300., q.y));
  float tx = abs(mod(q.x, 120.) - 60.);
  a = max(a, hairline(60. - tx, px, .36) * boxCov(-14., 14., hy, px) * .7);
  float ty = abs(mod(q.y, 96.) - 48.);
  a = max(a, hairline(48. - ty, px, .36) * boxCov(-10., 10., q.x + 1228., px) * .6);
  // Pressure variation along the strokes.
  a *= .55 + .45 * vnoise(p * .006 + 3.1);
  return a;
}

void main(){
  vec2 ndc = gl_FragCoord.xy / uRes * 2. - 1.;
  vec4 a = uInvVP * vec4(ndc, -1., 1.); a /= a.w;
  vec4 b = uInvVP * vec4(ndc, 1., 1.); b /= b.w;
  vec3 rd = b.xyz - a.xyz;
  float s = -a.z / min(rd.z, -1e-6);
  float hit = step(rd.z, -1e-6) * step(0., s) * step(s, 1.);
  vec3 P = a.xyz + rd * clamp(s, 0., 1.);
  P.z = 0.;
  vec4 cp = uVP * vec4(P, 1.);
  gl_FragDepth = mix(1., clamp(cp.z / cp.w * .5 + .5, 0., 1.), hit);
  vec3 rdn = normalize(rd);
  vec2 fw = fwidth(P.xy);
  float px = max(max(fw.x, fw.y), 1e-3);
  float far = clamp(px / 12., 0., 1.);
  vec2 ld0 = normalize(uL.xy + vec2(1e-5, 0.));

  // --- paper table
  // Morning arriving from the light's side: that side of the table runs ahead along the ramp.
  float sideL = smoothstep(-1400., 1400., dot(P.xy - uGlowC, ld0));
  // Dawn rises from the lens: the ramp position runs ahead near the core's projected centre and
  // lags with screen distance from it, so a soft light front sweeps outward and the farthest
  // frame corner arrives last (it reaches the end of the ramp exactly when the global dawn does).
  vec4 cc = uVP * vec4(uCore.xy, 0., 1.);
  vec2 cN = cc.xy / max(cc.w, 1e-4);
  vec2 asp = vec2(uRes.x / uRes.y, 1.);
  vec2 pN = cp.xy / max(cp.w, 1e-4);
  float dMax = length((vec2(1.) + abs(cN)) * asp);
  float dn = pow(clamp(length((pN - cN) * asp) / dMax, 0., 1.), 1.6); // wide bright pool round the core
  const float lag = .65; // share of the dawn by which the farthest corner trails the core
  float uLoc = clamp((uDawnP - lag * dn) / (1. - lag), 0., 1.);
  uLoc = clamp(uLoc + .02 * uDawn * (sideL * 2. - 1.), 0., 1.);
  vec3 base = mix(dawnColor(uLoc), uBase, step(.9999, uDawnP) + step(uDawnP, 1e-4));
  // the warmth stays local: a soft peach-gold light strongest on the light's side
  vec3 alb = base;
  float mottle = fbm3(P.xy * .0065) - .5;
  float cloud = fbm3(P.xy * .0021 + 7.3) - .5;
  float tooth = (vnoise(P.xy * .42) - .5) * (1. - smoothstep(.6, 1.6, px * .42));
  vec2 fr = vec2(P.x * .8 + P.y * .6, P.y * .8 - P.x * .6);
  float fibre = (vnoise(fr * vec2(.06, .7)) - .5) * (1. - smoothstep(.4, 1.2, px * .7));
  float gAmt = mix(1., 2.4, uInk);
  alb *= 1. + gAmt * (mottle * .05 + cloud * .04 + tooth * .035 + fibre * .03) * (1. - far);
  alb *= 1. + cloud * mix(vec3(.03, 0., -.035), vec3(-.05, 0., .08), uInk);

  // --- pencil construction lines
  float pl = pencil(P.xy, px) * uLines;
  vec3 graphite = alb * vec3(.64, .64, .67);
  vec3 chalk = alb + vec3(.03, .04, .07);
  alb = mix(alb, mix(graphite, chalk, uInk), pl * mix(.45, .55, uInk));

  // --- shadow buffer, addressed in guard-banded screen space
  vec2 uvS = (ndc / uGuard) * .5 + .5;
  vec4 sh = texture(uShadowTex, uvS);
  float difFlat = wrapDiff(uL.z);

  // --- the lens: glass (d < 1), dark lip, paper bevel sloping into it, flat collar
  vec2 q = (P.xy - uCore.xy) / uCore.z;
  float d = length(q);
  vec2 qn = q / max(d, 1e-4);
  float pr = px / uCore.z;
  float on = smoothstep(0., .5, uCore.w), glow = uCore2.x, dim = uCore2.y; // resting glass from on >= 0.5
  vec2 ld = normalize(uL.xy + vec2(1e-5, 0.));
  vec2 lp = vec2(-ld.y, ld.x);
  float facing = dot(qn, ld);
  // bezel: dark lip (1.0-1.035), raised rounded paper bead (1.035-1.2), recessed well ring
  // (1.2-1.34) with a stepped outer edge. The bead is lit by its own normal and throws a
  // soft shadow outward on the side away from the light.
  float bx = clamp((d - 1.035) / .165, 0., 1.);
  float slope = .055 * 3.14159 / .165 * cos(3.14159 * bx) * step(1.035, d) * step(d, 1.2);
  vec3 nb = normalize(vec3(-qn * slope, 1.));
  float mGl = boxCov(-1., 1.0, d, pr);
  float mLip = boxCov(1.0, 1.035, d, pr);
  float mBev = boxCov(1.035, 1.2, d, pr);
  float mCol = boxCov(1.2, 1.345, d, pr);
  float away = max(-facing, 0.);
  float beadSh = (1. - smoothstep(1.2, 1.2 + .015 + .07 * away, d)) * away * .5;
  float groove = hairline(d - 1.275 - .003 * facing, pr, .002) + .8 * hairline(d - 1.343, pr, .0025) * away;
  float ridge = hairline(d - 1.275 + .003 * facing, pr, .002) + .8 * hairline(d - 1.343, pr, .0025) * max(facing, 0.);

  float depth = .16 * uCore.z;
  // refraction: towards the rim the glass bends the view inwards
  float refr = 1. - .1 * smoothstep(.55, 1., d);
  vec3 P2 = P + rdn * (depth / max(-rdn.z, .05));
  vec2 q2 = (P2.xy - uCore.xy) / uCore.z * refr;
  float d2 = length(q2);
  float wall = smoothstep(.985, 1.0, d2);
  vec2 Q = P2.xy + uL.xy * (depth / uL.z);
  float rimSh = smoothstep(.94, 1.03, length(Q - uCore.xy) / uCore.z);
  float calm = 1. - .6 * dim;
  float drift = uT * .012 * (1. - .7 * dim);
  vec2 q3 = lensQ(P, rdn, .55) * refr;  // deep layer: the nebula sits far below the glass
  float neb = fbm4(q3 * 1.9 + vec2(drift, -drift * .6) + 3.7);
  float neb2 = fbm3(q2 * 4.7 - vec2(drift * 1.7, drift) + 11.);
  float centre = 1. - smoothstep(0., 1., d2);
  vec3 deep = vec3(.003, .007, .05);
  vec3 hi = vec3(.02, .13, .78);
  vec3 glass = mix(deep, uCobalt, pow(centre, .6));
  float hot = 1. - smoothstep(0., .8, length(q2 - ld * .22));
  glass = mix(glass, hi, hot * .5 * calm);
  glass = mix(glass, hi * 1.1, smoothstep(.5, .85, neb) * .5 * centre * calm);
  glass *= .78 + .32 * neb2;
  float stars = 0.;
  // three star layers at different depths: parallax when the camera moves round the lens
  for (int L = 0; L < 3; L++){
    float sc = L == 0 ? 18. : (L == 1 ? 34. : 62.);
    float dep = L == 0 ? .04 : (L == 1 ? .22 : .6);
    vec2 qs = lensQ(P, rdn, dep) * refr;
    vec2 cell = qs * sc + float(L) * 13.7;
    vec2 id = floor(cell);
    float hh = hash12(id);
    vec2 sp = hash22(id + 4.1) * .7 + .15;
    float dd = length(fract(cell) - sp) / sc;
    float rad = mix(.0028, .0062, hash12(id + 9.)) * (L == 0 ? 1.1 : (L == 1 ? .7 : .5));
    float sz = max(rad, pr * .55);
    float st = exp(-dd * dd / (sz * sz)) * (rad * rad) / (sz * sz);
    float tw = .65 + .35 * sin(uT * (1.3 + 2. * hh) + hh * 40.) * (1. - dim);
    stars += st * step(L == 0 ? .9 : (L == 1 ? .88 : .86), hh) * tw * (L == 0 ? 1.1 : (L == 1 ? .65 : .38));
  }
  stars *= (1. - smoothstep(.75, 1., d2)) * mix(1., .35, dim);
  float rings = 0.;
  for (int i = 1; i < 6; i++) rings += hairline(d2 - float(i) * .165, pr, .002) * (.5 + .1 * float(i));
  rings += hairline(length(q2 - vec2(.13, -.09)) - .52, pr, .002) * .7;
  rings += hairline(length(q2 + vec2(.11, -.16)) - .77, pr, .002) * .55;
  float spokes = hairline(abs(fract(atan(q2.y, q2.x) / 6.2831853 * 24.) - .5) * 6.2831853 / 24. * d2, pr, .0016) * smoothstep(.2, .45, d2) * .25;
  glass += vec3(.1, .22, .75) * (rings + spokes) * .16 * calm;
  // caustic: light focused by the lens onto the floor of the recess, a thin wavering ring
  vec2 dir2 = q2 / max(d2, 1e-4);
  float ang = atan(dir2.y, dir2.x);
  float cr = .6 + .008 * sin(ang * 7. + uT * .35) + .035 * (vnoise(dir2 * 2.2 + uT * .12) - .5);
  float cBright = .45 + .55 * vnoise(dir2 * 4. + vec2(uT * .2, 3.));
  float caus = (hairline(d2 - cr, pr, .0035) + .3 * exp(-pow((d2 - cr) / .035, 2.))) * cBright;
  caus += .45 * (hairline(d2 - cr * .52, pr, .0025) + .2 * exp(-pow((d2 - cr * .52) / .025, 2.))) * cBright;
  caus *= calm * (1. - rimSh * .7) * (1. - wall);
  glass += vec3(.18, .42, 1.) * caus * .2;
  float al2 = dot(q2, ld), ac2 = dot(q2, lp);
  glass += vec3(.04, .15, .6) * exp(-ac2 * ac2 / .02) * exp(-al2 * al2 / .3) * .3 * calm;
  glass = mix(glass, glass * .38, rimSh);
  glass *= mix(1., .55, dim);
  glass = mix(glass, vec3(dot(glass, vec3(.2126, .7152, .0722))) * vec3(.6, .75, 1.5), .3 * dim);
  vec3 wallC = mix(vec3(.008, .012, .04), vec3(.05, .07, .15), max(-dot(normalize(q2 + 1e-5), ld), 0.));
  glass = mix(glass, wallC, wall);
  float menisc = hairline(d - .975, pr, .005) * (.35 + .65 * max(-facing, 0.));
  glass += vec3(.3, .5, 1.) * menisc * .4 * calm;
  float cres = smoothstep(.8, .955, d) * (1. - smoothstep(.97, .995, d)) * pow(max(-facing, 0.), 2.2);
  vec2 gq = q - ld * .4;
  float ga = dot(gq, ld), gc = dot(gq, lp);
  float gsz = max(.022, pr * 1.2);
  float glint = exp(-(ga * ga + gc * gc) / (gsz * gsz)) + .5 * exp(-(ga * ga) / (gsz * gsz * .2) - gc * gc / .004)
              + .5 * exp(-(gc * gc) / (gsz * gsz * .2) - ga * ga / .004);
  float streak = exp(-pow(dot(q, lp) / max(.012, pr), 2.)) * exp(-pow(dot(q, ld) / .35, 2.)) * min(1., .012 / pr);
  float spec = (cres * 1.6 + glint * .5 + streak * .08) * mix(1., .5, dim);

  vec3 E = uAmb * (1. - sh.b) + uKey * difFlat * (1. - sh.r);
  vec3 Eb = uAmb * (1. - sh.b) + uKey * wrapDiff(dot(nb, uL)) * (1. - sh.r);
  vec3 table = alb * E;
  vec3 lipC = vec3(.012, .017, .042) * (1. + .8 * max(-facing, 0.))
            + vec3(.4, .46, .62) * hairline(d - 1.004, pr, .0025) * max(-facing, 0.)
            + alb * Eb * .5 * hairline(d - 1.047, pr, .0025) * max(facing, 0.);
  vec3 collarC = alb * .965 * E * (1. - beadSh) * (1. - .16 * groove + .1 * ridge);
  float bez = uCore2.z;
  // each zone blends against the table once (no mask x zone double coverage at the edges)
  vec3 col = table + on * (mGl * (glass - table)
           + bez * (mLip * (lipC - table) + mBev * (alb * 1.03 * Eb - table) + mCol * (collarC - table)));
  col += vec3(.85, .92, 1.) * spec * mGl * on * .6;

  // --- emitted light
  vec3 em = vec3(0.);
  float inner = mGl * on;
  em += uCobaltE * glow * inner * (.1 + .5 * smoothstep(.45, .9, neb) * centre + .55 * hot) * (1. - .8 * dim);
  em += vec3(.7, .85, 1.2) * stars * inner * (.6 + .8 * glow);
  em += vec3(.75, .88, 1.2) * spec * inner * (.35 + .8 * glow);
  em += uCobaltE * menisc * inner * glow * .45;
  em += vec3(.3, .6, 1.4) * caus * inner * (.12 + .45 * glow);
  col += vec3(.35, .5, 1.) * stars * inner * .45;

  // --- waves
  vec3 wem, wt, wsc; float wcov, wsh;
  waveField(P.xy, px, 1., wem, wt, wcov, wsc, wsh);
  float keepW = 1. - inner * .7;
  col *= mix(vec3(1.), wt, keepW * (1. - uDayG));
  col *= 1. - wsh * uDayG * keepW;
  col = mixS(col, wsc * E, wcov * uDayG * keepW);
  em += wem * (1. - inner * .6) * (1. - uDayG);

  // --- haze towards the horizon (tilted cameras); haze colour is the table itself
  float hz = mix(1., hazeAt(length(P - uEye)), hit);
  col = mix(col, uAir, hz);
  em *= 1. - hz;

  oScene = vec4(col, 1.);
  oLight = vec4(em, 1.);
}`;

// ---- tiles
const VS_TILE = `#version 300 es
${COMMON}
${TILE_ATTRIBS}
${ROT}
uniform mat4 uVP;
uniform float uDayG;
uniform float uCardPass; // 0: opaque/coverage pass (prepass + shade), 1: blended card pass
invariant gl_Position;
out vec3 vPos; out vec2 vLP;
flat out vec3 vN; flat out vec3 vTx; flat out vec3 vTy; flat out vec4 vC; flat out vec4 vD; flat out vec2 vHalf; flat out float vCard;
void main(){
  mat3 R = rotXYZ(vec3(iA.w, iB.x, iB.y));
  float flatV = smoothstep(.992, .999, abs(R[2].z));
  vec2 size = max(iB.zw, vec2(0.)) + flatV * 1.6 * step(1e-3, iB.zw);
  vec2 lp = aCorner * size;
  vec3 pos = iA.xyz + R[0] * lp.x + R[1] * lp.y;
  vPos = pos; vLP = lp; vN = R[2]; vTx = R[0]; vTy = R[1];
  vC = clamp(iC, 0., 1.);
  vD = vec4(clamp(iD.xy, 0., 1.), clamp(iD.z, 0., 2.), clamp(iD.w, 0., 1.)); vHalf = max(.5 * size, vec2(1e-3));
  // pass choice: a tile part way through a fade (alpha <= .995) goes to the blended pass when it is
  // a card-sized sheet (short side >= 40) anywhere, or any tile on a light table, so it fades with
  // true alpha instead of alpha-to-coverage steps; everything else draws in the coverage pass
  float card = max(step(40., min(iB.z, iB.w)), step(.5, uDayG)) * step(iC.a, .995);
  vCard = uCardPass;
  float mine = mix(1. - card, card, uCardPass);
  gl_Position = mix(vec4(2., 2., 2., 1.), uVP * vec4(pos, 1.), step(1e-4, iC.a) * mine);
}`;

const FS_TILE = `#version 300 es
${COMMON}
${LIGHT_UNIFORMS}
${WAVES}
uniform vec3 uEye;
uniform mat4 uSVP;
uniform sampler2D uShadowTex;
uniform float uHScaleInv;
uniform float uHashAlpha;
uniform vec3 uCobalt;
uniform vec3 uAir;
uniform vec3 uTint;
uniform vec3 uKeyT;
uniform float uTileEdge;
uniform float uNight;   // 0 day model, 1 dark-room model (follows ground.ink)
uniform vec3 uKeyN;     // cold key colour x intensity
uniform vec3 uBounceN;  // warm bounce from below x intensity
uniform vec3 uAmbN;     // near-black room fill
uniform vec3 uRimC;     // fresnel rim colour x strength
in vec3 vPos; in vec2 vLP;
flat in vec3 vN; flat in vec3 vTx; flat in vec3 vTy; flat in vec4 vC; flat in vec4 vD; flat in vec2 vHalf; flat in float vCard;
layout(location = 0) out vec4 oScene;
layout(location = 1) out vec4 oLight;

vec2 sproj(vec2 g){ vec4 c = uSVP * vec4(g, 0., 1.); return c.xy / c.w * .5 + .5; }
const vec2 BS[5] = vec2[5](vec2(0.), vec2(1., 0.), vec2(-1., 0.), vec2(0., 1.), vec2(0., -1.));
const vec2 PD[8] = vec2[8](vec2(.707, .707), vec2(-.707, .707), vec2(-.707, -.707), vec2(.707, -.707),
                          vec2(.46, 0.), vec2(0., .46), vec2(-.46, 0.), vec2(0., -.46));
// Shadow from tiles above, from the occluder-height channel: blocker search, then a
// penumbra-sized PCF ring (PCSS-lite).
float tileShadow(vec3 q, float slope, float flush){
  vec2 p = q.xy - uL.xy * (q.z / uL.z);
  vec2 u0 = sproj(p);
  mat2 J = mat2(sproj(p + vec2(1., 0.)) - u0, sproj(p + vec2(0., 1.)) - u0);
  float hb = 0.;
  for (int i = 0; i < 5; i++) hb = max(hb, texture(uShadowTex, u0 + J * (BS[i] * 8.)).g * uHScaleInv);
  float dz = max(hb - q.z, 0.);
  // a sheet stepping 24 to 48 units above its neighbour throws a soft 12 to 20 px shadow
  float pr = clamp(1.2 + .2 * dz, 1.2, 10.);
  float bias = .9 + slope * pr * 1.1 + flush; // resting sheets ignore height jitter within a sector
  float s = smoothstep(q.z + bias, q.z + bias + 1.6, texture(uShadowTex, u0).g * uHScaleInv);
  for (int i = 0; i < 8; i++){
    float g = texture(uShadowTex, u0 + J * (PD[i] * pr)).g * uHScaleInv;
    s += smoothstep(q.z + bias, q.z + bias + 1.6, g);
    vec2 o2 = vec2(PD[i].y, -PD[i].x) * .3 * pr;
    g = texture(uShadowTex, u0 + J * o2).g * uHScaleInv;
    s += smoothstep(q.z + bias, q.z + bias + 1.6, g);
  }
  return s / 17. * darkAt(dz) * 1.1;
}

void main(){
  vec3 V = normalize(uEye - vPos);
  float frontF = step(0., dot(vN, V));
  float back = 1. - frontF;
  vec3 n = vN * (frontF * 2. - 1.);
  vec2 lp = vLP;
  vec2 fwv = max(fwidth(lp), vec2(1e-4));
  float px = max(fwv.x, fwv.y);
  float seed = vD.w;
  float alpha = vC.a;
  float lines = vD.x;
  float spotK = step(1.5, vD.z);                         // hue 2: warm spot light
  float hue = min(vD.z, 1.);
  float amberK = smoothstep(.5, .95, hue) * (1. - spotK); // exact-word hits
  float restZ = mix(1. - smoothstep(70., 110., vPos.z), 1., uDayG) * (1. - step(20., min(vHalf.x, vHalf.y)));
  float rest = smoothstep(.992, .999, abs(vN.z)) * restZ;
  float restL = smoothstep(.97, .995, abs(vN.z)) * restZ;
  vec3 alb0 = toLin(vC.rgb);
  // cream paper (bright, low chroma) vs coloured families (sage, persimmon)
  float greenK = smoothstep(0., .045, vC.g - vC.r);          // sage family
  float warmK = smoothstep(.12, .3, vC.r - vC.g);            // persimmon / amber family
  float paperK = (1. - greenK) * (1. - warmK) * smoothstep(.2, .35, dot(alb0, vec3(.2126, .7152, .0722)));
  // glow: at night it is light on the marks; on a light table it is a lift toward #FDFDFC plus an
  // opaque cobalt edge, on cream paper only
  float gN = vD.y * (1. - uDayG) * (1. - spotK);          // night: light on the marks
  float gD = vD.y * uDayG * paperK * (1. - spotK) * (1. - amberK); // day cobalt: face lift only
  float gA = vD.y * uDayG * amberK;                     // day amber: full-face #F59F0A
  float glow = gN;

  // --- paper: aged cream (toward #E4D6BD), sheet-scale grain continuous across flush neighbours,
  // per-tile tone jitter under 1% at rest, tooth and fibres
  vec3 alb = alb0 * mix(vec3(1.), vec3(.88, .83, .75), paperK);
  // at rest a band reads as one sheet: cream tiles share one paper tone (#E4D6BD under the warm
  // light) and each coloured family (sage, persimmon) one luminance, so no per-tile mosaic
  float l0 = max(dot(alb0, vec3(.2126, .7152, .0722)), 1e-3);
  float famL = mix(.28, .42, smoothstep(-.02, .02, vC.g - vC.r));
  vec3 restAlb = mix(alb0 * (famL / l0), vec3(.746, .672, .541), paperK);
  alb = mix(alb, restAlb, restL * .92);
  float sheet = fbm3(vPos.xy * .011 + 2.7) - .5;
  float tv = hash12(vec2(seed * 113.1, 7.)) - .5;
  vec2 gp = lp + seed * vec2(137.1, 71.3);
  float cs = cos(seed * 12.), sn = sin(seed * 12.);
  vec2 fr = vec2(cs * gp.x - sn * gp.y, sn * gp.x + cs * gp.y);
  float tooth = (vnoise(gp * .9) - .5) * (1. - smoothstep(.5, 1.4, px * .9));
  float fibre = (vnoise(fr * vec2(.22, 1.6)) - .5) * (1. - smoothstep(.5, 1.4, px * 1.6));
  float wgrain = (vnoise(vPos.xy * .45 + 5.) - .5) * (1. - smoothstep(.7, 1.8, px * .45))
               + (vnoise(vPos.xy * vec2(.05, .6) + 9.) - .5) * .6 * (1. - smoothstep(.5, 1.4, px * .6));
  alb *= 1. + (sheet * mix(.09, .035, rest) + tv * mix(.03, .006, rest) + tooth * .07 + fibre * .06 + wgrain * .05 * rest)
            * mix(1., 1.5, back);
  alb *= mix(1., .9, back);

  // --- fine printed grid, faded out once cells get small on screen
  float gs = max(vHalf.x, vHalf.y) * 2. / 6.;
  vec2 gu = (lp + vHalf) / gs;
  vec2 gfw = fwv / gs;
  vec2 gd = abs(fract(gu - .5) - .5) / max(gfw, vec2(1e-4));
  float grid = (1. - min(min(gd.x, gd.y), 1.)) * (1. - smoothstep(.12, .32, max(gfw.x, gfw.y)));
  alb *= 1. - grid * (.06 + .03 * rest) * (1. - back * .6);

  // --- ruled text at a fixed world pitch (2 units): a large sheet carries a paragraph of fine
  // lines, a small tile a few. The line stripes are box-filtered analytically.
  float W = vHalf.x * 2., H = vHalf.y * 2.;
  float pitch = 2.;
  float mX = max(W * .1, 1.2), mY = max(H * .09, 1.2);
  float yy = (vHalf.y - mY - lp.y) / pitch;
  float fwr = fwv.y / pitch;
  float duty = .36 * (1. + .4 * smoothstep(0., .6, glow));
  float ya = yy - .5 * fwr, yb = yy + .5 * fwr;
  float cy = ((floor(yb) * duty + min(fract(yb), duty)) - (floor(ya) * duty + min(fract(ya), duty))) / max(yb - ya, 1e-4);
  float nRows = max(floor((H - 2. * mY) / pitch), 1.);
  float inRows = boxCov(0., nRows, yy, fwr);
  float row = floor(yy);
  float rh = hash12(vec2(seed * 91.7, row * 1.37));
  float len = mix(.84, 1., rh);
  len = mix(len, .3 + .3 * rh, step(rh, .2));             // short line ending a paragraph
  float live = step(.07, hash12(vec2(seed * 7.3, row)));  // occasional blank line
  float avgK = smoothstep(.5, 2., fwr);                   // many rows under one pixel: use the mean
  len = mix(len, .8, avgK); live = mix(live, .93, avgK);
  float x0 = -vHalf.x + mX;
  float text = cy * inRows * live * boxCov(x0, x0 + len * (W - 2. * mX), lp.x, fwv.x);
  vec3 glowAlbN = mix(mix(vec3(.012, .085, .62), vec3(.9, .78, .6), warmK), vec3(.86, .33, .003), hue);
  vec3 inkC = mix(alb * vec3(.42, .43, .46), glowAlbN, smoothstep(0., .5, glow));
  float textA = text * mix(lines, max(lines, 1.), smoothstep(0., .4, glow)) * mix(mix(.6, .95, smoothstep(0., .5, glow)), .14, back)
              * mix(1., .55, smoothstep(.6, 1.6, fwr));

  // --- edges: dark hairline plus a faint bevel, lighter on the lit side. A tile resting flat
  // and low among flush neighbours reads as part of a printed sheet: its edge fades towards a
  // faint grid line. Tilted or lifted cards keep it.
  float edgeK = uTileEdge * mix(1., mix(.28, .6, smoothstep(.2, .9, lines)), rest);
  vec2 ed = vHalf - abs(lp);
  vec2 edPx = ed / fwv;
  float hair = 1. - smoothstep(0., 1.05, min(edPx.x, edPx.y));
  vec2 bandW = max(vec2(.9), fwv * 1.6);
  vec2 bnd = (1. - smoothstep(bandW * .35, bandW * 1.6, ed)) * (1. - hair);
  vec3 ox = vTx * sign(lp.x), oy = vTy * sign(lp.y);
  float bev = bnd.x * dot(ox, uL) + bnd.y * dot(oy, uL);

  // --- lighting: a resting sheet is lit with one flat normal, so a sector shades as one piece
  n = normalize(mix(n, vec3(0., 0., sign(n.z + 1e-4)), restL));
  float nl0 = dot(n, uL);
  float dif = wrapDiff(nl0);
  float tilt = clamp(length(vN.xy) / max(abs(vN.z), .05), 0., 3.);
  float sh = tileShadow(vPos, tilt, 6. * restL);
  vec3 Eday = (uAmb + uKeyT * dif * (1. - sh)) * uTint;
  // cards in flight on a light table: faces turned to the key brighten, faces turned away darken,
  // a flat card keeps exactly the paper tone
  Eday *= 1. + .35 * (dif - wrapDiff(uL.z)) * (1. - restL) * uDayG;
  // Dark room: one key from the light side, a warm bounce from below and behind it, almost no
  // fill. The key's cold tint is capped (blue <= 0.97 red) so warm paper stays warm.
  vec3 bdir = normalize(vec3(-uL.xy * .6, -1.));
  float bnc = max((dot(n, bdir) + .35) / 1.35, 0.);
  vec3 En = uAmbN + uKeyN * max((nl0 + .25) / 1.25, 0.) * (1. - sh) + uBounceN * bnc;
  En.b = min(En.b, En.r * .97);
  vec3 E = mix(Eday, En, uNight);
  float fres = pow(1. - abs(dot(vN, V)), 3.);
  vec3 Hh = normalize(uL + V);
  float sheen = pow(max(dot(n, Hh), 0.), 28.) * .05 * (1. - back * .7) * (1. - sh);
  vec3 trans = uKeyT * max(-nl0, 0.) * .22;

  vec3 col = alb * (E + trans);
  // day cobalt glow: the face is lit toward card white (self-lit, stays in the paper family)
  col = mix(col, vec3(.982, .964, .913), smoothstep(0., .6, gD) * .85);
  col = mix(col, inkC * E, textA);
  // at rest the seam between flush neighbours is a 1 px engraved line, ~8% ink, no bevel
  col *= 1. - hair * mix(.2, .085, rest) * uTileEdge * mix(1., edgeK / max(uTileEdge, 1e-3), 1. - rest);
  col *= 1. + bev * .09 * edgeK * (1. - rest);
  // night glow: the rim turns to cobalt (or amber) ink; day glow: an opaque 2.5 px cobalt edge
  float rim = max(hair, max(bnd.x, bnd.y)) * mix(.7, 1., edgeK);
  col = mix(col, glowAlbN * E, rim * smoothstep(0., .6, gN) * .85);
    // (no per-tile cobalt outline on a light table)
  col += uKeyT * sheen * (1. - uNight) + uKeyN * sheen * 1.4 * uNight;
  col += alb * uRimC * fres;

  // --- emitted light (night only): glow on the printed marks and edge; waves wash over marks
  vec3 gcol = mix(mix(uCobaltE, uAmberE * vec3(1., 1.6, 3.), warmK), uAmberE, hue);
  float edgeM = max(hair, max(bnd.x, bnd.y) * .6);
  vec3 em = gcol * gN * (text * max(lines, .4) * .5 + rim * .7) + uRimC * fres * fres * .35 * uNight;
  vec3 wem, wt, wsc; float wcov, wsh;
  waveField(vPos.xy, px, 0., wem, wt, wcov, wsc, wsh);
  float wAtt = exp(-max(vPos.z, 0.) / 55.);
  float marksW = max(text * lines, hair * .6);
  col = mix(col, col * wt, wAtt * mix(.6, 1., marksW) * (1. - uDayG));
  col *= 1. - wsh * uDayG * wAtt;
  col = mixS(col, wsc * E, wcov * uDayG * wAtt);
  // the moving front of a cobalt wave: a soft cobalt glow on paper, a few tiles wide
  col = mixS(col, vec3(0., .0513, .4125), waveFront * .28 * paperK * uDayG * wAtt);
  // exact-word hit on a light table: full-face saturated amber, unlit, faint ruled lines, bloom
  float aF = smoothstep(0., .35, gA);
  col = mix(col, mix(vec3(.913, .347, .0033), vec3(.52, .17, .0), textA * .45), aF);
  em += uAmberE * gA * .3;
  // warm spot light (hue 2): the card is lit toward warm paper white #F3EBDC, any ground
  col = mix(col, vec3(.896, .831, .716), clamp(vD.y, 0., 1.) * spotK);
  em += wem * wAtt * .65 * marksW * (1. - uDayG);

  // --- distance haze (tilted cameras)
  float hz = hazeAt(length(vPos - uEye));
  col = mix(col, uAir, hz);
  em *= 1. - hz;

  // --- order-independent alpha: alpha-to-coverage with MSAA, else hashed discard
  float h = hash12(floor(gl_FragCoord.xy) + seed * 131.);
  if (uHashAlpha > .5 && alpha < h) discard;
  float a2c = clamp(alpha + (h - .5) * .24 * step(alpha, .999), 0., 1.);
  // card pass: the scene is linear light, so a linear alpha fade over the dark lens holds and then
  // drops at the end. alpha^2.2 makes equal alpha steps equal steps in display space.
  a2c = mix(a2c, pow(alpha, 2.2), vCard);
  oScene = vec4(col, a2c);
  oLight = vec4(em, a2c);
}`;

// Depth prepass for tiles: same coverage as the shading pass, no colour.
const FS_PRE = `#version 300 es
${COMMON}
uniform float uHashAlpha;
flat in vec4 vC; flat in vec4 vD;
out vec4 o;
void main(){
  float h = hash12(floor(gl_FragCoord.xy) + vD.w * 131.);
  float alpha = vC.a;
  if (uHashAlpha > .5 && alpha < h) discard;
  o = vec4(0., 0., 0., clamp(alpha + (h - .5) * .24 * step(alpha, .999), 0., 1.));
}`;

// ---- beams
const VS_BEAM = `#version 300 es
${COMMON}
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iP0; // x y z width
layout(location = 2) in vec4 iP1; // x y z intensity
layout(location = 3) in vec4 iH;  // hue
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uL;
uniform float uProj; // 1: draw the beam's shadow flat on the table along the light
out vec2 vUV; flat out vec4 vInfo;
void main(){
  vec3 p0 = iP0.xyz, p1 = iP1.xyz;
  p0 = mix(p0, vec3(p0.xy - uL.xy * (max(p0.z, 0.) / uL.z), .3), uProj);
  p1 = mix(p1, vec3(p1.xy - uL.xy * (max(p1.z, 0.) / uL.z), .3), uProj);
  vec3 dir = p1 - p0; float len = max(length(dir), 1e-3); vec3 dn = dir / len;
  float w = max(iP0.w, .1);
  float ext = w * 3.;
  float along = mix(-ext, len + ext, aCorner.x);
  vec3 P = p0 + dn * along;
  vec3 V = normalize(uEye - P);
  vec3 sd = cross(dn, mix(V, vec3(0., 0., 1.), uProj));
  sd = length(sd) > 1e-4 ? normalize(sd) : vec3(1., 0., 0.);
  float hw = w * mix(4.5, 6., uProj);
  P += sd * aCorner.y * hw;
  vUV = vec2(along, aCorner.y * hw / w);
  vInfo = vec4(len, ext, iP1.w, iH.x);
  gl_Position = mix(vec4(2., 2., 2., 1.), uVP * vec4(P, 1.), step(1e-4, iP1.w));
}`;

const FS_BEAM = `#version 300 es
${COMMON}
uniform vec3 uCobaltE, uAmberE, uCobalt;
uniform float uT;
uniform float uMode; // 0 night ink tint (multiply), 1 night light (add), 2 day stroke (alpha), 3 day shadow (multiply)
uniform float uK;    // weight of this pass (night or day share)
in vec2 vUV; flat in vec4 vInfo;
layout(location = 0) out vec4 oScene;
layout(location = 1) out vec4 oLight;
void main(){
  float len = vInfo.x, ext = vInfo.y, k = vInfo.z, hue = vInfo.w;
  float x = vUV.y;
  float core = exp(-x * x * 5.);
  float halo = exp(-x * x * .22);
  float ends = smoothstep(-ext, ext * .2, vUV.x) * smoothstep(len + ext, len - ext * .2, vUV.x);
  float flow = .82 + .18 * sin(vUV.x * .07 - uT * 6.);
  vec3 col = mix(uCobaltE, uAmberE, hue);
  vec3 light = col * k * ends * (core * 1.5 * flow + halo * .28) + vec3(.8, .9, 1.) * k * ends * core * core * .6;
  vec3 tintC = mix(vec3(.015, .108, .85), vec3(.6, .165, .004), hue); // ink colour over cream
  vec3 tint = mix(vec3(1.), tintC, clamp(exp(-x * x * 9.) * min(k * 1.6, 1.) * ends * .92, 0., 1.));
  float m0 = 1. - step(.5, abs(uMode)), m1 = 1. - step(.5, abs(uMode - 1.));
  float m2 = 1. - step(.5, abs(uMode - 2.)), m3 = 1. - step(.5, abs(uMode - 3.));
  // day: an opaque stroke one width wide, crisp ends, #0040AB or #F59F0A
  float fwx = max(fwidth(x), 1e-4), fwa = max(fwidth(vUV.x), 1e-4);
  float stroke = boxCov(-.5, .5, x, fwx) * boxCov(0., len, vUV.x, fwa) * clamp(k * 1.5, 0., 1.);
  vec3 sc = mix(vec3(0., .0513, .4125), vec3(.913, .347, .0033), hue);
  float shade = exp(-x * x * .12) * ends * clamp(k, 0., 1.) * .16;
  vec3 sceneOut = mix(vec3(1.), tint, uK) * m0 + sc * m2 + vec3(1. - shade * uK) * m3 + vec3(1.) * m1;
  oScene = vec4(sceneOut, stroke * uK * m2 + (1. - m2));
  oLight = vec4(light * uK * m1, 1.);
}`;

// ---- post
const FS_DOWN4 = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uDstRes;
uniform vec2 uSrcTexel;
out vec4 o;
vec3 kar(vec3 c){ return c / (1. + max3(c) * .25); }
void main(){
  vec2 uv = gl_FragCoord.xy / uDstRes;
  vec2 t = uSrcTexel;
  vec3 a = clean(texture(uSrc, uv + vec2(-t.x, -t.y)).rgb);
  vec3 b = clean(texture(uSrc, uv + vec2( t.x, -t.y)).rgb);
  vec3 c = clean(texture(uSrc, uv + vec2(-t.x,  t.y)).rgb);
  vec3 d = clean(texture(uSrc, uv + vec2( t.x,  t.y)).rgb);
  vec3 wa = kar(a), wb = kar(b), wc = kar(c), wd = kar(d);
  o = vec4((wa + wb + wc + wd) * .25, 1.);
}`;

const FS_BLUR = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform vec2 uDir; // texel step in uv
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 s = texture(uSrc, uv).rgb * .2270270;
  s += (texture(uSrc, uv + uDir * 1.3846154).rgb + texture(uSrc, uv - uDir * 1.3846154).rgb) * .3162162;
  s += (texture(uSrc, uv + uDir * 3.2307692).rgb + texture(uSrc, uv - uDir * 3.2307692).rgb) * .0702703;
  o = vec4(s, 1.);
}`;

const FS_OUT = `#version 300 es
${COMMON}
uniform sampler2D uScene, uLight, uB1, uB2;
uniform vec2 uRes;
uniform float uExposure, uBloom, uVignette, uGrain, uFade, uSeed;
uniform vec3 uFadeCol;
uniform sampler2D uDbg;
uniform float uDebug;
uniform float uGuardO;
uniform vec3 uVigTint; // per-channel vignette weight: warm umber falloff on cream, blue-black on ink
out vec4 o;
vec3 toSrgb(vec3 c){ c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 sc = clean(texture(uScene, uv).rgb);
  float m = max3(sc);
  float mc = mix(m, .86 + .14 * (1. - exp(-(m - .86) / .14)), step(.86, m));
  sc *= mc / max(m, 1e-5);
  // Bloom is a halo of light: it reads over dark ground, and backs off over saturated or bright
  // paper so cobalt over persimmon never turns magenta and a glowing sector never washes lavender.
  float chroma = max3(sc) - min(sc.r, min(sc.g, sc.b));
  float sl = dot(sc, vec3(.2126, .7152, .0722));
  vec3 L = clean(texture(uLight, uv).rgb) + clean(texture(uB1, uv).rgb * .6 + texture(uB2, uv).rgb * .9) * uBloom
         * (1. - .85 * min(chroma * 1.4, 1.)) * mix(1., .4, smoothstep(.1, .7, sl));
  L *= uExposure;
  float lm = max3(L);
  vec3 Lt = L * (1. - exp(-lm)) / max(lm, 1e-5);
  Lt = mix(Lt, vec3(max3(Lt)), smoothstep(1.3, 6., lm) * .6);
  vec3 col = sc + (1. - sc) * Lt;
  vec2 q = uv - .5;
  float r = length(q * vec2(1., .5625)) / .5735;
  col *= 1. - uVignette * .55 * smoothstep(.42, 1.05, r) * uVigTint;
  vec3 s = toSrgb(col);
  s = mix(s, uFadeCol, uFade);
  vec2 fc = floor(gl_FragCoord.xy);
  float n1 = hash12(fc + uSeed * vec2(17.31, 91.7));
  float n2 = hash12(fc * 1.37 + uSeed * vec2(41.3, 7.9) + 19.19);
  float luma = dot(s, vec3(.2126, .7152, .0722));
  s += (n1 + n2 - 1.) * uGrain * .03 * (.35 + .65 * (1. - abs(2. * luma - 1.)));
  float d1 = hash12(fc + 5.3 + uSeed * vec2(3.1, 5.7)), d2 = hash12(fc * .91 + 77.7 + uSeed);
  s += (d1 - d2) / 255.;
  vec4 dbg = texture(uDbg, (uv * 2. - 1.) / uGuardO * .5 + .5);
  s = mix(s, vec3(dbg.r, dbg.g / 200., dbg.b), uDebug);
  o = vec4(s, 1.);
}`;

// ---------------------------------------------------------------- helpers

function compile(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`render.js: ${name} shader failed to compile\n${log}`);
  }
  return sh;
}

function program(gl, vs, fs, name) {
  const p = gl.createProgram();
  const v = compile(gl, gl.VERTEX_SHADER, vs, name + '.vs');
  const f = compile(gl, gl.FRAGMENT_SHADER, fs, name + '.fs');
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`render.js: ${name} failed to link\n${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const key = info.name.replace(/\[0\]$/, '');
    u[key] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

function invert4(m) {
  const a = m, o = new Float32Array(16);
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  det = det ? 1 / det : 0;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
}

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------- renderer

export function createRenderer(canvas, { preserveDrawingBuffer = false } = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false,
    preserveDrawingBuffer, powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('render.js: WebGL2 unavailable');

  let floatOK, HDR, HDR_TYPE, SAMPLES, H_SCALE, P, fullVao, fullBuf, quadBuf, tileVao, instBuf, instCap;
  let shQuadBuf, shadowVao, beamQuad, beamVao, beamBuf;
  const beamData = new Float32Array(MAX_BEAMS * 12);
  let warnedBeams = false;
  let lost = false;

  function buildGL() {
    floatOK = !!gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    HDR = floatOK ? gl.RGBA16F : gl.RGBA8;
    HDR_TYPE = floatOK ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) | 0;
    SAMPLES = Math.min(4, maxSamples);
    H_SCALE = floatOK ? 1 : 1 / 512;

    P = {
      shadow: program(gl, VS_SHADOW, FS_SHADOW, 'shadow'),
      ground: program(gl, VS_FULL, FS_GROUND, 'ground'),
      tile: program(gl, VS_TILE, FS_TILE, 'tile'),
      pre: program(gl, VS_TILE, FS_PRE, 'prepass'),
      beam: program(gl, VS_BEAM, FS_BEAM, 'beam'),
      down: program(gl, VS_FULL, FS_DOWN4, 'down'),
      blur: program(gl, VS_FULL, FS_BLUR, 'blur'),
      out: program(gl, VS_FULL, FS_OUT, 'out'),
    };

    // geometry
    fullVao = gl.createVertexArray();
    gl.bindVertexArray(fullVao);
    fullBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fullBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);

    tileVao = gl.createVertexArray();
    gl.bindVertexArray(tileVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    instBuf = gl.createBuffer();
    instCap = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STRIDE * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }

    // shadow footprints: quad 0 (light-projected) and quad 1 (vertical AO) in one strip
    shQuadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, shQuadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 0,
      -0.5, -0.5, 1, -0.5, -0.5, 1, 0.5, -0.5, 1, -0.5, 0.5, 1, 0.5, 0.5, 1,
    ]), gl.STATIC_DRAW);
    shadowVao = gl.createVertexArray();
    gl.bindVertexArray(shadowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, shQuadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, STRIDE * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }

    beamQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, beamQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
    beamVao = gl.createVertexArray();
    gl.bindVertexArray(beamVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, beamQuad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    beamBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, beamBuf);
    gl.bufferData(gl.ARRAY_BUFFER, beamData.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, 48, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);
  }
  buildGL();

  // render targets
  let T = null;
  let W = 0, H = 0;

  function tex(w, h, fmt, type) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    void type;
    return t;
  }
  function fboTex(t) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return f;
  }
  function freeTargets() {
    if (!T) return;
    for (const t of T.textures) gl.deleteTexture(t);
    for (const r of T.rbs) gl.deleteRenderbuffer(r);
    for (const f of T.fbos) gl.deleteFramebuffer(f);
    T = null;
  }

  function resize(pw, ph) {
    if (gl.isContextLost()) { W = Math.max(1, Math.round(pw)); H = Math.max(1, Math.round(ph)); return; }
    pw = Math.max(1, Math.round(pw));
    ph = Math.max(1, Math.round(ph));
    if (pw === W && ph === H && T) return;
    freeTargets();
    W = pw; H = ph;
    canvas.width = W;
    canvas.height = H;
    const textures = [], rbs = [], fbos = [];
    const mk = (w, h) => { const t = tex(w, h, HDR, HDR_TYPE); textures.push(t); const f = fboTex(t); fbos.push(f); return { t, f, w, h }; };

    const scene = mk(W, H);
    const light = mk(W, H);
    const sw = Math.max(1, Math.round(W * SHADOW_SCALE)), shh = Math.max(1, Math.round(H * SHADOW_SCALE));
    const shadow = mk(sw, shh);
    const qw = Math.max(1, Math.round(W / 4)), qh = Math.max(1, Math.round(H / 4));
    const ew = Math.max(1, Math.round(W / 8)), eh = Math.max(1, Math.round(H / 8));
    const q1 = mk(qw, qh), q2 = mk(qw, qh), e1 = mk(ew, eh), e2 = mk(ew, eh);

    // main MRT target: MSAA renderbuffers when possible, else the resolve textures directly
    const main = gl.createFramebuffer();
    fbos.push(main);
    gl.bindFramebuffer(gl.FRAMEBUFFER, main);
    const depth = gl.createRenderbuffer();
    rbs.push(depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    if (SAMPLES > 0) {
      const c0 = gl.createRenderbuffer(), c1 = gl.createRenderbuffer();
      rbs.push(c0, c1);
      gl.bindRenderbuffer(gl.RENDERBUFFER, c0);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, SAMPLES, HDR, W, H);
      gl.bindRenderbuffer(gl.RENDERBUFFER, c1);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, SAMPLES, HDR, W, H);
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, SAMPLES, gl.DEPTH24_STENCIL8, W, H);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, c1);
    } else {
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, W, H);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, scene.t, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, light.t, 0);
    }
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depth);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const t of textures) gl.deleteTexture(t);
      for (const r of rbs) gl.deleteRenderbuffer(r);
      for (const f of fbos) gl.deleteFramebuffer(f);
      throw new Error('render.js: main framebuffer incomplete ' + status);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    T = { scene, light, shadow, q1, q2, e1, e2, main, textures, rbs, fbos };
  }

  function drawFull() {
    gl.bindVertexArray(fullVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  const waveA = new Float32Array(MAX_WAVES * 4);
  const waveB = new Float32Array(MAX_WAVES * 4);
  const creamLin = hexLin(CREAM), inkLin = hexLin(INK), cobaltLin = hexLin('#0040AB');
  const cobaltE = [0.02, 0.13, 1.0].map((v) => v * 2.2);
  const amberE = [1.0, 0.44, 0.035].map((v) => v * 1.8);
  const inkSrgb = hexSrgb(INK);

  const onLost = (e) => { e.preventDefault(); lost = true; };
  const onRestored = () => {
    buildGL();
    T = null; // old targets died with the context
    const w = W || canvas.width, h = H || canvas.height;
    W = 0; H = 0;
    resize(w, h);
    lost = false;
  };
  canvas.addEventListener('webglcontextlost', onLost, false);
  canvas.addEventListener('webglcontextrestored', onRestored, false);

  function render(fs) {
    if (lost || gl.isContextLost()) return;
    if (!T) resize(canvas.width || 1920, canvas.height || 1080);
    const t = fs.t || 0;
    const cam = fs.cam || defaultCam();
    const ground = { ...DEFAULTS.ground, ...(fs.ground || {}) };
    const lightS = { ...DEFAULTS.light, ...(fs.light || {}) };
    const core = { ...DEFAULTS.core, ...(fs.core || {}) };
    const post = { ...DEFAULTS.post, ...(fs.post || {}) };
    const shadowAmt = fs.shadow ?? DEFAULTS.shadow;
    const count = Math.max(0, Math.min(fs.count | 0, fs.tiles ? Math.floor(fs.tiles.length / STRIDE) : 0));

    const M = cameraMatrices(cam, 16 / 9);
    const VP = M.viewProj;
    const invVP = invert4(VP);
    const SVP = new Float32Array(VP);
    for (let c = 0; c < 4; c++) { SVP[c * 4] /= GUARD; SVP[c * 4 + 1] /= GUARD; }
    const eye = M.eye;

    // light rig
    const el = Math.max(0.08, Math.min(1.5707, lightS.el));
    const Lv = [Math.cos(el) * Math.cos(lightS.az), Math.cos(el) * Math.sin(lightS.az), Math.sin(el)];
    const warm = Math.max(0, Math.min(1, lightS.warmth));
    const wrap = 0.3;
    const difFlat = Math.max((Lv[2] + wrap) / (1 + wrap), 1e-3);
    // Shadow tint: sepia paper shadows under warm light, blue under cold light. The key is
    // solved per channel so a flat, unshadowed surface gets exactly the intensity (ground
    // hex survives); tiles additionally take the light's own tint.
    const seg = (a, m, b) => (warm < 0.6 ? lerp3(a, m, warm / 0.6) : lerp3(m, b, (warm - 0.6) / 0.4));
    const ambCol = seg([0.84, 0.92, 1.12], [0.94, 0.91, 0.95], [1.0, 0.91, 0.78]);
    const tintRaw = seg([0.9, 0.97, 1.1], [1.06, 1.0, 0.92], [1.04, 1.0, 0.94]);
    const tl = 0.2126 * tintRaw[0] + 0.7152 * tintRaw[1] + 0.0722 * tintRaw[2];
    const lightTint = tintRaw.map((v) => v / tl);
    const ink = Math.max(0, Math.min(1, ground.ink));
    const ka = lightS.ambient ?? (0.6 + (0.3 - 0.6) * ink);
    const inten = lightS.intensity ?? 1;
    const amb = ambCol.map((v) => v * ka * inten);
    const key = amb.map((a) => (inten - a) / difFlat);
    const keyT = amb.map((a) => (inten - a) / Math.max(difFlat, 0.8));
    const keyN = [0.84, 0.88, 1.0].map((v) => v * 1.3 * inten); // #BFD2FF pulled toward white
    const bounceN = hexLin('#F2C9A0').map((v) => v * 0.48 * inten);
    const ambN = [0.045, 0.042, 0.04].map((v) => v * inten);
    const rimK = ink * 0.35 * (0.12 + 0.88 * inten) + (1 - ink) * 0.04 * inten;
    const rimC = hexLin('#FFF4E0').map((v) => v * rimK);

    const hazeRef = Math.hypot(cam.x - cam.tx, cam.y - cam.ty, cam.z - cam.tz);
    const haze = fin(fs.haze, HAZE + 0.00042 * ink);
    const dayG = 1 - Math.min(1, Math.max(0, (ink - 0.4) / 0.2)); // light table below ink 0.4
    const baseLin = dawnGround(ink);
    const dawnAmt = Math.pow(4 * ink * (1 - ink), 1.5);
    const air = baseLin.map((v, i) => v * (1 + 0.1 * ink) + [0, 0.004, 0.012][i] * ink);

    // waves
    waveA.fill(0); waveB.fill(0);
    const waves = fs.waves || [];
    const nWaves = Math.min(MAX_WAVES, waves.length);
    for (let i = 0; i < nWaves; i++) {
      const w = waves[i];
      waveA.set([fin(w.x, 960), fin(w.y, 540), fin(w.r, 0), Math.max(0.5, fin(w.width, 20))], i * 4);
      waveB.set([Math.max(0, fin(w.intensity, 1)), clamp01(fin(w.hue, 0)), 0, 0], i * 4);
    }

    // instance upload
    if (count > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      const need = count * STRIDE * 4;
      if (need > instCap) {
        instCap = Math.max(need, Math.ceil(instCap * 1.5));
        gl.bufferData(gl.ARRAY_BUFFER, instCap, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, fs.tiles, 0, count * STRIDE);
    }

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);

    // ---- 1. shadow buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.shadow.f);
    gl.viewport(0, 0, T.shadow.w, T.shadow.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    if (count > 0 && shadowAmt > 0) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.MAX);
      gl.blendFunc(gl.ONE, gl.ONE);
      const p = P.shadow;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.uSVP, false, SVP);
      gl.uniform3fv(p.u.uL, Lv);
      gl.uniform1f(p.u.uShadowAmt, shadowAmt);
      gl.uniform4fv(p.u.uShadowK, SHADOW_K);
      gl.uniform1f(p.u.uHScale, H_SCALE);
      gl.uniform1f(p.u.uDayG, dayG);
      gl.uniform1f(p.u.uFlightK, dayG);
      gl.bindVertexArray(shadowVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 10, count);
      gl.blendEquation(gl.FUNC_ADD);
      gl.disable(gl.BLEND);
    }

    // ---- 2. scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.main);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    const setLight = (u) => {
      gl.uniform3fv(u.uL, Lv);
      gl.uniform3fv(u.uAmb, amb);
      gl.uniform3fv(u.uKey, key);
      gl.uniform1f(u.uWrap, wrap);
      gl.uniform1f(u.uShadowAmt, shadowAmt);
      gl.uniform4fv(u.uShadowK, SHADOW_K);
      gl.uniform1f(u.uHaze, haze);
      gl.uniform1f(u.uHazeRef, hazeRef);
      gl.uniform3fv(u.uAir, air);
      if (u.uTint) gl.uniform3fv(u.uTint, lightTint);
      if (u.uKeyT) gl.uniform3fv(u.uKeyT, keyT);
      if (u.uTileEdge) gl.uniform1f(u.uTileEdge, clamp01(fin(fs.tileEdge, 1)));
      if (u.uDayG) gl.uniform1f(u.uDayG, dayG);
      if (u.uNight) {
        gl.uniform1f(u.uNight, ink);
        gl.uniform3fv(u.uKeyN, keyN); gl.uniform3fv(u.uBounceN, bounceN);
        gl.uniform3fv(u.uAmbN, ambN); gl.uniform3fv(u.uRimC, rimC);
      }
    };
    const setWaves = (u) => {
      gl.uniform4fv(u.uWaveA, waveA);
      gl.uniform4fv(u.uWaveB, waveB);
      gl.uniform3fv(u.uCobaltE, cobaltE);
      gl.uniform3fv(u.uAmberE, amberE);
      gl.uniform1i(u.uWaveN, nWaves);
    };

    // ground (writes its own depth)
    {
      const p = P.ground;
      gl.useProgram(p.p);
      setLight(p.u); setWaves(p.u);
      gl.uniformMatrix4fv(p.u.uInvVP, false, invVP);
      gl.uniformMatrix4fv(p.u.uVP, false, VP);
      gl.uniform2f(p.u.uRes, W, H);
      gl.uniform1f(p.u.uGuard, GUARD);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T.shadow.t);
      gl.uniform1i(p.u.uShadowTex, 0);
      gl.uniform3fv(p.u.uCream, creamLin);
      gl.uniform3fv(p.u.uInkCol, inkLin);
      gl.uniform1f(p.u.uInk, ground.ink);
      gl.uniform3fv(p.u.uBase, baseLin);
      gl.uniform1f(p.u.uDawn, dawnAmt);
      gl.uniform2f(p.u.uGlowC, cam.tx, cam.ty);
      gl.uniform1fv(p.u.uDawnU, DAWN_U);
      gl.uniform3fv(p.u.uDawnLab, DAWN_LAB);
      gl.uniform1f(p.u.uDawnP, 1 - ink);
      gl.uniform1f(p.u.uLines, ground.lines);
      gl.uniform2f(p.u.uLinesC, ground.linesX, ground.linesY);
      gl.uniform4f(p.u.uCore, core.x, core.y, Math.max(1, core.r), core.on);
      gl.uniform3f(p.u.uCore2, core.glow, core.dim, clamp01(fin(core.bezel, 1)));
      gl.uniform3fv(p.u.uCobalt, cobaltLin);
      gl.uniform3fv(p.u.uEye, eye);
      gl.uniform1f(p.u.uT, t);
      drawFull();
    }

    gl.depthFunc(gl.LEQUAL);
    // tiles: depth prepass (same coverage, no colour), then shade only the visible surface
    if (count > 0) {
      const pp = P.pre;
      gl.useProgram(pp.p);
      gl.uniformMatrix4fv(pp.u.uVP, false, VP);
      gl.uniform1f(pp.u.uHashAlpha, SAMPLES > 0 ? 0 : 1);
      gl.uniform1f(pp.u.uDayG, dayG);
      gl.uniform1f(pp.u.uCardPass, 0);
      if (SAMPLES > 0) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.colorMask(false, false, false, false);
      gl.bindVertexArray(tileVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.colorMask(true, true, true, true);
      gl.depthMask(false);
      const p = P.tile;
      gl.useProgram(p.p);
      setLight(p.u); setWaves(p.u);
      gl.uniformMatrix4fv(p.u.uVP, false, VP);
      gl.uniformMatrix4fv(p.u.uSVP, false, SVP);
      gl.uniform3fv(p.u.uEye, eye);
      gl.uniform1f(p.u.uHScaleInv, 1 / H_SCALE);
      gl.uniform1f(p.u.uHashAlpha, SAMPLES > 0 ? 0 : 1);
      gl.uniform3fv(p.u.uCobalt, cobaltLin);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, T.shadow.t);
      gl.uniform1i(p.u.uShadowTex, 0);
      if (SAMPLES > 0) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.uniform1f(p.u.uCardPass, 0);
      gl.bindVertexArray(tileVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      // fading card-sized sheets anywhere, and every fading tile on a light table: true alpha
      // blending, depth-tested, no depth write; the stencil keeps one layer per sample so stacked
      // (or seam-grown, overlapping) tiles do not double-blend
      gl.uniform1f(p.u.uCardPass, 1);
      gl.uniform1f(p.u.uHashAlpha, 0); // blended: never hash-discard, even without MSAA
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    // beams: tint the scene (multiply), then add light
    const beams = fs.beams || [];
    if (beams.length > MAX_BEAMS && !warnedBeams) { warnedBeams = true; console.warn(`render.js: ${beams.length} beams sent, drawing the first ${MAX_BEAMS}`); }
    const nb = Math.min(MAX_BEAMS, beams.length);
    if (nb > 0) {
      for (let i = 0; i < nb; i++) {
        const b = beams[i];
        beamData.set([fin(b.x0, 0), fin(b.y0, 0), fin(b.z0, 0), Math.max(0.1, fin(b.width, 3)), fin(b.x1, 0), fin(b.y1, 0), fin(b.z1, 0),
          Math.max(0, fin(b.intensity, 1)), clamp01(fin(b.hue, 0)), 0, 0, 0], i * 12);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, beamBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, beamData, 0, nb * 12);
      const p = P.beam;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.uVP, false, VP);
      gl.uniform3fv(p.u.uEye, eye);
      gl.uniform3fv(p.u.uCobaltE, cobaltE);
      gl.uniform3fv(p.u.uAmberE, amberE);
      gl.uniform3fv(p.u.uCobalt, cobaltLin);
      gl.uniform1f(p.u.uT, t);
      gl.uniform3fv(p.u.uL, Lv);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.bindVertexArray(beamVao);
      const pass = (mode, k, proj, buffers, src, dst) => {
        if (k <= 0) return;
        gl.drawBuffers(buffers);
        gl.blendFunc(src, dst);
        gl.uniform1f(p.u.uMode, mode);
        gl.uniform1f(p.u.uK, k);
        gl.uniform1f(p.u.uProj, proj);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nb);
      };
      // light table: a soft shadow on the paper, then an opaque stroke (never additive)
      pass(3, dayG, 1, [gl.COLOR_ATTACHMENT0, gl.NONE], gl.DST_COLOR, gl.ZERO);
      pass(2, dayG, 0, [gl.COLOR_ATTACHMENT0, gl.NONE], gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // ink table: ink tint and emitted light
      pass(0, 1 - dayG, 0, [gl.COLOR_ATTACHMENT0, gl.NONE], gl.DST_COLOR, gl.ZERO);
      pass(1, 1 - dayG, 0, [gl.NONE, gl.COLOR_ATTACHMENT1], gl.ONE, gl.ONE);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    }
    gl.disable(gl.DEPTH_TEST);

    // resolve MSAA
    if (SAMPLES > 0) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.main);
      for (let i = 0; i < 2; i++) {
        const dst = i === 0 ? T.scene : T.light;
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + i);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.f);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }

    // ---- 3. bloom
    const bloomOn = (post.bloom ?? 1) > 0;
    if (bloomOn) {
      const down = (src, dst) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
        gl.viewport(0, 0, dst.w, dst.h);
        const p = P.down;
        gl.useProgram(p.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.t);
        gl.uniform1i(p.u.uSrc, 0);
        gl.uniform2f(p.u.uDstRes, dst.w, dst.h);
        gl.uniform2f(p.u.uSrcTexel, 1 / src.w, 1 / src.h);
        drawFull();
      };
      const blur = (src, dst, dx, dy) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
        gl.viewport(0, 0, dst.w, dst.h);
        const p = P.blur;
        gl.useProgram(p.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src.t);
        gl.uniform1i(p.u.uSrc, 0);
        gl.uniform2f(p.u.uRes, dst.w, dst.h);
        gl.uniform2f(p.u.uDir, dx / src.w, dy / src.h);
        drawFull();
      };
      down(T.light, T.q1);
      blur(T.q1, T.q2, 1.25, 0); blur(T.q2, T.q1, 0, 1.25);
      down(T.q1, T.e1);
      blur(T.e1, T.e2, 1.6, 0); blur(T.e2, T.e1, 0, 1.6);
    }

    // ---- 4. output
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    {
      const p = P.out;
      gl.useProgram(p.p);
      const bind = (unit, t, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(p.u[name], unit); };
      bind(0, T.scene.t, 'uScene');
      bind(1, T.light.t, 'uLight');
      bind(2, T.q1.t, 'uB1');
      bind(3, T.e1.t, 'uB2');
      bind(4, T.shadow.t, 'uDbg');
      gl.uniform1f(p.u.uDebug, fs.debug === 'shadow' ? 1 : 0);
      gl.uniform1f(p.u.uGuardO, GUARD);
      const inkO = clamp01(fin(fs.ground?.ink, 0));
      gl.uniform3fv(p.u.uVigTint, lerp3([0.78, 0.98, 1.34], [1.15, 1.02, 0.84], inkO));
      gl.uniform2f(p.u.uRes, W, H);
      gl.uniform1f(p.u.uExposure, post.exposure);
      gl.uniform1f(p.u.uBloom, bloomOn ? post.bloom : 0);
      gl.uniform1f(p.u.uVignette, post.vignette);
      gl.uniform1f(p.u.uGrain, post.grain);
      gl.uniform1f(p.u.uFade, post.fade);
      gl.uniform1f(p.u.uSeed, Math.round(t * 60) % 4096);
      const fc = Array.isArray(post.fadeColor) && post.fadeColor.length >= 3 ? post.fadeColor.slice(0, 3).map((v) => clamp01(fin(v, 0))) : inkSrgb;
      gl.uniform3fv(p.u.uFadeCol, fc);
      drawFull();
    }
    gl.bindVertexArray(null);
  }

  function destroy() {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    freeTargets();
    for (const k in P) gl.deleteProgram(P[k].p);
    for (const b of [fullBuf, quadBuf, shQuadBuf, instBuf, beamQuad, beamBuf]) gl.deleteBuffer(b);
    for (const v of [fullVao, tileVao, shadowVao, beamVao]) gl.deleteVertexArray(v);
  }

  return {
    gl, resize, render, destroy,
    get lost() { return lost || gl.isContextLost(); },
    get info() { return { floatTargets: floatOK, samples: SAMPLES }; },
  };
}
