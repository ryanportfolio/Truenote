// One-command verification of the film page in headed Chrome (offscreen).
//
//   node scripts/film/check.mjs --url <url> [--name <run>] [--out <dir>] [--times 2,10,17.5]
//        [--sheet] [--fps 60] [--tol 2] [--frames 90] [--with-ui] [--width 1920 --height 1080] [--selector #stage]
//
// Checks: (a) ms/frame while playing, (b) stills of #stage, (c) seek robustness via renderAt (forward vs reverse
// vs after-jump-to-end), (d) caption reading budget, (e) console errors, (f) optional contact sheet.
// Exit code 1 when a caption, robustness or error check fails.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome, parseArgs, waitForAnim } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['sheet', 'with-ui']);
if (!args.url) {
  console.error('usage: node scripts/film/check.mjs --url <url> [--name <run>] [--out <dir>] [--times 2,10,17.5] [--sheet] [--fps 60] [--tol 2] [--frames 90] [--with-ui]');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const name = args.name || `run-${stamp}`;
const outDir = resolve(args.out || `D:/screenshots/truenote/film/${name}`);
const fps = Number(args.fps ?? 60);
const tol = Number(args.tol ?? 2);
const nFrames = Number(args.frames ?? 90);
const selector = args.selector || '#stage';
const vw = Number(args.width ?? 1920), vh = Number(args.height ?? 1080);
try { mkdirSync(outDir, { recursive: true }); } catch (e) {
  console.error(`cannot write ${outDir} (${e.message}). Pass --out to use another folder.`); process.exit(2);
}

const report = { url: args.url, outDir, checks: {} };
const failures = [];
const consoleErrors = [], consoleWarnings = [], pageErrors = [], failedRequests = [];

const browser = await launchChrome();
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  page.on('console', (m) => {
    if (/favicon\.ico/.test(m.location()?.url || '')) return;
    if (m.type() === 'error') consoleErrors.push(m.text());
    else if (m.type() === 'warning') consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e.stack || e.message || e)));
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} (${r.failure()?.errorText})`));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon\.ico/.test(r.url())) failedRequests.push(`${r.status()} ${r.url()}`); });

  await page.goto(args.url, { waitUntil: 'load' });
  await waitForAnim(page, { url: args.url });
  await page.waitForTimeout(500);

  const meta = await page.evaluate(() => ({
    duration: window.__anim.duration,
    chapters: window.__anim.chapters,
    captions: typeof window.__anim.captions === 'function' ? window.__anim.captions() : null,
    canvas: (() => { const c = window.__anim.renderAt(0); return { w: c.width, h: c.height }; })(),
  }));
  console.log(`page ok: ${meta.duration}s, ${meta.chapters.length} chapters, canvas ${meta.canvas.w}x${meta.canvas.h}`);

  // ---- (a) ms/frame while playing, plus renderAt cost with a forced GPU sync
  await page.evaluate(() => { window.__anim.seek(0); window.__anim.play(); });
  const play = await page.evaluate((n) => new Promise((resolveP) => {
    const dts = []; let prev = performance.now(), i = 0;
    const step = (now) => { dts.push(now - prev); prev = now; if (++i < n) requestAnimationFrame(step); else resolveP(dts); };
    requestAnimationFrame(step);
  }), nFrames);
  const advanced = await page.evaluate(() => window.__anim.t);
  await page.evaluate(() => window.__anim.pause());
  {
    const dts = play.slice(1).sort((a, b) => a - b);
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    const p95 = dts[Math.floor(dts.length * 0.95)];
    const over = dts.filter((d) => d > 20).length;
    const renderCost = await page.evaluate((n) => {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const x = c.getContext('2d', { willReadFrequently: true });
      const d = window.__anim.duration, ts = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const src = window.__anim.renderAt((i / n) * d);
        x.drawImage(src, 0, 0, 1, 1); x.getImageData(0, 0, 1, 1); // forces the GPU to finish
        ts.push(performance.now() - t0);
      }
      ts.sort((a, b) => a - b);
      return { mean: ts.reduce((a, b) => a + b, 0) / n, p95: ts[Math.floor(n * 0.95)], max: ts[n - 1] };
    }, nFrames);
    report.checks.playback = { rafMeanMs: mean, rafP95Ms: p95, rafMaxMs: dts[dts.length - 1], framesOver20ms: over, clockAdvancedTo: advanced, renderAt: renderCost };
    console.log(`(a) playing: rAF ${mean.toFixed(1)} ms/frame mean, p95 ${p95.toFixed(1)}, max ${dts[dts.length - 1].toFixed(1)}, ${over}/${dts.length} over 20 ms; clock advanced to ${advanced.toFixed(2)}s`);
    console.log(`    renderAt (GPU-synced): mean ${renderCost.mean.toFixed(1)} ms, p95 ${renderCost.p95.toFixed(1)}, max ${renderCost.max.toFixed(1)}`);
    if (!(advanced > 0.5)) { failures.push('playback: clock did not advance while playing'); console.log('    FAIL clock did not advance'); }
  }

  // ---- times
  let times;
  if (args.times) times = String(args.times).split(',').map(Number).filter((x) => Number.isFinite(x));
  else {
    const set = new Set();
    for (const c of meta.chapters) { set.add(+(c.t0 + 0.5).toFixed(2)); set.add(+((c.t0 + c.t1) / 2).toFixed(2)); }
    times = [...set].filter((t) => t >= 0 && t <= meta.duration).sort((a, b) => a - b);
  }

  // ---- (b) stills
  if (!args['with-ui']) await page.addStyleTag({ content: '.ftp{display:none!important}' });
  await page.evaluate(() => window.__anim.pause());
  const stills = [];
  for (const t of times) {
    await page.evaluate((x) => window.__anim.seek(x), t);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(150);
    const file = resolve(outDir, `t${t.toFixed(2).padStart(6, '0')}.png`);
    await page.locator(selector).screenshot({ path: file });
    stills.push({ t, file });
  }
  report.checks.stills = stills;
  console.log(`(b) ${stills.length} stills -> ${outDir}`);

  // ---- (c) seek robustness via renderAt
  const rob = await page.evaluate((list) => {
    const anim = window.__anim;
    const scratch = document.createElement('canvas');
    const sx = scratch.getContext('2d', { willReadFrequently: true });
    const grab = (t) => {
      const c = anim.renderAt(t);
      scratch.width = c.width; scratch.height = c.height;
      sx.drawImage(c, 0, 0);
      return sx.getImageData(0, 0, c.width, c.height).data;
    };
    const diff = (a, b) => {
      let max = 0, sum = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; sum += d; }
      return { max, mean: sum / a.length };
    };
    const ref = new Map();
    for (const t of list) ref.set(t, grab(t));                  // forward
    const rows = list.map((t) => ({ t }));
    const rev = [...list].reverse();
    for (const t of rev) rows.find((r) => r.t === t).reverse = diff(ref.get(t), grab(t));
    for (const t of list) {                                     // jump to the end, then back
      grab(Math.max(0, anim.duration - 0.01));
      rows.find((r) => r.t === t).afterEnd = diff(ref.get(t), grab(t));
    }
    return rows;
  }, times);
  report.checks.robustness = { tol, rows: rob };
  let robFail = 0;
  console.log(`(c) seek robustness (max / mean abs channel diff vs forward pass, tol ${tol}):`);
  for (const r of rob) {
    const bad = r.reverse.max > tol || r.afterEnd.max > tol;
    if (bad) robFail++;
    console.log(`    t=${String(r.t).padStart(6)}  reverse ${r.reverse.max}/${r.reverse.mean.toFixed(4)}  after-end ${r.afterEnd.max}/${r.afterEnd.mean.toFixed(4)}  ${bad ? 'FAIL' : 'ok'}`);
  }
  if (robFail) failures.push(`seek robustness: ${robFail} of ${rob.length} times differ beyond tol ${tol}`);

  // ---- (d) caption reading budget
  if (!meta.captions) {
    failures.push('captions(): not exposed by window.__anim');
    console.log('(d) FAIL window.__anim.captions is not a function');
  } else {
    const minFrames = 20;
    const rows = meta.captions.map((c) => {
      const words = c.text.trim().split(/\s+/).filter(Boolean).length;
      const visible = c.t1 - c.t0;
      const need = Math.max(0.25 * words + 1, minFrames / fps);
      return { text: c.text, t0: c.t0, t1: c.t1, words, visible, need, frames: Math.round(visible * fps), ok: visible + 1e-9 >= need };
    });
    report.checks.captions = rows;
    const bad = rows.filter((r) => !r.ok);
    console.log(`(d) captions: ${rows.length - bad.length}/${rows.length} within budget (250 ms/word + 1 s, min ${minFrames} frames at ${fps} fps)`);
    for (const r of bad) {
      console.log(`    FAIL "${r.text.slice(0, 60)}" ${r.t0}-${r.t1}s: ${r.visible.toFixed(2)} s visible, needs ${r.need.toFixed(2)} s (${r.words} words)`);
    }
    if (bad.length) failures.push(`captions: ${bad.length} below reading budget`);
  }

  // ---- (f) contact sheet
  if (args.sheet) {
    const cols = Math.min(4, stills.length);
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#21201c;font:13px Verdana,sans-serif;color:#fdfdfc}
      .g{display:grid;grid-template-columns:repeat(${cols},480px);gap:6px;padding:6px;width:max-content}
      figure{margin:0;position:relative}img{display:block;width:480px;height:auto;aspect-ratio:16/9;background:#000}
      figcaption{position:absolute;left:6px;bottom:6px;padding:3px 9px;border-radius:9999px;background:rgba(33,32,28,.85)}
      </style><div class="g">${stills.map((s) => {
        const c = [...meta.chapters].reverse().find((k) => s.t >= k.t0);
        return `<figure><img src="${pathToFileURL(s.file).href}"><figcaption>${s.t.toFixed(1)}s${c ? ' · ' + c.name.replace(/[<>&]/g, '') : ''}</figcaption></figure>`;
      }).join('')}</div>`;
    const sheetHtml = resolve(outDir, '_sheet.html');
    writeFileSync(sheetHtml, html);
    const sp = await browser.newPage({ viewport: { width: cols * 486 + 6, height: 600 } });
    await sp.goto(pathToFileURL(sheetHtml).href);
    await sp.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
    const sheet = resolve(outDir, 'sheet.png');
    await sp.screenshot({ path: sheet, fullPage: true });
    await sp.close();
    rmSync(sheetHtml, { force: true });
    report.checks.sheet = sheet;
    console.log(`(f) contact sheet -> ${sheet}`);
  }

  // ---- (e) console
  report.checks.console = { errors: consoleErrors, pageErrors, failedRequests, warnings: consoleWarnings };
  console.log(`(e) console: ${consoleErrors.length} errors, ${pageErrors.length} pageerrors, ${failedRequests.length} failed requests, ${consoleWarnings.length} warnings`);
  for (const m of [...consoleErrors, ...pageErrors, ...failedRequests]) console.log('    ' + m.split('\n')[0]);
  if (consoleWarnings.length) for (const w of consoleWarnings.slice(0, 5)) console.log('    warn: ' + w.split('\n')[0]);
  if (consoleErrors.length || pageErrors.length || failedRequests.length) failures.push('console: errors or failed requests');
} catch (e) {
  console.error('CHECK CRASHED:', e.message);
  failures.push('crash: ' + e.message);
} finally {
  await browser.close().catch(() => {});
}

report.failures = failures;
try { writeFileSync(resolve(outDir, 'report.json'), JSON.stringify(report, null, 2)); } catch { /* ignore */ }
if (failures.length) { console.log('\nFAIL:\n  ' + failures.join('\n  ')); exitCode = 1; } else console.log('\nPASS');
process.exit(exitCode);
