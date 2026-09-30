// Shared helpers for the film tools: argument parsing, Playwright lookup, offscreen headed Chrome.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `--key value` and `--flag`. Numbers stay strings; callers convert.
export function parseArgs(argv, booleans = []) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq); // split at the first '=' only: URLs carry their own
    if (eq >= 0) out[k] = a.slice(eq + 1);
    else if (booleans.includes(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) out[k] = true;
    else out[k] = argv[++i];
  }
  return out;
}

// Playwright lives in .tmp/film-tools (gitignored). Try that first, then env override, cwd, and global.
export async function loadChromium() {
  const dirs = [process.env.FILM_TOOLS, resolve(repoRoot, '.tmp/film-tools'), process.cwd()].filter(Boolean);
  for (const dir of dirs) {
    if (!existsSync(resolve(dir, 'node_modules'))) continue;
    const req = createRequire(resolve(dir, 'noop.js'));
    for (const pkg of ['playwright', 'playwright-core']) {
      try {
        const m = await import(pathToFileURL(req.resolve(pkg)).href);
        const c = m.chromium ?? m.default?.chromium;
        if (c) return c;
      } catch { /* try next */ }
    }
  }
  for (const pkg of ['playwright', 'playwright-core']) {
    try { const m = await import(pkg); const c = m.chromium ?? m.default?.chromium; if (c) return c; } catch { /* next */ }
  }
  throw new Error('playwright not found. Expected .tmp/film-tools/node_modules (or set FILM_TOOLS=<dir with node_modules>).');
}

// Headed Chrome, never headless (WebGL timing), parked offscreen, throttling off.
export async function launchChrome({ place = process.env.CHROME_PLACE || 'offscreen' } = {}) {
  const chromium = await loadChromium();
  const args = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
  ];
  if (place === 'offscreen') args.unshift('--window-position=-2400,-2400');
  try {
    return await chromium.launch({ headless: false, channel: 'chrome', args });
  } catch (e) {
    console.warn(`system Chrome failed (${String(e.message).split('\n')[0]}); falling back to bundled Chromium`);
    return chromium.launch({ headless: false, args });
  }
}

// Wait for boot to finish, then insist on a real renderer.
//   1. window.__anim exists (it appears before async boot completes)
//   2. await __anim.ready (resolves once renderer, UI and transport are initialised; rejects on boot failure)
//   3. the full API is present
//   4. __anim.renderer === 'webgl2', unless the URL contains 'debug2d' (deliberate debug renderer)
export async function waitForAnim(page, { url = '', timeoutMs = 30000 } = {}) {
  await page.waitForFunction(() => !!window.__anim, null, { timeout: timeoutMs })
    .catch(() => { throw new Error('page did not expose window.__anim within ' + timeoutMs + ' ms'); });
  const boot = await page.evaluate(async (ms) => {
    const a = window.__anim;
    if (a.ready && typeof a.ready.then === 'function') {
      let timer;
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__anim.ready did not settle within ' + ms + ' ms')), ms); });
      try { await Promise.race([a.ready, timeout]); } catch (e) { return { error: String((e && e.message) || e) }; } finally { clearTimeout(timer); }
    }
    return { renderer: window.__anim.renderer ?? null, hasReady: !!a.ready };
  }, timeoutMs);
  if (boot.error) throw new Error('page boot failed: ' + boot.error);
  const missing = await page.evaluate(() => ['seek', 'renderAt', 'captions'].filter((k) => typeof window.__anim[k] !== 'function')
    .concat(window.__anim.duration > 0 ? [] : ['duration']));
  if (missing.length) throw new Error('window.__anim is incomplete, missing: ' + missing.join(', '));
  if (boot.renderer !== 'webgl2' && !/debug2d/.test(url)) {
    throw new Error(`degraded rendering: __anim.renderer is ${JSON.stringify(boot.renderer)}, expected 'webgl2'. ` +
      `Frames from a fallback renderer are not the film. (Add 'debug2d' to the URL only to test the debug renderer.)`);
  }
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return boot;
}

export const fmtSec = (s) => `${s.toFixed(1)}s`;
