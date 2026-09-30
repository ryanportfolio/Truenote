# Film tools

Check and export the promo film (`artifacts/rag-app/public/film/`). Both scripts drive headed Chrome parked offscreen (never headless: WebGL timing) and need `window.__anim` from `docs/promo-film.md`, including `renderAt(t)` and `captions()`.

Playwright is resolved from `.tmp/film-tools/node_modules` (override with `FILM_TOOLS=<dir>`). Export needs `ffmpeg` and `ffprobe` on PATH.

**Serve** (use `py`, the Python launcher; `python` is a Store stub):

    py -m http.server 8780 --directory <repo root>
    # film at http://localhost:8780/artifacts/rag-app/public/film/index.html

**Check** (ms/frame, stills, seek robustness, caption budget, console errors; exits 1 on failure):

    node scripts/film/check.mjs --url <url> [--name round1] [--times 2,10,17.5] [--sheet] [--tol 2] [--with-ui]

Stills go to `D:/screenshots/truenote/film/<name>/` (override with `--out`), with `report.json` and, with `--sheet`, `sheet.png`. The transport overlay is hidden in stills unless `--with-ui`.

**Export** (WebCodecs H.264 in the page, `ffmpeg -c copy` mux, faststart, BT.709 primaries and matrix, sRGB transfer tag):

    node scripts/film/export.mjs --url <url> --out film.mp4 [--fps 60] [--from 0 --to 80] [--width 1920 --height 1080] [--bitrate 24]

It prints an ffprobe summary. Exits non-zero if the browser has no H.264 WebCodecs. Add `--keep-raw` to keep the `.h264`.
