# Film tools

Check and export the promo film (`artifacts/rag-app/public/film/`). Both scripts drive headed Chrome parked offscreen (never headless: WebGL timing). They wait for `window.__anim.ready`, then need `renderAt(t)`, `captions()` and `renderer === 'webgl2'` (see `docs/promo-film.md`). A degraded renderer fails both scripts unless the URL contains `debug2d`.

Playwright is resolved from `.tmp/film-tools/node_modules` (override with `FILM_TOOLS=<dir>`). Export needs `ffmpeg` and `ffprobe` on PATH.

**Serve** (use `py`, the Python launcher; `python` is a Store stub):

    py -m http.server 8780 --bind 127.0.0.1 --directory artifacts/rag-app/public
    # film at http://localhost:8780/film/

`.claude/launch.json` config `film` runs the same command on the same port (8780).

**Check** (ms/frame, stills, seek robustness, caption budget, console errors; exits 1 on failure):

    node scripts/film/check.mjs --url <url> [--name round1] [--times 2,10,17.5] [--sheet] [--tol 2] [--with-ui]
    node scripts/film/check.mjs --url <url> --reduce --dip-check   # reduced motion, one-frame luma jumps

The page links `/film/css/transport.css`; the transport injects no styles and no HTML strings (CSP `style-src-elem 'self'`, Trusted Types).

Stills go to `.tmp/film/<name>/` in the repo (override with `--out`), with `report.json` and, with `--sheet`, `sheet.png`. The transport overlay is hidden in stills unless `--with-ui`.

Seek robustness reruns any failing time once for diagnosis (both attempts are logged; a pass on rerun is labelled FLAKY), but any failed attempt fails the check. Each failure writes the forward frame, the failing frame, a diff PNG (yellow box = diff bbox) and the split into the `#gl` and `#ui` canvases (`--gl-canvas`, `--ui-canvas`) to `--out`, and prints the bbox and layer. `--reduce` loads the page with `?motion=reduce`. `--dip-check` is a mode: it renders the four reduced-motion act changes (22.2-23.7, 46.4-47.4, 58.1-59.1 and 66.7-67.7 s) at 1/60 s through `renderAt` and fails if any one-frame composite mean-luma jump is >= 10 levels (`--dip-windows a-b,c-d`, `--dip-max 10`).

**Export** (WebCodecs H.264 in the page, `ffmpeg -c copy` mux, faststart, BT.709 primaries and matrix, sRGB transfer tag):

    node scripts/film/export.mjs --url <url> --out film.mp4 [--fps 60] [--from 0 --to 77] [--width 1920 --height 1080] [--bitrate 24]

It prints an ffprobe summary. `--from`/`--to` must satisfy `0 <= from < to <= duration`. Exits non-zero if the browser has no H.264 WebCodecs or the raw file cannot be written. Add `--keep-raw` to keep the `.h264`.
