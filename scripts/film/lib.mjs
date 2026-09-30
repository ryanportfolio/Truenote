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
    const [k, inline] = a.slice(2).split('=');
    if (inline !== undefined) out[k] = inline;
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

// Wait until the page exposes a usable window.__anim.
export async function waitForAnim(page, timeoutMs = 30000) {
  await page.waitForFunction(
    () => window.__anim && typeof window.__anim.renderAt === 'function' && typeof window.__anim.seek === 'function' && window.__anim.duration > 0,
    null,
    { timeout: timeoutMs },
  ).catch(() => { throw new Error('page did not expose a complete window.__anim within ' + timeoutMs + ' ms (needs seek, renderAt, duration)'); });
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

export const fmtSec = (s) => `${s.toFixed(1)}s`;
