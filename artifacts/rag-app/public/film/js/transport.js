// Viewer controls for the film: play/pause/replay, scrubber with chapter ticks, time, keyboard.
// Pure DOM overlay on the stage. It is never drawn into the canvas, so MP4 export stays clean.
//
//   import { mountTransport } from './transport.js';
//   const tp = mountTransport(document.getElementById('stage'), window.__anim);
//
// `anim` needs: seek(t), play(), pause(), t, playing, duration, chapters [{ name, t0, t1 }].
// Returns { show, hide, destroy, el }.

const CSS = `
.ftp{position:absolute;inset:0;z-index:5;pointer-events:none;container-type:inline-size;
  font:400 13px/1.2 Verdana,Geneva,"DejaVu Sans",sans-serif;color:#FDFDFC;-webkit-font-smoothing:antialiased}
.ftp *,.ftp *::before,.ftp *::after{box-sizing:border-box}
.ftp-idle{cursor:none}
.ftp-scrim{position:absolute;left:0;right:0;bottom:0;height:132px;
  background:linear-gradient(to top,rgba(33,32,28,.80) 0,rgba(33,32,28,.64) 48%,rgba(33,32,28,0) 100%)}
.ftp-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:14px;padding:0 20px 16px}
.ftp-scrim,.ftp-bar{transition:opacity .22s cubic-bezier(.25,1,.5,1),transform .22s cubic-bezier(.25,1,.5,1)}
.ftp[data-hidden="true"] .ftp-scrim,.ftp[data-hidden="true"] .ftp-bar{opacity:0;transform:translateY(6px)}
.ftp[data-hidden="true"] .ftp-bar{pointer-events:none}
.ftp-bar{pointer-events:auto}

.ftp-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:none;
  height:36px;min-width:36px;padding:0 16px 0 12px;margin:0;border-radius:9999px;cursor:pointer;
  font:inherit;color:#FDFDFC;background:rgba(253,253,252,.14);border:1px solid rgba(253,253,252,.30);
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
  transition:background-color .15s ease,border-color .15s ease}
.ftp-btn:hover{background:rgba(253,253,252,.24);border-color:rgba(253,253,252,.5)}
.ftp-btn:active{background:rgba(253,253,252,.32)}
.ftp-btn svg{width:14px;height:14px;flex:none;display:block}
.ftp-btn:focus-visible,.ftp-track:focus-visible{outline:2px solid #FDFDFC;outline-offset:2px;box-shadow:0 0 0 2px #0040AB}
.ftp-btn:focus:not(:focus-visible),.ftp-track:focus:not(:focus-visible){outline:none}

.ftp-time{flex:none;display:flex;gap:6px;font-variant-numeric:tabular-nums;color:rgba(253,253,252,.85);white-space:nowrap}
.ftp-cur{color:#FDFDFC;min-width:4ch;text-align:right}

.ftp-scrub{position:relative;flex:1 1 auto;min-width:60px;height:36px}
.ftp-track{position:absolute;inset:0;border-radius:9999px;cursor:pointer;touch-action:none;outline-offset:2px}
.ftp-rail{position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;border-radius:9999px;overflow:hidden;
  background:rgba(253,253,252,.28);transition:height .12s ease,margin-top .12s ease}
.ftp-track:hover .ftp-rail,.ftp-track:focus-visible .ftp-rail,.ftp-track[data-drag="true"] .ftp-rail{height:6px;margin-top:-3px}
.ftp-fill{position:absolute;inset:0;background:#FDFDFC;transform-origin:0 50%;transform:scaleX(0)}
.ftp-tick{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:rgba(33,32,28,.85)}
.ftp-thumb{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:9999px;background:#FDFDFC;
  box-shadow:0 0 0 1px rgba(33,32,28,.35);opacity:0;transition:opacity .12s ease}
.ftp-track:hover .ftp-thumb,.ftp-track:focus-visible .ftp-thumb,.ftp-track[data-drag="true"] .ftp-thumb{opacity:1}
.ftp-tip{position:absolute;bottom:34px;left:0;display:flex;gap:8px;white-space:nowrap;pointer-events:none;
  padding:6px 12px;border-radius:9999px;background:rgba(33,32,28,.92);border:1px solid rgba(253,253,252,.22);
  opacity:0;transition:opacity .12s ease}
.ftp-tip[data-on="true"]{opacity:1}
.ftp-tip-time{color:rgba(253,253,252,.8);font-variant-numeric:tabular-nums}

.ftp-chap{flex:none;width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(253,253,252,.85);text-align:right}

@container (max-width:640px){.ftp-chap{display:none}.ftp-bar{gap:10px;padding:0 12px 12px}}
@container (max-width:420px){.ftp-btn{padding:0;width:36px}.ftp-btn-label{display:none}}
@media (prefers-reduced-motion:reduce){.ftp *,.ftp-scrim,.ftp-bar{transition:none!important}}
`;

const ICONS = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M4 2.4v11.2a.5.5 0 0 0 .77.42l8.4-5.6a.5.5 0 0 0 0-.84l-8.4-5.6A.5.5 0 0 0 4 2.4z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.5 2h3v12h-3zM9.5 2h3v12h-3z"/></svg>',
  replay: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9M2.6 2.6v2.9h2.9"/></svg>',
};

const fmt = (s) => {
  s = Math.max(0, Math.floor(s + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function injectCss() {
  if (document.querySelector('style[data-film-transport]')) return;
  const el = document.createElement('style');
  el.dataset.filmTransport = '';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function mountTransport(root, anim, { autoHideMs = 2200 } = {}) {
  injectCss();
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';

  const duration = anim.duration;
  const chapters = (anim.chapters || []).slice().sort((a, b) => a.t0 - b.t0);
  const chapterAt = (t) => {
    let hit = null;
    for (const c of chapters) if (t >= c.t0 - 1e-6) hit = c;
    return hit;
  };
  const chapterIndex = (c) => chapters.indexOf(c);

  const el = document.createElement('div');
  el.className = 'ftp';
  el.dataset.hidden = 'false';
  el.innerHTML = `
    <div class="ftp-scrim"></div>
    <div class="ftp-bar" role="group" aria-label="Film controls">
      <button type="button" class="ftp-btn ftp-play" aria-keyshortcuts="Space"></button>
      <div class="ftp-time" aria-hidden="true"><span class="ftp-cur">0:00</span><span>/</span><span class="ftp-tot"></span></div>
      <div class="ftp-scrub">
        <div class="ftp-track" role="slider" tabindex="0" aria-label="Film timeline" aria-orientation="horizontal"
             aria-valuemin="0" aria-valuemax="${Math.round(duration)}" aria-valuenow="0" aria-keyshortcuts="ArrowLeft ArrowRight Home End [ ]">
          <div class="ftp-rail"><div class="ftp-fill"></div></div>
          <div class="ftp-thumb"></div>
        </div>
        <div class="ftp-tip" aria-hidden="true"><span class="ftp-tip-name"></span><span class="ftp-tip-time"></span></div>
      </div>
      <div class="ftp-chap" aria-hidden="true"></div>
    </div>`;
  root.appendChild(el);

  const $ = (s) => el.querySelector(s);
  const bar = $('.ftp-bar'), playBtn = $('.ftp-play'), track = $('.ftp-track'), rail = $('.ftp-rail');
  const fill = $('.ftp-fill'), thumb = $('.ftp-thumb'), tip = $('.ftp-tip');
  const cur = $('.ftp-cur'), chapLabel = $('.ftp-chap');
  $('.ftp-tot').textContent = fmt(duration);
  for (const c of chapters) {
    if (c.t0 <= 0 || c.t0 >= duration) continue;
    const tick = document.createElement('i');
    tick.className = 'ftp-tick';
    tick.style.left = `${(c.t0 / duration) * 100}%`;
    rail.insertBefore(tick, null);
  }

  // ---- state helpers
  const isEnded = () => !anim.playing && anim.t >= duration - 0.02;
  const clamp = (t) => Math.min(duration, Math.max(0, t));

  // seek() may or may not keep the play state; keep it ourselves.
  function jump(t) {
    const was = anim.playing;
    t = clamp(t);
    anim.seek(t);
    if (was && !anim.playing && t < duration - 0.02) anim.play();
    lastT = -1;
  }
  function toggle() {
    if (isEnded()) { anim.seek(0); anim.play(); }
    else if (anim.playing) anim.pause();
    else anim.play();
  }
  function stepChapter(dir) {
    if (!chapters.length) return;
    const t = anim.t, c = chapterAt(t);
    if (dir < 0) {
      const restart = c && t - c.t0 > 1.5;
      const i = chapterIndex(c);
      jump(restart || i <= 0 ? (c ? c.t0 : 0) : chapters[i - 1].t0);
    } else {
      const next = chapters.find((x) => x.t0 > t + 1e-6);
      if (next) jump(next.t0);
    }
  }

  // ---- auto-hide
  let hideTimer = 0, hovering = false, dragging = false;
  const focusVisibleInside = () => { try { return !!bar.querySelector(':focus-visible'); } catch { return false; } };
  function setHidden(h) {
    el.dataset.hidden = h ? 'true' : 'false';
    root.classList.toggle('ftp-idle', h);
  }
  function show() {
    setHidden(false);
    clearTimeout(hideTimer);
    if (anim.playing && !hovering && !dragging && !focusVisibleInside()) {
      hideTimer = setTimeout(() => {
        if (anim.playing && !hovering && !dragging && !focusVisibleInside()) setHidden(true);
        else show();
      }, autoHideMs);
    }
  }
  function hide() { clearTimeout(hideTimer); setHidden(true); }

  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
  const cleanups = [];

  on(root, 'pointermove', (e) => { if (e.pointerType !== 'touch') show(); });
  on(root, 'pointerleave', () => { if (!dragging) show(); });
  on(bar, 'pointerenter', (e) => { if (e.pointerType !== 'touch') { hovering = true; show(); } });
  on(bar, 'pointerleave', () => { hovering = false; show(); });
  on(el, 'focusin', show);
  on(el, 'focusout', () => setTimeout(show, 0));

  // click on the picture toggles play; on touch, the first tap only reveals the controls
  let downType = 'mouse', downHidden = false;
  on(root, 'pointerdown', (e) => { if (!bar.contains(e.target)) { downType = e.pointerType; downHidden = el.dataset.hidden === 'true'; } });
  on(root, 'click', (e) => {
    if (bar.contains(e.target)) return;
    if (downType === 'touch' && downHidden) { show(); return; }
    toggle();
    show();
  });

  // ---- buttons
  on(playBtn, 'click', () => { toggle(); show(); });

  // ---- scrubber
  let pending = null, rafFlush = 0, wasPlaying = false;
  const tAtEvent = (e) => {
    const r = track.getBoundingClientRect();
    return clamp(((e.clientX - r.left) / r.width) * duration);
  };
  function flushSeek() {
    rafFlush = 0;
    if (pending == null) return;
    const t = pending; pending = null;
    anim.seek(t);
    lastT = -1;
  }
  function moveTip(e) {
    const r = track.getBoundingClientRect();
    const t = tAtEvent(e), c = chapterAt(t);
    tip.querySelector('.ftp-tip-name').textContent = c ? c.name : '';
    tip.querySelector('.ftp-tip-time').textContent = fmt(t);
    const half = tip.offsetWidth / 2;
    const x = Math.min(r.width - half, Math.max(half, e.clientX - r.left));
    tip.style.left = `${x - half + (track.offsetLeft || 0)}px`;
    tip.dataset.on = 'true';
  }
  on(track, 'pointerenter', (e) => { if (e.pointerType !== 'touch') moveTip(e); });
  on(track, 'pointerleave', () => { if (!dragging) tip.dataset.on = 'false'; });
  on(track, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    track.dataset.drag = 'true';
    wasPlaying = anim.playing;
    if (wasPlaying) anim.pause();
    track.setPointerCapture(e.pointerId);
    pending = tAtEvent(e);
    flushSeek();
    moveTip(e);
    e.preventDefault();
    track.focus({ preventScroll: true });
  });
  on(track, 'pointermove', (e) => {
    moveTip(e);
    if (!dragging) return;
    pending = tAtEvent(e);
    if (!rafFlush) rafFlush = requestAnimationFrame(flushSeek);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    delete track.dataset.drag;
    if (rafFlush) { cancelAnimationFrame(rafFlush); rafFlush = 0; }
    if (e.type === 'pointerup') pending = tAtEvent(e);
    flushSeek();
    if (wasPlaying && anim.t < duration - 0.02) anim.play();
    const r = track.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) tip.dataset.on = 'false';
    show();
  };
  on(track, 'pointerup', endDrag);
  on(track, 'pointercancel', endDrag);

  // ---- keyboard (document-wide; the film page is a standalone viewer)
  on(document, 'keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    const onButton = tg && tg.tagName === 'BUTTON';
    let handled = true;
    switch (e.key) {
      case ' ': case 'Spacebar': if (onButton) { handled = false; break; } toggle(); break;
      case 'ArrowLeft': jump(anim.t - 5); break;
      case 'ArrowRight': jump(anim.t + 5); break;
      case '[': stepChapter(-1); break;
      case ']': stepChapter(1); break;
      case 'Home': jump(0); break;
      case 'End': jump(duration); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
    show();
  });

  // ---- render loop for the controls (DOM writes only when a value changed)
  let lastT = -1, lastSec = -1, lastState = '', raf = 0, lastChap = null, lastPlaying = null;
  function update() {
    raf = requestAnimationFrame(update);
    const t = anim.t, playing = anim.playing;
    if (t !== lastT) {
      lastT = t;
      const f = duration > 0 ? clamp(t) / duration : 0;
      fill.style.transform = `scaleX(${f})`;
      thumb.style.left = `${f * 100}%`;
      const sec = Math.floor(t + 1e-6);
      if (sec !== lastSec) {
        lastSec = sec;
        const c = chapterAt(t);
        cur.textContent = fmt(t);
        track.setAttribute('aria-valuenow', String(sec));
        track.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(duration)}${c ? `, chapter ${chapterIndex(c) + 1}: ${c.name}` : ''}`);
        if (c !== lastChap) { lastChap = c; chapLabel.textContent = c ? c.name : ''; }
      }
    }
    const state = isEnded() ? 'replay' : playing ? 'pause' : 'play';
    if (state !== lastState) {
      lastState = state;
      const label = state === 'replay' ? 'Replay' : state === 'pause' ? 'Pause' : 'Play';
      playBtn.innerHTML = `${ICONS[state]}<span class="ftp-btn-label">${label}</span>`;
      playBtn.setAttribute('aria-label', label);
      playBtn.title = state === 'replay' ? 'Replay (Space)' : `${label} (Space)`;
    }
    if (playing !== lastPlaying) { lastPlaying = playing; show(); }
  }
  update();
  show();

  return {
    el,
    show,
    hide,
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(hideTimer);
      for (const off of cleanups) off();
      root.classList.remove('ftp-idle');
      el.remove();
    },
  };
}
