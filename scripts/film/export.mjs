// Export the film to MP4 in headed Chrome (parked offscreen) with WebCodecs H.264, then mux with ffmpeg.
//
//   node scripts/film/export.mjs --url <url> --out <file.mp4> [--fps 60] [--from 0 --to 77]
//        [--width 1920 --height 1080] [--bitrate 24] [--keep-raw]
//
// The page must expose window.__anim.renderAt(t) returning the composited canvas (see docs/promo-film.md).
// Frames are encoded in the page and streamed to Node as Annex B H.264; ffmpeg copies them into an MP4
// (no re-encode), faststart, tagged BT.709 primaries and matrix with an sRGB transfer.
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { launchChrome, parseArgs, waitForAnim } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), ['keep-raw']);
if (!args.url || !args.out) {
  console.error('usage: node scripts/film/export.mjs --url <url> --out <file.mp4> [--fps 60] [--from 0 --to 77] [--width 1920 --height 1080] [--bitrate 24] [--keep-raw]');
  process.exit(2);
}
const fps = Number(args.fps ?? 60);
const width = Number(args.width ?? 1920);
const height = Number(args.height ?? 1080);
const bitrateMbps = Number(args.bitrate ?? 24);
const out = resolve(args.out);
const rawPath = out.replace(/\.mp4$/i, '') + '.h264';
if (!(Number.isFinite(fps) && fps > 0) || !(Number.isInteger(width) && width > 0) || !(Number.isInteger(height) && height > 0) || width % 2 || height % 2 || !(Number.isFinite(bitrateMbps) && bitrateMbps > 0)) {
  console.error('fps and bitrate must be finite and > 0, width/height must be positive even integers'); process.exit(2);
}
const fromArg = args.from !== undefined ? Number(args.from) : undefined;
const toArg = args.to !== undefined ? Number(args.to) : undefined;
if ((fromArg !== undefined && !Number.isFinite(fromArg)) || (toArg !== undefined && !Number.isFinite(toArg))) {
  console.error(`--from and --to must be finite numbers of seconds (got from=${args.from}, to=${args.to})`); process.exit(2);
}

const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
for (const bin of [ffmpeg, ffprobe]) {
  if (spawnSync(bin, ['-version']).status !== 0) { console.error(`${bin} not found on PATH (set FFMPEG / FFPROBE to override)`); process.exit(1); }
}

let raw = null;
let streamErr = null;
let rawBytes = 0;
let lastProgress = 0;
const started = Date.now();

// Write with backpressure. Rejects on stream error or close instead of waiting for a 'drain' that never comes.
function writeRaw(buf) {
  if (streamErr) return Promise.reject(streamErr);
  if (raw.write(buf)) return Promise.resolve();
  return new Promise((res, rej) => {
    const done = (fn, v) => { raw.off('drain', onDrain); raw.off('error', onErr); raw.off('close', onClose); fn(v); };
    const onDrain = () => done(res);
    const onErr = (e) => done(rej, e);
    const onClose = () => done(rej, streamErr || new Error('raw output stream closed early'));
    raw.on('drain', onDrain); raw.on('error', onErr); raw.on('close', onClose);
  });
}

let browser = null;
let exitCode = 0;
try {
  mkdirSync(dirname(out), { recursive: true });
  raw = createWriteStream(rawPath);
  raw.on('error', (e) => { streamErr = e; });
  browser = await launchChrome();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text()); });

  await page.exposeFunction('__filmChunk', (b64) => {
    const buf = Buffer.from(b64, 'base64');
    rawBytes += buf.length;
    return writeRaw(buf);
  });
  await page.exposeFunction('__filmProgress', (done, total) => {
    const now = Date.now();
    if (done !== total && now - lastProgress < 1000) return;
    lastProgress = now;
    const el = (now - started) / 1000;
    const rate = done / el;
    console.log(`  frame ${done}/${total} (${((done / total) * 100).toFixed(0)}%)  ${rate.toFixed(0)} fps encode  ${(rawBytes / 1e6).toFixed(1)} MB`);
  });

  await page.goto(args.url, { waitUntil: 'load' });
  await waitForAnim(page, { url: args.url });

  const info = await page.evaluate(async (o) => {
    const anim = window.__anim;
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error('WebCodecs (VideoEncoder/VideoFrame) is not available in this browser');
    }
    anim.pause();
    const from = o.from ?? 0;
    const to = o.to ?? anim.duration;
    if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && from < to && to <= anim.duration + 1e-9)) {
      throw new Error(`invalid range: need 0 <= from < to <= duration (${anim.duration}), got from=${from}, to=${to}`);
    }
    const total = Math.max(1, Math.round((to - from) * o.fps));
    const frameDur = Math.round(1e6 / o.fps);

    // Find an H.264 config this Chrome can encode.
    const base = { width: o.width, height: o.height, bitrate: Math.round(o.bitrateMbps * 1e6), framerate: o.fps, latencyMode: 'quality', avc: { format: 'annexb' } };
    let config = null;
    const tried = [];
    for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.640028', 'avc1.42003e']) {
      const c = { ...base, codec };
      const s = await VideoEncoder.isConfigSupported(c).catch(() => ({ supported: false }));
      tried.push(`${codec}:${s.supported ? 'yes' : 'no'}`);
      if (s.supported) { config = c; break; }
    }
    if (!config) throw new Error('H.264 encoding is not supported by this Chrome (tried ' + tried.join(', ') + ')');

    // Same-size frames go straight to VideoFrame; otherwise scale through a 2D canvas.
    let scratch = null, sctx = null;
    const source = (cv) => {
      if (cv.width === o.width && cv.height === o.height) return cv;
      if (!scratch) { scratch = document.createElement('canvas'); scratch.width = o.width; scratch.height = o.height; sctx = scratch.getContext('2d'); sctx.imageSmoothingQuality = 'high'; }
      sctx.drawImage(cv, 0, 0, o.width, o.height);
      return scratch;
    };

    const toB64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    let batch = [], batchBytes = 0, chunks = 0, keyframes = 0, err = null;
    const pendingSends = [];
    const flushBatch = () => {
      if (!batch.length) return;
      const all = new Uint8Array(batchBytes);
      let p = 0;
      for (const b of batch) { all.set(b, p); p += b.length; }
      batch = []; batchBytes = 0;
      pendingSends.push(window.__filmChunk(toB64(all)));
    };
    const encoder = new VideoEncoder({
      output: (chunk) => {
        const u8 = new Uint8Array(chunk.byteLength);
        chunk.copyTo(u8);
        chunks++;
        if (chunk.type === 'key') keyframes++;
        batch.push(u8); batchBytes += u8.length;
        if (batchBytes > 2e6) flushBatch();
      },
      error: (e) => { err = e; },
    });
    encoder.configure(config);

    const t0 = performance.now();
    try {
      await document.fonts?.ready;
      anim.renderAt(from); // warm up shaders and glyph caches
      const gop = Math.max(1, Math.round(o.fps * 2));
      for (let f = 0; f < total; f++) {
        if (err) throw err;
        const canvas = anim.renderAt(from + f / o.fps);
        const frame = new VideoFrame(source(canvas), { timestamp: Math.round((f * 1e6) / o.fps), duration: frameDur });
        encoder.encode(frame, { keyFrame: f % gop === 0 });
        frame.close();
        if (encoder.encodeQueueSize > 6) await new Promise((r) => encoder.addEventListener('dequeue', r, { once: true }));
        if (f % 30 === 29) { await Promise.all(pendingSends.splice(0)); window.__filmProgress(f + 1, total); await new Promise((r) => setTimeout(r, 0)); }
      }
      await encoder.flush();
      if (err) throw err;
      flushBatch();
      await Promise.all(pendingSends.splice(0));
      window.__filmProgress(total, total);
    } finally {
      try { encoder.close(); } catch { /* already closed */ }
    }
    return { codec: config.codec, total, chunks, keyframes, from, to, ms: performance.now() - t0 };
  }, { from: fromArg, to: toArg, fps, width, height, bitrateMbps });

  console.log(`encoded ${info.total} frames (${info.chunks} chunks, ${info.keyframes} keyframes) with ${info.codec} in ${(info.ms / 1000).toFixed(1)} s = ${(info.total / (info.ms / 1000)).toFixed(0)} fps, ${((info.to - info.from) / (info.ms / 1000)).toFixed(2)}x realtime`);
  if (info.chunks !== info.total) throw new Error(`encoder emitted ${info.chunks} chunks for ${info.total} frames`);
} catch (e) {
  console.error('EXPORT FAILED:', e.message);
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (raw) {
    raw.end();
    await finished(raw).catch((e) => { streamErr ||= e; });
  }
  if (streamErr && !exitCode) { console.error('EXPORT FAILED: raw output write error:', streamErr.message); exitCode = 1; }
}
if (exitCode) { try { rmSync(rawPath, { force: true }); } catch { /* not ours to clean */ } process.exit(exitCode); }

// Mux: copy the stream, add faststart and colour tags. Chrome's H.264 has no colour VUI of its own.
const mux = spawnSync(ffmpeg, [
  '-v', 'error', '-y',
  '-f', 'h264', '-framerate', String(fps), '-i', rawPath,
  '-c', 'copy',
  '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1:video_full_range_flag=0',
  '-movflags', '+faststart',
  out,
], { encoding: 'utf8' });
if (mux.status !== 0) { console.error('ffmpeg mux failed:\n' + mux.stderr); process.exit(1); }
if (!args['keep-raw']) rmSync(rawPath, { force: true });

// Summary
const probe = spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
  'stream=codec_name,profile,level,width,height,pix_fmt,r_frame_rate,avg_frame_rate,nb_read_frames,duration,bit_rate,color_range,color_space,color_transfer,color_primaries',
  '-of', 'json', out], { encoding: 'utf8' });
const s = JSON.parse(probe.stdout).streams[0];
const size = statSync(out).size;
console.log(`\nwrote ${out} (${(size / 1e6).toFixed(1)} MB, ${((size * 8) / Number(s.duration) / 1e6).toFixed(1)} Mbit/s)`);
console.log(`  codec ${s.codec_name} ${s.profile} level ${s.level}, ${s.width}x${s.height} ${s.pix_fmt}`);
console.log(`  fps ${s.r_frame_rate} (avg ${s.avg_frame_rate}), frames ${s.nb_read_frames}, duration ${Number(s.duration).toFixed(3)} s`);
console.log(`  colour range=${s.color_range} matrix=${s.color_space} transfer=${s.color_transfer} primaries=${s.color_primaries}`);
