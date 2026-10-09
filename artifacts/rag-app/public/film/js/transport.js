// Viewer controls for the film: play/pause/replay, scrubber with chapter ticks, time, keyboard.
// Pure DOM overlay on the stage; auto-hides after 2.5 s idle, paused or playing. It is never drawn into the canvas, so MP4 export stays clean.
//
//   import { mountTransport } from './transport.js';
//   const tp = mountTransport(document.getElementById('stage'), window.__anim);
//
// `anim` needs: seek(t), play(), pause(), t, playing, duration, chapters [{ name, t0, t1 }].
// Returns { show, hide, destroy, el }.

// Element builders (no HTML strings, so this passes require-trusted-types-for 'script').
const SVG_NS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}
function svgIcon(...paths) {
  const s = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' })) s.setAttribute(k, v);
  for (const attrs of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    s.append(p);
  }
  return s;
}
const ICONS = {
  play: () => svgIcon({ fill: 'currentColor', d: 'M4 2.4v11.2a.5.5 0 0 0 .77.42l8.4-5.6a.5.5 0 0 0 0-.84l-8.4-5.6A.5.5 0 0 0 4 2.4z' }),
  pause: () => svgIcon({ fill: 'currentColor', d: 'M3.5 2h3v12h-3zM9.5 2h3v12h-3z' }),
  replay: () => svgIcon({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', d: 'M2.6 8a5.4 5.4 0 1 0 1.7-3.9M2.6 2.6v2.9h2.9' }),
};

const fmt = (s) => {
  s = Math.max(0, Math.floor(s + 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function mountTransport(root, anim, { autoHideMs = 2500 } = {}) {
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative';

  const duration = anim.duration;
  const chapters = (anim.chapters || []).slice().sort((a, b) => a.t0 - b.t0);
  const chapterAt = (t) => {
    let hit = null;
    for (const c of chapters) if (t >= c.t0 - 1e-6) hit = c;
    return hit;
  };
  const chapterIndex = (c) => chapters.indexOf(c);

  // Markup is built with createElement only (Trusted Types: no innerHTML).
  const el = h('div', { class: 'ftp', 'data-hidden': 'false' },
    h('div', { class: 'ftp-scrim' }),
    h('div', { class: 'ftp-bar', role: 'group', 'aria-label': 'Film controls' },
      h('button', { type: 'button', class: 'ftp-btn ftp-play', 'aria-keyshortcuts': 'Space' }),
      h('div', { class: 'ftp-time', 'aria-hidden': 'true' },
        h('span', { class: 'ftp-cur' }, '0:00'), h('span', {}, '/'), h('span', { class: 'ftp-tot' })),
      h('div', { class: 'ftp-scrub' },
        h('div', { class: 'ftp-track', role: 'slider', tabindex: '0', 'aria-label': 'Film timeline', 'aria-orientation': 'horizontal',
          'aria-valuemin': '0', 'aria-valuemax': String(Math.round(duration)), 'aria-valuenow': '0', 'aria-keyshortcuts': 'ArrowLeft ArrowRight Home End [ ]' },
          h('div', { class: 'ftp-rail' }, h('div', { class: 'ftp-fill' })),
          h('div', { class: 'ftp-thumb' })),
        h('div', { class: 'ftp-tip', 'aria-hidden': 'true' }, h('span', { class: 'ftp-tip-name' }), h('span', { class: 'ftp-tip-time' }))),
      h('div', { class: 'ftp-chap', 'aria-hidden': 'true' })));
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
  // The controls hide after autoHideMs without pointer movement, focus or a key press, playing or paused.
  // They stay while the pointer is over the bar, during a scrub, and while a control has keyboard focus.
  const mayHide = () => !hovering && !dragging && !focusVisibleInside();
  function show() {
    setHidden(false);
    clearTimeout(hideTimer);
    if (mayHide()) {
      hideTimer = setTimeout(() => {
        if (mayHide()) setHidden(true);
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
      const c = chapterAt(t);
      if (sec !== lastSec || c !== lastChap) {
        lastSec = sec;
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
      playBtn.replaceChildren(ICONS[state](), h('span', { class: 'ftp-btn-label' }, label));
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
