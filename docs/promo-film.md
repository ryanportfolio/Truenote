# Truenote promo film: "Every answer shows its receipt"

A shareable ~80 s film for truenote.org, rendered live in the browser by a deterministic `frame(t)` engine and exportable to MP4. Lives at `artifacts/rag-app/public/film/` so it deploys to `https://truenote.org/film/`.

## The feeling and the job

When it ends, a viewer who has never heard of Truenote should feel the calm of a rep who can prove an answer mid-call, and understand three facts: Truenote answers only from approved documents, every answer carries a clickable source, and when the documents do not answer, it says so.

## Visual direction: every tile is a passage

The whole film is built from one material: several thousand small paper tiles, each one a passage cut from an approved document. The same tiles are the storm of scattered PDFs in the cold open, the concentric archive rings of the brand art (`public/visuals/luminous-archive-clean.webp`), the search results, the table the answer comes from, and finally the Truenote mark. Nothing cuts; tiles carry their identity through every morph.

- **Material.** Warm cream paper with fibre grain, faint ruled text lines, a hairline edge, and soft contact shadows cast on the table below. Mineral green (`--archive-green`, oklch 64% 0.075 176) and persimmon (`--archive-coral`, oklch 66.5% 0.145 43) tint some tile families. Cobalt (`--primary` #0040AB) is rare: the glass answer core and highlighted evidence only. An amber filament (`--warning` #F59F0A at low strength) draws the search sweep.
- **Ground.** A paper table with faint pencil construction lines (compass circles, rulings) like the hero art. It starts as deep archive ink (oklch 29% 0.11 260, the cold open) and warms to canvas cream `#E8E6DE` at the turn. That dawn is the film's one big lighting change.
- **The core.** A recessed cobalt glass lens: deep blue interior with a faint star-field, fine concentric rings, one specular crescent. It lights when evidence is found and dims calmly on refusal.
- **Camera.** One 3D perspective camera over the table. Low and tilted inside the storm; rising to the top-down hero composition at the turn; slow push-ins on the answer; a pull-back to wide for program scope; centred for the mark.
- **Type.** Statements in Georgia 600 (tight tracking, one cobalt italic accent word). Labels in a mono stack, 12 to 14 px uppercase tracking-wide. UI cards in Verdana, faithful to DESIGN.md (cards `#FDFDFC`, hairline `#DAD9D6`, pills, receipt strip). All text is drawn into a 2D canvas so it reaches the exported MP4.
- **Motion.** Ease-out-quart arrivals, staggered 1 to 2 frame particle offsets from a fixed seed, slow drift against fast snaps, 1.5 to 2 s still holds after each statement. No bounce on UI; springs only on tiles landing.

## Beat sheet (target 80 s)

| t (s) | Chapter | Picture (verbs) | Words on screen | Hold |
|---|---|---|---|---|
| 0 to 11 | 0 Cold open | Dark ink table. A thin voice waveform pulses across the frame. Thousands of paper tiles tumble in a slow vortex, lit by a cold side light; loose pages flip past the camera. A call timer ticks. | Label `CALL IN PROGRESS 00:41`. Caller label: "What's the fee if I cancel my Basic plan?" Statement: "The answer is in here. *Somewhere.*" | 2 s |
| 11 to 21 | 1 The stakes | The vortex slows. Two identical answer cards rise from the tiles, side by side: "$5" and "$15". Same font, same confidence. One slides under a hairline crack and crumbles back into tiles. | Statement: "A guess sounds *exactly* like an answer." | 2 s |
| 21 to 33 | 2 The turn | Light warms; ink ground dawns to cream; construction lines draw on. Two document stacks ("Cancellation Policy v1", "Refund Procedure v1") slide in and slice into passages. Every tile in the storm files itself into the concentric archive rings around the cobalt core. | Labels: `APPROVED DOCUMENTS`, `SPLIT INTO PASSAGES`. Statement: "Truenote answers only from *your* approved documents." | 2 s |
| 33 to 50 | 3 Ask, answer, receipt | The composer types the caller's question. Two search passes sweep the rings: a soft cobalt wave (meaning) and sharp amber flashes where exact words match. The best passages lift; one flies into the core. The answer card prints: "The standard cancellation fee for the Basic plan is $5 [1]"; the receipt strip follows a beat later. A filament links the chip to the source; the citation panel opens on the table with the Basic row highlighted. Call bar: answered. | Labels: `MEANING`, `EXACT WORDS`, `BEST PASSAGE`. Statement: "Every answer shows its *receipt*." | 2 s |
| 50 to 62 | 4 The stop | A new question: "What is the reinstatement fee for the Premium plan?" The waves go out; no tile rises above the threshold ring. The core stays dim and calm. The refusal card prints: "I couldn't find this in the knowledge base." with the amber "Not in knowledge base" chip. The question files itself into the managers' gap list. | Statement: "When the documents stop, Truenote *stops*." Label: `LOGGED AS A GAP FOR REVIEW` (pending fact check) | 2 s |
| 62 to 70 | 5 Program scope | Camera pulls wide. The archive divides into program sectors separated by thin walls, each with a quiet swatch dot. A query wave from Program A travels to its wall and stops. | Statement: "Each team searches only its own *program*." | 1.5 s |
| 70 to 80 | 6 Resolve | Every tile converges into the mark: mineral-green sheet, persimmon sheet, cobalt core with the Georgia "T". Wordmark "Truenote", one line, the URL. | "Truenote" / "Cited answers for every call." / `truenote.org` | 3 s+ |

Payoff: the caller's question in chapter 0 is the question answered in chapter 3, and the call bar resolves.

Product copy comes from the product: the Basic plan fee, the answer sentence, the refusal sentence and the Premium reinstatement question are the seeded demo data (`scripts/src/seed.ts`, `public/about/index.html`). Every statement must be checked against the code before it ships.

## Engine contract

Files under `artifacts/rag-app/public/film/`. Plain ES modules, no build step, no network dependencies, system fonts only (Georgia, Verdana, mono stack).

| File | Owner | Job |
|---|---|---|
| `index.html` | lead | Stage, canvases, transport markup, boot |
| `js/main.js` | lead | rAF loop, clock, seek, resize, `window.__anim` |
| `js/camera.js` | lead | View/projection math shared by renderer and UI |
| `js/choreo.js`, `js/shapes.js` | lead | Timeline, tile tracks, camera path, per-frame `FrameState` and `UIState` |
| `js/render.js` | renderer | WebGL2 renderer of `FrameState` |
| `js/ui.js` | UI | 2D canvas component library for captions and product UI |
| `js/transport.js`, `js/export.js` | tools | Viewer controls, scrubber, MP4 export |

### Coordinates

World units are pixels of a 1920x1080 design frame. `x` right, `y` down, `z` up off the table (towards a top-down camera). The default camera sits at `(960, 540, 540 / tan(fov/2))` looking at `(960, 540, 0)` with up vector `(0, -1, 0)` and `fov` 30 degrees, so a point on the table at `(x, y, 0)` lands on design-frame pixel `(x, y)`.

`camera.js` exports:

```js
export function cameraMatrices(cam, aspect) // -> { view: Float32Array(16), proj: Float32Array(16), viewProj: Float32Array(16), eye: [x,y,z] }
export function project(cam, x, y, z, aspect = 16/9) // -> { sx, sy, depth, scale }  sx, sy in 1920x1080 design px; scale = design px per world unit at that depth
```

`cam = { x, y, z, tx, ty, tz, ux, uy, uz, fov }` (fov in degrees, vertical). Matrices are column-major, WebGL convention.

### Tiles

`tiles` is a `Float32Array` of `count * STRIDE`, `STRIDE = 16`:

| idx | field | meaning |
|---|---|---|
| 0, 1, 2 | x, y, z | tile centre, world units |
| 3, 4, 5 | rx, ry, rz | radians. Tile is a rectangle in its local XY plane facing +z. Model matrix = T * Rz * Ry * Rx * S |
| 6, 7 | w, h | size in world units |
| 8, 9, 10 | r, g, b | albedo, sRGB 0..1 |
| 11 | alpha | 0..1 (0 = skip) |
| 12 | lines | 0..1 visibility of ruled text lines on the face |
| 13 | glow | 0..1 emissive highlight of the text lines and edge |
| 14 | glowHue | 0 = cobalt, 1 = amber (mix) |
| 15 | seed | 0..1 constant per tile, for pattern variation |

### FrameState (lead -> renderer)

```js
{
  t,                       // seconds; seeds grain deterministically (round(t*60))
  cam,                     // see above
  tiles, count,
  ground: { ink: 0..1,     // 0 = cream #E8E6DE, 1 = archive ink oklch(29% 0.11 260) darkened
            lines: 0..1,   // pencil construction lines (circles centred on linesX, linesY)
            linesX, linesY },
  light:  { az, el,        // radians; key light direction (az 0 = from +x, el from table plane)
            warmth: 0..1,  // 0 = cold blue-white, 1 = warm afternoon
            intensity },
  shadow: 0..1,            // contact shadow strength
  core:   { x, y, r, on: 0..1, glow: 0..1, dim: 0..1 },  // cobalt glass lens on the table
  waves:  [ { x, y, r, width, intensity, hue } ],         // emissive rings on the table (search sweeps); hue 0 cobalt, 1 amber
  beams:  [ { x0, y0, z0, x1, y1, z1, width, intensity, hue } ], // light filaments
  post:   { exposure, bloom, vignette, grain, fade }       // fade 0..1 towards archive ink
}
```

### UIState (lead -> ui.js)

`ui.js` exports pure draw functions that take the 2D context (already scaled to 1920x1080 design px), a props object and numeric progress values. No clocks, no randomness, no state between calls. Theme is `'dark'` (cream text on ink) or `'light'` (ink on cream).

## Verification

- Stills to `D:\screenshots\truenote\film\<round>\` via headed Chrome parked at `-2400,-2400`.
- Seek robustness: forward and reverse still sets must match.
- Caption reading budget: 250 ms per word + 1 s, never under 20 frames.
- Flash budget: the dawn is a 2 s ramp; no hit frames.
- `prefers-reduced-motion`: camera moves, vortex spin and parallax drop to dissolves; every caption and state stays.
