// One-command verification of the film page in headed Chrome (offscreen).
//
//   node scripts/film/check.mjs --url <url> [--name <run>] [--out <dir>] [--times 2,10,17.5]
//        [--sheet] [--fps 60] [--tol 2] [--frames 90] [--with-ui] [--width 1920 --height 1080] [--selector #stage]
//        [--reduce] [--dip-check [--dip-windows 22.2-23.7,46.4-47.4,58.1-59.1,66.7-67.7] [--dip-max 10]]
//        [--gl-canvas #gl] [--ui-canvas #ui]
//
// Checks: (a) ms/frame while playing, (b) stills of #stage, (c) seek robustness via renderAt (forward vs reverse
// vs after-jump-to-end; a failing time is rerun once for diagnosis, but any failed attempt fails the check, with the forward frame,
// the failing frame, a diff PNG, the diff bbox and a per-layer (GL / UI) split written to --out),
// (d) caption reading budget, (e) console errors, (f) optional contact sheet.
// --reduce loads the page with ?motion=reduce.
// --dip-check is a mode: it runs only the one-frame luma-jump check (renderAt at 1/fps through each window; fails
// when a composite mean-luma jump between adjacent frames is >= --dip-max levels) plus the console check.
// Exit code 1 when a caption, robustness, dip or error check fails.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChrome, parseArgs, repoRoot, waitForAnim } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['sheet', 'with-ui', 'reduce', 'dip-check']);
if (!args.url) {
  console.error('usage: node scripts/film/check.mjs --url <url> [--name <run>] [--out <dir>] [--times 2,10,17.5] [--sheet] [--fps 60] [--tol 2] [--frames 90] [--with-ui] [--reduce] [--dip-check]');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const name = args.name || `run-${stamp}`;
const outDir = resolve(args.out || resolve(repoRoot, `.tmp/film/${name}`));
const fps = Number(args.fps ?? 60);
const tol = Number(args.tol ?? 2);
const nFrames = Number(args.frames ?? 90);
const selector = args.selector || '#stage';
const vw = Number(args.width ?? 1920), vh = Number(args.height ?? 1080);
try { mkdirSync(outDir, { recursive: true }); } catch (e) {
  console.error(`cannot write ${outDir} (${e.message}). Pass --out to use another folder.`); process.exit(2);
}

let pageUrl = args.url;
if (args.reduce) { const u = new URL(args.url); u.searchParams.set('motion', 'reduce'); pageUrl = u.href; }
const dipOnly = !!args['dip-check'];
const glSel = args['gl-canvas'] || '#gl', uiSel = args['ui-canvas'] || '#ui';
const report = { url: pageUrl, outDir, reduce: !!args.reduce, checks: {} };
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

  await page.goto(pageUrl, { waitUntil: 'load' });
  await waitForAnim(page, { url: pageUrl });
  await page.waitForTimeout(500);

  const meta = await page.evaluate(() => ({
    duration: window.__anim.duration,
    chapters: window.__anim.chapters,
    captions: typeof window.__anim.captions === 'function' ? window.__anim.captions() : null,
    canvas: (() => { const c = window.__anim.renderAt(0); return { w: c.width, h: c.height }; })(),
  }));
  console.log(`page ok: ${pageUrl} ${meta.duration}s, ${meta.chapters.length} chapters, canvas ${meta.canvas.w}x${meta.canvas.h}`);

  if (dipOnly) {
    // ---- dip check: one-frame composite mean-luma jumps through each window (renderAt at 1/fps)
    const wins = String(args['dip-windows'] || '22.2-23.7,46.4-47.4,58.1-59.1,66.7-67.7').split(',').map((w) => w.split('-').map(Number));
    if (wins.some((w) => w.length !== 2 || !w.every(Number.isFinite) || w[0] >= w[1])) throw new Error('bad --dip-windows, expected a-b,c-d');
    const dipMax = Number(args['dip-max'] ?? 10);
    const dip = await page.evaluate(({ wins, fps, dipMax }) => {
      const anim = window.__anim;
      const s = document.createElement('canvas'); s.width = 192; s.height = 108;
      const x = s.getContext('2d', { willReadFrequently: true });
      const luma = (t) => {
        x.drawImage(anim.renderAt(t), 0, 0, 192, 108);
        const d = x.getImageData(0, 0, 192, 108).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (192 * 108);
      };
      return wins.map(([a, b]) => {
        const rows = [];
        for (let f = Math.round(a * fps); f <= Math.round(b * fps); f++) rows.push([f / fps, luma(f / fps)]);
        let worst = { d: 0, from: rows[0], to: rows[0] };
        for (let i = 1; i < rows.length; i++) {
          const d = Math.abs(rows[i][1] - rows[i - 1][1]);
          if (d > worst.d) worst = { d, from: rows[i - 1], to: rows[i] };
        }
        const res = { a, b, min: Math.min(...rows.map((r) => r[1])), max: Math.max(...rows.map((r) => r[1])), worst, fail: worst.d >= dipMax, rows };
        if (res.fail) res.png = { before: anim.renderAt(worst.from[0]).toDataURL('image/png'), after: anim.renderAt(worst.to[0]).toDataURL('image/png') };
        return res;
      });
    }, { wins, fps, dipMax });
    console.log(`dip check: one-frame composite mean-luma jump must stay under ${dipMax} levels (renderAt at 1/${fps} s)`);
    for (const w of dip) {
      console.log(`    ${w.a}-${w.b}s: luma ${w.min.toFixed(1)}..${w.max.toFixed(1)}, max one-frame jump ${w.worst.d.toFixed(1)} (${w.worst.from[0].toFixed(3)}s ${w.worst.from[1].toFixed(1)} -> ${w.worst.to[0].toFixed(3)}s ${w.worst.to[1].toFixed(1)})  ${w.fail ? 'FAIL' : 'ok'}`);
      if (w.fail) {
        failures.push(`dip: ${w.a}-${w.b}s one-frame luma jump ${w.worst.d.toFixed(1)} >= ${dipMax} at ${w.worst.to[0].toFixed(3)}s`);
        for (const k of ['before', 'after']) {
          const file = resolve(outDir, `dip-${w.a}-${w.b}-${k}.png`);
          writeFileSync(file, Buffer.from(w.png[k].split(',')[1], 'base64'));
          console.log(`        ${file}`);
        }
      }
      delete w.png;
    }
    report.checks.dip = { max: dipMax, fps, windows: dip.map(({ rows, ...w }) => w) };
    writeFileSync(resolve(outDir, 'dip.json'), JSON.stringify({ max: dipMax, fps, windows: dip }, null, 1));
  }

  if (!dipOnly) {

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
  // Hide the transport with CSSOM writes (an injected <style> would be blocked by the production CSP).
  if (!args['with-ui']) await page.evaluate(() => document.querySelectorAll('.ftp').forEach((e) => { e.style.display = 'none'; }));
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

  // ---- (c) seek robustness via renderAt. Compares forward vs reverse vs after-jump-to-end frames. A failing time
  // is localised (composite, GL layer, UI layer: PNGs and diff bbox go to --out), then rerun once for diagnosis.
  // Any failed attempt fails the check (contract E1), even if the rerun passes. Both attempts are logged.
  await page.evaluate(({ glSel, uiSel }) => {
    const anim = window.__anim;
    const scratch = document.createElement('canvas');
    const sx = scratch.getContext('2d', { willReadFrequently: true });
    const read = (src, w, h) => {
      if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
      sx.clearRect(0, 0, w, h); sx.drawImage(src, 0, 0, w, h);
      return sx.getImageData(0, 0, w, h);
    };
    // Layers are read in the same task as renderAt, before the GL drawing buffer can be presented and cleared.
    const grab = (t, layers) => {
      const c = anim.renderAt(t); const w = c.width, h = c.height;
      const g = { w, h, full: read(c, w, h) };
      if (layers) {
        const gl = document.querySelector(glSel), ui = document.querySelector(uiSel);
        if (gl) g.gl = read(gl, w, h);
        if (ui) g.ui = read(ui, w, h);
      }
      return g;
    };
    const diff = (a, b, tol) => {
      const A = a.data, B = b.data, w = a.width;
      let max = 0, sum = 0, count = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let p = 0; p < A.length; p += 4) {
        const d0 = Math.abs(A[p] - B[p]), d1 = Math.abs(A[p + 1] - B[p + 1]), d2 = Math.abs(A[p + 2] - B[p + 2]), d3 = Math.abs(A[p + 3] - B[p + 3]);
        sum += d0 + d1 + d2 + d3;
        const d = Math.max(d0, d1, d2, d3);
        if (d > max) max = d;
        if (d > tol) {
          count++;
          const i = p >> 2, x = i % w, y = (i / w) | 0;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      return { max, mean: sum / A.length, count, bbox: count ? [x0, y0, x1, y1] : null };
    };
    const png = (img) => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      c.getContext('2d').putImageData(img, 0, 0);
      return c.toDataURL('image/png');
    };
    // Grey = 16x the diff, red = above tolerance, yellow box = bbox of the red pixels (a few pixels are invisible otherwise).
    const diffPng = (a, b, tol, bbox) => {
      const out = new ImageData(a.width, a.height), A = a.data, B = b.data, O = out.data, w = a.width;
      for (let p = 0; p < A.length; p += 4) {
        const d = Math.max(Math.abs(A[p] - B[p]), Math.abs(A[p + 1] - B[p + 1]), Math.abs(A[p + 2] - B[p + 2]), Math.abs(A[p + 3] - B[p + 3]));
        const g = Math.min(255, d * 16);
        if (d > tol) { O[p] = 255; O[p + 1] = 0; O[p + 2] = 0; } else { O[p] = O[p + 1] = O[p + 2] = g; }
        O[p + 3] = 255;
      }
      if (bbox) {
        const pad = 10, [bx0, by0, bx1, by1] = bbox;
        const set = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < a.height) { const p = (y * w + x) * 4; O[p] = 255; O[p + 1] = 220; O[p + 2] = 0; O[p + 3] = 255; } };
        for (let x = bx0 - pad; x <= bx1 + pad; x++) for (let k = 0; k < 2; k++) { set(x, by0 - pad + k); set(x, by1 + pad - k); }
        for (let y = by0 - pad; y <= by1 + pad; y++) for (let k = 0; k < 2; k++) { set(bx0 - pad + k, y); set(bx1 + pad - k, y); }
      }
      return png(out);
    };
    const layerReport = (ref, bad, tol, out) => {
      for (const L of ['gl', 'ui']) {
        if (!ref[L] || !bad[L]) continue;
        const ld = diff(ref[L], bad[L], tol);
        out.layers[L] = ld;
        out.png[L + 'Fail'] = png(bad[L]);
        out.png[L + 'Diff'] = diffPng(ref[L], bad[L], tol, ld.bbox);
      }
    };
    const fwd = new Map(), fails = [];
    const end = () => Math.max(0, anim.duration - 0.01);
    window.__chk = {
      forward(list) { for (const t of list) fwd.set(t, grab(t, false).full); },
      pass(kind, list, tol) {
        const rows = {};
        for (const t of kind === 'reverse' ? [...list].reverse() : list) {
          if (kind === 'afterEnd') grab(end(), false);
          const g = grab(t, true), d = diff(fwd.get(t), g.full, tol);
          rows[t] = d;
          if (d.max > tol) fails.push({ t, kind, bad: g, d });
        }
        return rows;
      },
      failed() { return fails.map((f) => ({ t: f.t, kind: f.kind })); },
      // Names the layer: a fresh render now is the per-layer reference when it matches the forward composite.
      capture(i, tol) {
        const f = fails[i], ref = fwd.get(f.t), good = grab(f.t, true);
        const goodMatches = diff(ref, good.full, tol).max <= tol;
        const out = { t: f.t, kind: f.kind, full: f.d, referenceMatchesForward: goodMatches, layers: {}, png: {} };
        out.png.forward = png(ref); out.png.fail = png(f.bad.full); out.png.diff = diffPng(ref, f.bad.full, tol, f.d.bbox);
        if (goodMatches) layerReport(good, f.bad, tol, out);
        return out;
      },
      // Fresh consistency check of one time: t, other, t (reverse-like), end, t (after-end).
      rerun(t, other, tol) {
        const a = grab(t, true);
        grab(other, false);
        const b = grab(t, true), rev = diff(a.full, b.full, tol);
        grab(end(), false);
        const c = grab(t, true), ae = diff(a.full, c.full, tol);
        const res = { reverse: rev, afterEnd: ae, ok: rev.max <= tol && ae.max <= tol, layers: {}, png: {} };
        if (!res.ok) {
          const bad = rev.max > tol ? b : c, d = rev.max > tol ? rev : ae;
          res.png.forward = png(a.full); res.png.fail = png(bad.full); res.png.diff = diffPng(a.full, bad.full, tol, d.bbox);
          layerReport(a, bad, tol, res);
        }
        return res;
      },
    };
  }, { glSel, uiSel });

  const savePngs = (prefix, pngs) => {
    const files = [];
    for (const [k, url] of Object.entries(pngs || {})) {
      const file = resolve(outDir, `${prefix}-${k}.png`);
      writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
      files.push(file);
    }
    return files;
  };
  const fmtD = (d) => `${d.max}/${d.mean.toFixed(4)}`;
  const fmtBox = (d) => (d.bbox ? `bbox [${d.bbox.join(',')}] ${d.count} px` : 'no px over tol');
  const layerLine = (layers) => Object.entries(layers).map(([k, d]) => `${k.toUpperCase()} max ${d.max} ${fmtBox(d)}`).join('; ') || 'layers not available';

  await page.evaluate((list) => window.__chk.forward(list), times);
  const revRows = await page.evaluate(({ list, tol }) => window.__chk.pass('reverse', list, tol), { list: times, tol });
  const aeRows = await page.evaluate(({ list, tol }) => window.__chk.pass('afterEnd', list, tol), { list: times, tol });
  const failed = await page.evaluate(() => window.__chk.failed());
  const captures = [];
  for (let i = 0; i < Math.min(failed.length, 6); i++) {
    const cap = await page.evaluate(({ i, tol }) => window.__chk.capture(i, tol), { i, tol });
    cap.files = savePngs(`robust-fail-t${String(cap.t).padStart(6, '0')}-${cap.kind}`, cap.png);
    delete cap.png;
    captures.push(cap);
  }
  const failTimes = [...new Set(failed.map((f) => f.t))];
  const reruns = new Map();
  for (const t of failTimes) {
    const other = times.find((x) => x !== t) ?? meta.duration / 2;
    const r = await page.evaluate(({ t, other, tol }) => window.__chk.rerun(t, other, tol), { t, other, tol });
    r.files = savePngs(`robust-rerun-fail-t${String(t).padStart(6, '0')}`, r.png);
    delete r.png;
    reruns.set(t, r);
  }
  const rows = times.map((t) => {
    const reverse = revRows[t], afterEnd = aeRows[t];
    const first = reverse.max <= tol && afterEnd.max <= tol;
    const rerun = reruns.get(t);
    const verdict = first ? 'ok' : rerun && rerun.ok ? 'flaky' : 'FAIL';
    return { t, reverse, afterEnd, verdict, rerun };
  });
  report.checks.robustness = { tol, rows, captures };
  console.log(`(c) seek robustness (max / mean abs channel diff vs forward pass, tol ${tol}):`);
  let robFail = 0, flaky = 0;
  for (const r of rows) {
    console.log(`    t=${String(r.t).padStart(6)}  reverse ${fmtD(r.reverse)}  after-end ${fmtD(r.afterEnd)}  ${r.verdict === 'ok' ? 'ok' : 'attempt 1 FAILED'}`);
    if (r.verdict === 'ok') continue;
    console.log(`        attempt 2 (fresh rerun of t=${r.t}): reverse ${fmtD(r.rerun.reverse)}  after-end ${fmtD(r.rerun.afterEnd)}  ${r.rerun.ok ? 'ok' : 'FAILED'}`);
    if (!r.rerun.ok) console.log(`        rerun layers: ${layerLine(r.rerun.layers)}`);
    if (r.verdict === 'flaky') { flaky++; console.log('        FLAKY: attempt 1 failed and the rerun passed. Still a failure (contract: every attempt within tol); the evidence above is for diagnosis.'); } else robFail++;
  }
  for (const c of captures) {
    console.log(`    capture t=${c.t} ${c.kind}: composite max ${c.full.max}, ${fmtBox(c.full)}; ${c.referenceMatchesForward ? layerLine(c.layers) : 'no clean reference render to split layers'}`);
    for (const f of c.files) console.log(`        ${f}`);
  }
  if (flaky) report.checks.robustness.flakyTimes = rows.filter((r) => r.verdict === 'flaky').map((r) => r.t);
  if (robFail || flaky) failures.push(`seek robustness: ${robFail + flaky} of ${rows.length} times had a failed attempt (${robFail} failed the rerun too, ${flaky} passed on rerun; any failed attempt fails the check; tol ${tol})`);


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

  } // end of full checks

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
