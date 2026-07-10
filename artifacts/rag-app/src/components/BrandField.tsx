import { useEffect, useRef, useState } from "react";
import {
  createGovernor,
  DEFAULT_TIER,
  TARGET_INTERVAL_MS
} from "@/lib/fieldQuality";

/**
 * BrandField — the living version of the login blob washes (DESIGN.md
 * §Brand moments, scale 1). A hand-rolled WebGL fragment shader renders
 * the brand inks (primary blue, evergreen, a whisper of amber) diffusing
 * through the cream canvas like watercolor through cotton paper:
 * domain-warped fractal noise, whisper-slow, with a gentle lens that
 * follows the pointer.
 *
 * This is decoration for the ONE sanctioned full-scale brand moment
 * (auth surfaces), so it is engineered to never cost anything anywhere
 * else:
 *   - aria-hidden + pointer-events-none — purely decorative
 *   - prefers-reduced-motion → a single static frame (still the
 *     watercolor, just frozen), and the pointer lens is disabled
 *   - WebGL unavailable / context lost → falls back to the original
 *     pure-CSS blur blobs, so the page never regresses below what
 *     shipped before this component existed
 *   - rAF loop pauses when the tab is hidden
 *   - renders at a capped, sub-native resolution (the field is soft by
 *     design, so upscaling is invisible and the fill-rate cost drops
 *     ~4x on hiDPI screens)
 *   - draws at ~30fps, not 60 — the field moves too slowly for the
 *     difference to be perceptible — and a quality governor
 *     (lib/fieldQuality.ts) steps render scale, then octaves, then
 *     freezes the loop on hardware that still can't hold budget, so a
 *     weak iGPU gets the same composition without the fan noise
 *
 * No dependencies: raw WebGL1, one fullscreen triangle, one fragment
 * shader. Ink colors are the sRGB hex equivalents of the OKLCH tokens
 * (GLSL can't read CSS custom properties; same tradeoff as
 * .select-quiet's chevron — revisit if the palette ever changes).
 */

/** DPR cap: field is soft, so sub-native resolution is invisible. */
const MAX_DPR = 1.25;

const VERT = `
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

/**
 * Ink palette (sRGB 0..1), from DESIGN.md tokens:
 *   cream   #E8E6DE (--background)
 *   paper   #FDFDFC (--card, used for the bright "dry paper" ridges)
 *   blue    #0040AB (--primary)
 *   vivid   #005DE5 (--accent)
 *   green   #39594D (--success)
 *   amber   #F59F0A (--warning, homeopathic dose)
 */
const FRAG = `
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_pointer;
uniform float u_lens;
uniform float u_octaves;

const vec3 CREAM = vec3(0.9098, 0.9020, 0.8706);
const vec3 PAPER = vec3(0.9922, 0.9922, 0.9882);
const vec3 BLUE  = vec3(0.0,    0.2510, 0.6706);
const vec3 VIVID = vec3(0.0,    0.3647, 0.8980);
const vec3 GREEN = vec3(0.2235, 0.3490, 0.3020);
const vec3 AMBER = vec3(0.9608, 0.6235, 0.0392);

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// GLSL ES 1.0 needs constant loop bounds, so the governor's octave
// count arrives as a uniform-gated break inside a constant-bound loop.
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    if (float(i) >= u_octaves) break;
    v += amp * vnoise(p);
    p = rot * p * 2.03;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);

  // Gentle pointer lens: space dilates slightly around the cursor, so
  // the ink appears to flow away from the hand. u_lens eases in/out in
  // JS; zero when reduced-motion or the pointer is idle off-canvas.
  vec2 pt = vec2(u_pointer.x * aspect, u_pointer.y);
  vec2 toPt = p - pt;
  p += normalize(toPt + 1e-4) * 0.045 * exp(-dot(toPt, toPt) * 7.0) * u_lens;

  float t = u_time * 0.022;

  // Domain warp: q warps r warps the field. The classic Quilez recipe,
  // tuned very slow — the motion should read as barely-alive.
  vec2 q = vec2(
    fbm(p * 1.35 + vec2(0.0, t)),
    fbm(p * 1.35 + vec2(5.2, 1.3) - t * 0.8)
  );
  vec2 r = vec2(
    fbm(p * 1.35 + 2.3 * q + vec2(1.7, 9.2) + t * 0.35),
    fbm(p * 1.35 + 2.3 * q + vec2(8.3, 2.8) - t * 0.26)
  );
  float f = fbm(p * 1.35 + 2.1 * r);

  // Spatial anchors keep the brand geometry of the CSS original:
  // blue pools toward the top-right, evergreen toward the bottom-left,
  // and a calm-zone mask holds the middle to quiet paper so the card
  // always sits on stillness.
  float calm   = smoothstep(0.18, 0.62, distance(uv, vec2(0.5, 0.52)));
  float wBlue  = smoothstep(1.0, 0.15, distance(uv, vec2(0.88, 0.9))) * calm;
  float wGreen = smoothstep(0.9, 0.1,  distance(uv, vec2(0.08, 0.05))) * calm;

  vec3 col = CREAM;

  // Thresholds are tuned to this fbm's actual distribution (median
  // ~0.45, p90 ~0.58, max ~0.78 — measured, not eyeballed).

  // Dry-paper ridges: where the field runs high, the paper brightens a
  // touch before the ink arrives — gives the wash its watercolor edge.
  col = mix(col, PAPER, smoothstep(0.5, 0.72, f) * 0.35);

  float blueInk = smoothstep(0.42, 0.68, f);
  col = mix(col, BLUE,  blueInk * wBlue * 0.3);
  col = mix(col, VIVID, smoothstep(0.56, 0.75, f) * wBlue * 0.18);

  float g = fbm(p * 1.35 + 1.7 * q + vec2(3.1, 7.7));
  float greenInk = smoothstep(0.4, 0.66, g);
  col = mix(col, GREEN, greenInk * wGreen * 0.28);

  // One thin amber filament tracing an isocontour of the field, gated
  // to where ink has actually pooled — the warm accent at homeopathic
  // dose, like a gold vein in marbled paper.
  float inkAmt = blueInk * wBlue + greenInk * wGreen;
  float thread = smoothstep(0.016, 0.0, abs(f - 0.52)) * smoothstep(0.12, 0.35, inkAmt);
  col = mix(col, AMBER, thread * 0.14);

  // Film grain / dither: kills gradient banding on the big soft washes.
  float grain = hash(gl_FragCoord.xy + fract(u_time) * 61.7) - 0.5;
  col += grain * (2.0 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * The pure-CSS blobs this component replaced — kept verbatim as the
 * no-WebGL / lost-context fallback so the brand moment never disappears.
 */
function StaticBlobs(): JSX.Element {
  return (
    <>
      <div className="pointer-events-none absolute -right-24 -top-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -left-32 h-[28rem] w-[28rem] rounded-full bg-success/15 blur-3xl" />
    </>
  );
}

export function BrandField(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power"
    });
    if (!gl) {
      setFallback(true);
      return;
    }

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vert || !frag || !program) {
      setFallback(true);
      return;
    }
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      setFallback(true);
      return;
    }
    gl.useProgram(program);

    // One fullscreen triangle (covers the clip square with 3 verts).
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, "u_res");
    const uTime = gl.getUniformLocation(program, "u_time");
    const uPointer = gl.getUniformLocation(program, "u_pointer");
    const uLens = gl.getUniformLocation(program, "u_lens");
    const uOctaves = gl.getUniformLocation(program, "u_octaves");

    // Adaptive quality: starts at full (tier 0) and only ever steps
    // down; capable hardware keeps the shipped visual untouched.
    const governor = createGovernor();
    let tier = DEFAULT_TIER;
    let frozen = false;
    gl.uniform1f(uOctaves, tier.octaves);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = performance.now();
    // Each visit opens a different page of the field — the composition
    // is tuned to hold at any t, so a random phase keeps the moment
    // from feeling canned. The reduced-motion frame stays the fixed,
    // curated t=46 (deterministic, reviewed against contrast).
    const phase = Math.random() * 400;
    let raf = 0;
    let running = false;

    // Pointer state, smoothed in JS so the shader gets pre-eased values.
    let targetX = 0.5;
    let targetY = 0.5;
    let pointerX = 0.5;
    let pointerY = 0.5;
    let targetLens = 0;
    let lens = 0;

    function resize(): void {
      if (!canvas || !gl) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr * tier.scale));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr * tier.scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    }

    function draw(timeSeconds: number): void {
      if (!canvas || !gl) return;
      resize();
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, timeSeconds);
      gl.uniform2f(uPointer, pointerX, pointerY);
      gl.uniform1f(uLens, lens);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    let lastDrawn = 0;

    function frame(now: number): void {
      raf = requestAnimationFrame(frame);
      // ~30fps cap: the field is too slow for 60fps to be visible, and
      // skipping every other vsync halves the GPU cost outright.
      if (now - lastDrawn < TARGET_INTERVAL_MS) return;
      const delta = lastDrawn === 0 ? 0 : now - lastDrawn;
      lastDrawn = now;
      // Smoothing factors are per DRAWN frame (~33ms tick), tuned to
      // the same time constant the old per-vsync 0.06/0.05 gave.
      pointerX += (targetX - pointerX) * 0.12;
      pointerY += (targetY - pointerY) * 0.12;
      lens += (targetLens - lens) * 0.1;
      draw(phase + (now - start) / 1000);
      if (delta === 0) return;
      const verdict = governor.sample(delta);
      if (verdict === "stepped") {
        tier = governor.tier;
        gl?.uniform1f(uOctaves, tier.octaves);
        // resize() picks up the new scale on the next draw.
      } else if (verdict === "freeze") {
        // Floor tier: hold the last-drawn frame. Same composition,
        // no motion — smooth page beats moving ink on this hardware.
        frozen = true;
        stopLoop();
      }
    }

    function startLoop(): void {
      if (running || frozen || reduced.matches) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }

    function stopLoop(): void {
      running = false;
      cancelAnimationFrame(raf);
    }

    /** Reduced motion: one hand-picked frozen frame, no loop, no lens. */
    function renderStatic(): void {
      lens = 0;
      draw(46.0);
    }

    function onPointerMove(e: PointerEvent): void {
      targetX = e.clientX / window.innerWidth;
      targetY = 1 - e.clientY / window.innerHeight;
      targetLens = 1;
    }
    function onPointerLeave(): void {
      targetLens = 0;
    }
    function onVisibility(): void {
      if (document.hidden) stopLoop();
      else if (!reduced.matches) startLoop();
    }
    function onMotionPref(): void {
      if (reduced.matches) {
        stopLoop();
        renderStatic();
      } else {
        startLoop();
      }
    }
    function onContextLost(e: Event): void {
      e.preventDefault();
      stopLoop();
      setFallback(true);
    }

    const ro = new ResizeObserver(() => {
      if (reduced.matches) renderStatic();
    });
    ro.observe(canvas);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotionPref);
    canvas.addEventListener("webglcontextlost", onContextLost);

    // First frame synchronously: rAF doesn't fire in hidden/backgrounded
    // tabs, and a login page restored from a background tab should show
    // the field, not a blank canvas, on its first visible paint.
    if (reduced.matches) {
      renderStatic();
    } else {
      draw(phase);
      startLoop();
    }

    return () => {
      stopLoop();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotionPref);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      // Deliberately NOT losing the context here: StrictMode double-mounts
      // effects, and a killed context survives on the reused canvas node,
      // which would trip the fallback on the second mount. The browser
      // reclaims the context with the canvas when the page really unmounts.
      gl.deleteProgram(program);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteBuffer(buf);
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {fallback ? (
        <StaticBlobs />
      ) : (
        <canvas ref={canvasRef} className="h-full w-full" />
      )}
    </div>
  );
}
