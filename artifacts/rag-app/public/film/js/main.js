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
let ui = null;
let t = Math.max(0, Math.min(DURATION, Number(params.get('t')) || 0));
let playing = !params.has('paused');
let rate = 1;
let last = null;
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

async function loadRenderer() {
  if (!params.has('debug2d')) {
    try {
      const m = await import('./render.js');
      renderer = m.createRenderer(glCanvas, { preserveDrawingBuffer: params.has('export') });
      return;
    } catch (e) {
      console.warn('render.js unavailable, using the 2D debug renderer:', e);
      replaceCanvas();
    }
  }
  const m = await import('./debug2d.js');
  renderer = m.createDebugRenderer(glCanvas);
}

function sizeTo(w, h) {
  if (w === pixelW && h === pixelH) return;
  pixelW = w; pixelH = h;
  renderer.resize(w, h);
  uiCanvas.width = w; uiCanvas.height = h;
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
}

function tick(now) {
  if (last !== null && playing) {
    const dt = Math.min(0.1, (now - last) / 1000);
    t += dt * rate;
    if (t >= DURATION) { t = DURATION; playing = false; emit(); }
  }
  last = now;
  if (!exportMode) draw(t);
  requestAnimationFrame(tick);
}

function emit() { for (const f of listeners) f(); }

const anim = {
  seek(x) { t = Math.max(0, Math.min(DURATION, Number(x) || 0)); draw(t); emit(); },
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
    draw(time);
    const c = composite.getContext('2d');
    c.drawImage(glCanvas, 0, 0, 1920, 1080);
    c.drawImage(uiCanvas, 0, 0, 1920, 1080);
    return composite;
  },
  endExport() { exportMode = false; pixelW = 0; fit(); draw(t); },
};
window.__anim = anim;

async function boot() {
  try { ui = await import('./ui.js'); } catch (e) { console.warn('ui.js unavailable:', e); }
  await loadRenderer();
  fit();
  window.addEventListener('resize', fit);
  draw(t);
  try {
    const { mountTransport } = await import('./transport.js');
    mountTransport(stage, anim);
  } catch (e) {
    console.warn('transport.js unavailable:', e);
  }
  document.documentElement.dataset.ready = '1';
  requestAnimationFrame(tick);
}

boot();
