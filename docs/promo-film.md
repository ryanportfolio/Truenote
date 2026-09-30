# Truenote promo film: "Every answer shows its receipt"

A shareable 77-second film for truenote.org, rendered live in the browser by a deterministic `frameState(t)` engine and exportable to MP4. Lives at `artifacts/rag-app/public/film/` and is served at `https://truenote.org/film/` by the `/film` route in `artifacts/api-server/src/app.ts`.

## The feeling and the job

When it ends, a viewer who has never heard of Truenote should feel the calm of a rep who can prove an answer mid-call, and understand four facts: Truenote answers only from approved documents, every answer carries a clickable source, when the documents do not answer it says so, and a rep's search stays inside their program.

## Visual direction: every tile is a passage

The film is built from one material: about 6,000 paper tiles, each one a passage cut from an approved document. The same tiles are the storm of scattered pages in the cold open, the two answer cards, the concentric archive rings of the brand art (`public/visuals/luminous-archive-clean.webp`), the search results, the citation panel and finally the Truenote mark. Nothing cuts; tiles carry their identity through every morph.

- **Material.** Warm paper lit like a dark room in the cold open (one cold key, a warm bounce, a rim), then flush engraved paper bands at rest with soft shadows at every height step. Mineral green and persimmon tint some bands. Cobalt is rare: the glass lens and highlighted evidence. Amber marks exact-word hits, the threshold and the program walls.
- **Ground.** Archive ink in the cold open, a cold dawn at the turn (ink, deep cobalt, cold dawn white, cream), then brand cream `#E8E6DE` with faint pencil construction lines.
- **The lens.** A recessed cobalt glass core with a paper bezel, a layered starfield and caustics. It ignites when the archive forms, flares when the answer lands, dims calmly on refusal, and becomes the core of the mark.
- **Type.** Statements in Georgia 600 with one cobalt italic accent word. Labels in mono. Product UI in Verdana, faithful to DESIGN.md and to the chat components. All text is drawn into a 2D canvas so it reaches the exported MP4.

## Beat sheet (77 s; `js/choreo.js` is the source of truth)

| t (s) | Chapter | Picture | Words on screen |
|---|---|---|---|
| 0 to 10 | Cold open | Lights come up on a storm of warm paper; a sheet whips across the lens; the call timer runs; a passage carrying "Basic | $5" drifts past the lens | Caller: "What's the fee if I cancel my Basic plan?" Statement: "The answer is in here. Somewhere." |
| 10 to 19 | The stakes | Two passages leave the storm and turn into bare answer cards, "$5" and "$15"; threads search the storm for a source and fray | Cards: "No source". Statement: "A guess sounds exactly like an answer." |
| 19 to 31 | The turn | Storm clears; Cancellation Policy v1 and Refund Procedure v1 arrive and are cut row by row into passages; cold dawn; passages seed the inner rings and the archive forms around the lens | Labels: Approved documents, Split into passages. Statement: "Only your approved documents can support an answer." |
| 31 to 46.6 | The receipt | The seeded question is asked; low camera; meaning wave, amber exact-word hits, shortlist rises, best passage flies into the lens; answer card with receipt; the passage turns over and unfolds into the citation panel; a thread lands on the Basic line | Labels: Meaning, Exact words, Best passage. Statement: "Every answer shows its receipt." |
| 46.6 to 58.6 | The stop | Second question; a dashed amber bar rises over the archive; weak candidates rise on light columns, fall short, hold; the lens dims; refusal card; logged in Content gaps | Labels: Minimum match, No passage matched well enough. Statement: "When the documents stop, Truenote stops." |
| 58.6 to 67 | Program scope | Wide shot; wedges separate; boundary tiles stand as walls; a sweep inside Program A hits its walls and stops | Statement: "A rep's search never reaches another program." |
| 67 to 77 | Truenote | The archive inhales, implodes into the mark with a cobalt impact ring, and hands over to the drawn sheets around the lens | "Truenote" / "A cited answer, or a clear no." / truenote.org |

Product copy comes from the product and was checked against the code: the seeded question and fee (`scripts/src/seed.ts`), "Source passage" on the receipt, the refusal sentence and hint (`answer.ts`, `AnswerView.tsx`), the "Not found in these documents" chip, "Content gaps", and the confidence gate behind "No passage matched well enough". The answer sentence mirrors the About page example; real answers are model-written.

## Files

| File | Job |
|---|---|
| `index.html`, `css/film.css` | Stage, transcript for screen readers, same-origin styles (production CSP) |
| `js/main.js` | Boot, clock, resize, `window.__anim` (`ready`, `renderer`, `seek`, `play`, `pause`, `renderAt`, `captions`) |
| `js/camera.js` | View/projection math shared by the renderer and the 2D layer |
| `js/shapes.js`, `js/choreo.js` | Layouts, timeline, camera path, per-frame `FrameState` and the 2D layer calls |
| `js/render.js` | WebGL2 renderer (paper tiles, shadows, lens, waves, beams, bloom) |
| `js/ui.js` | Canvas 2D captions and product UI |
| `js/transport.js`, `css/transport.css` | Viewer controls (Trusted Types safe) |
| `js/debug2d.js` | Canvas 2D fallback when WebGL2 is unavailable (`?debug2d` forces it) |
| `scripts/film/` | `check.mjs` (stills, seek robustness, reading budget, console), `export.mjs` (WebCodecs H.264 + ffmpeg mux) |

Coordinates: world units are pixels of a 1920x1080 design frame; `x` right, `y` down, `z` up off the table. The tile record (`STRIDE = 16`) and `FrameState` fields are documented at the top of `render.js` and in `choreo.js`.

## Verification

- Serve `artifacts/rag-app/public` on 127.0.0.1:8780 and open `/film/` (see `scripts/film/README.md`; the `film` entry in `.claude/launch.json` uses the same port).
- `scripts/film/check.mjs` in headed Chrome on the GPU: 0 console errors, identical frames forward and reverse, every statement and label within 250 ms per word + 1 s.
- `prefers-reduced-motion` (or `?motion=reduce`): the camera holds one pose per act and changes under a dissolve through the scene's colour; no vortex spin, tumbling or flyby; captions and states stay.
- Flash budget: no hit frames; the dawn is a 3 s ramp.
