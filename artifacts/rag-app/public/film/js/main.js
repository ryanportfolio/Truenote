// Boot, clock and stage. Every frame is frameState(t) -> renderer, then
// drawUI(t) -> 2D layer, so seeking and exporting are exact.
import { DURATION, CHAPTERS, frameState, drawUI, captions, setReducedMotion } from './choreo.js';

const stage = document.getElementById('stage');
let glCanvas = document.getElementById('gl');
const uiCanvas = document.getElementById('ui');
const uctx = uiCanvas.getContext('2d');
const params = new URLSearchParams(location.search);
// ?motion=reduce forces the reduced version; ?motion=full overrides the OS setting (export).
const motion = params.get('motion');
setReducedMotion(motion === 'reduce' || (motion !== 'full' && window.matchMedia('(prefers-reduced-motion: reduce)').matches));

let renderer = null;
let rendererMode = null;
let ui = null;
let t = Math.max(0, Math.min(DURATION, Number(params.get('t')) || 0));
let playing = !params.has('paused');
let rate = 1;
let last = null;
let dirty = true;
let exportMode = false;
let composite = null;
let pixelW = 0, pixelH = 0;
const listeners = new Set();

function replaceCanvas() {
  const c = document.createElement('canvas');
  c.id = 'gl';
  c.setAttribute('aria-hidden', 'true');
  glCanvas.replaceWith(c);
  glCanvas = c;
}

function sizeTo(w, h) {
  if (w === pixelW && h === pixelH) return;
  pixelW = w; pixelH = h;
  renderer.resize(w, h);
  uiCanvas.width = w; uiCanvas.height = h;
  dirty = true;
}

function fit() {
  if (exportMode) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cssW = Math.min(vw, (vh * 16) / 9);
  const cssH = (cssW * 9) / 16;
  stage.style.width = `${cssW}px`;
  stage.style.height = `${cssH}px`;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.min(2560, Math.round(cssW * dpr));
  sizeTo(w, Math.round((w * 9) / 16));
}

function draw(time) {
  const fs = frameState(time);
  renderer.render(fs);
  uctx.setTransform(1, 0, 0, 1, 0, 0);
  uctx.clearRect(0, 0, uiCanvas.width, uiCanvas.height);
  const s = uiCanvas.width / 1920;
  uctx.setTransform(s, 0, 0, s, 0, 0);
  drawUI(uctx, time, ui, fs.cam);
  dirty = false;
}

// WebGL2 unless ?debug2d. A renderer that fails to construct, allocate or
// draw its first frame is torn down and replaced by the 2D debug renderer.
async function loadRenderer() {
  if (!params.has('debug2d')) {
    try {
      const m = await import('./render.js');
      renderer = m.createRenderer(glCanvas, { preserveDrawingBuffer: params.has('export') });
      pixelW = 0; fit(); draw(t);
      rendererMode = 'webgl2';
      // Runs after render.js's own restore handler (registered first), so the
      // redraw uses the rebuilt programs and targets, even while paused.
      glCanvas.addEventListener('webglcontextrestored', () => { if (exportMode) draw(t); else dirty = true; });
      return;
    } catch (e) {
      console.warn('WebGL renderer failed, using the 2D debug renderer:', e);
      try { renderer?.destroy(); } catch { /* already broken */ }
      renderer = null;
      replaceCanvas();
    }
  }
  const m = await import('./debug2d.js');
  renderer = m.createDebugRenderer(glCanvas);
  pixelW = 0; fit(); draw(t);
  rendererMode = 'debug2d';
}

function tick(now) {
  if (last !== null && playing) {
    const dt = Math.min(0.1, (now - last) / 1000);
    t += dt * rate;
    dirty = true;
    if (t >= DURATION) { t = DURATION; playing = false; emit(); }
  }
  last = now;
  if (dirty && !exportMode) draw(t);
  requestAnimationFrame(tick);
}

function emit() { for (const f of listeners) f(); }

let resolveReady, rejectReady;
const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
ready.catch(() => {}); // boot() logs the failure; callers still see the rejection.

const anim = {
  ready,
  get renderer() { return rendererMode; },
  seek(x) { t = Math.max(0, Math.min(DURATION, Number(x) || 0)); if (renderer) draw(t); emit(); },
  play() { if (exportMode) anim.endExport(); if (t >= DURATION) t = 0; playing = true; emit(); },
  pause() { playing = false; emit(); },
  get t() { return t; },
  get playing() { return playing; },
  get rate() { return rate; },
  set rate(r) { rate = r; },
  duration: DURATION,
  chapters: CHAPTERS,
  captions,
  onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  // Export: switch the canvases to 1920x1080 once, then render any t on demand
  // and return a 2D canvas holding the composited frame.
  renderAt(time) {
    if (!exportMode) {
      exportMode = true;
      playing = false;
      sizeTo(1920, 1080);
      composite = document.createElement('canvas');
      composite.width = 1920; composite.height = 1080;
    }
    // A lost context draws nothing: fail loudly so an export never encodes stale frames.
    if (rendererMode === 'webgl2' && renderer.lost) throw new Error('renderAt: WebGL context lost');
    draw(time);
    const c = composite.getContext('2d');
    c.clearRect(0, 0, 1920, 1080);
    c.drawImage(glCanvas, 0, 0, 1920, 1080);
    c.drawImage(uiCanvas, 0, 0, 1920, 1080);
    return composite;
  },
  endExport() { exportMode = false; pixelW = 0; fit(); draw(t); },
};
window.__anim = anim;

async function boot() {
  ui = await import('./ui.js');
  await loadRenderer();
  // Warm the canvas and GPU paths each act first uses (dashes, clips, shadows),
  // so a seek into a later act never stalls on its first frame.
  for (const w of [6, 15, 22.5, 36, 42, 51, 57, 63, 69, 74]) draw(w);
  draw(t);
  window.addEventListener('resize', () => { fit(); });
  try {
    const { mountTransport } = await import('./transport.js');
    mountTransport(stage, anim);
  } catch (e) {
    console.warn('transport.js unavailable:', e);
  }
  document.documentElement.dataset.ready = '1';
  resolveReady(rendererMode);
  requestAnimationFrame(tick);
}

boot().catch((e) => { console.error('Film failed to start:', e); rejectReady(e); });
