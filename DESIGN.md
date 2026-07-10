# Truenote — Design System

> Visual tokens as shipped by the Cohere-inspired design pass (2026-07). Strategic register and design principles live in [PRODUCT.md](./PRODUCT.md). This file is tokens, not philosophy.

Tokens are **OKLCH channel triplets** (`--primary: 41.41% 0.1807 261.2`) consumed as `oklch(var(--token) / <alpha-value>)` in `tailwind.config.ts`. The `<alpha-value>` placeholder is load-bearing: Tailwind v3's parser cannot alpha-inject a bare `oklch(var(--x))` the way it special-cases `hsl()`, and silently drops every `/alpha` utility without it. Do not "simplify" it away.

The visual reference is docs.cohere.com's light theme (extracted from its deployed CSS, 2026-07-04): cream canvas, chrome layer, white cards, warm hairlines, one rare accent. Where we deviate (brand-blue accent, Verdana, 600-weight cap), the deviation was decided deliberately — see the conflict log in the design-pass PR.

## Palette (light — the ship target)

| Token | OKLCH | ≈ Hex | Role |
|---|---|---|---|
| `--background` | `92.43% 0.0109 95.2` | `#E8E6DE` | App canvas (warm cream, byte-identical to Cohere's) |
| `--foreground` | `24.31% 0.0076 95.4` | `#21201C` | Body ink. **13.05:1** on bg, **16.02:1** on card |
| `--card` | `99.38% 0.0013 106.4` | `#FDFDFC` | Content cards. Warm near-white — never pure `#fff` |
| `--secondary` | `98.18% 0.0013 106.4` | `#F9F9F8` | Chrome layer: TopBar, Sidebar, whisper buttons |
| `--muted` | `95.56% 0.0017 67.8` | `#F1F0EF` | Quiet fills, icon-button hover, neutral badges |
| `--muted-foreground` | `46.63% 0.0159 97.7` | `#5C5A50` | Chrome text. **5.54:1** on bg, **6.80:1** on card (AA+) |
| `--primary` | `41.41% 0.1807 261.2` | `#0040AB` | Parent-company brand blue. **7.24:1** on bg, **9.05:1** white-on (AAA both ways) |
| `--accent` | `52.37% 0.2194 260.5` | `#005DE5` | Vivid brand blue — hover states only, never text |
| `--success` | `43.52% 0.0428 168.8` | `#39594D` | Evergreen (Cohere's accent): ready pills, thumbs-up, copy-confirm. **7.61:1** on card |
| `--warning` | `77.04% 0.1646 70.7` | `#F59F0A` | Amber — tint washes + badge chips only, never running text |
| `--warning-foreground` | `28.01% 0.0563 94.1` | `#322801` | Text on warning tints |
| `--destructive` | `42.61% 0.1584 27.3` | `#921616` | Errors. **7.16:1** on bg, **8.79:1** on card — AAA even on the canvas |
| `--border` / `--input` | `88.52% 0.0042 91.5` | `#DAD9D6` | Warm hairline. Every division is 1px of this |
| `--ring` | = `--primary` | | Focus rings |
| `--radius` | `0.5rem` | | Base radius (see §Radius) |
| `--shadow-card` | `0 1px 2px oklch(24.31% 0.0076 95.4 / 0.06)` | | Card lift: warm ink at 6% |
| `--shadow-panel` | `0 8px 24px …/0.10, 0 1px 2px …/0.06` | | Floating panels only (slide-overs, popovers) |

Three-surface depth model: **cream canvas → `--secondary` chrome (TopBar/Sidebar) → `--card` content**. Cards separate with hairline + `shadow-card`; heavy shadows are reserved for `--shadow-panel` surfaces that actually float.

Light mode is the ship target. `.dark` ships as a mechanical inversion (converted from the old HSL values) so consumers don't break; no dark toggle is surfaced.

## Typography

**Verdana carries the UI** — body, labels, controls, data. Deliberate: system face, zero network load, and the user likes it. **Georgia** (Verdana's Matthew Carter companion) is reserved for *big headers and distinctive elements* via `font-display`: page `h1`s, the TopBar wordmark, auth-card titles. Do not use Georgia for section headings, labels, buttons, or anything inside a card body. Code/excerpt slots (citation excerpts, temp passwords) use the `font-mono` system stack.

| Slot | Face | Size / weight | Tracking |
|---|---|---|---|
| Page `h1` | Georgia (`font-display`) | 30px / 600 (`text-3xl`) | `-0.02em` (`tracking-tight`) |
| Auth-card title | Georgia (`font-display`) | 20px / 600 | `-0.02em` |
| TopBar wordmark | Georgia (`font-display`) | 18px / 600 | `-0.02em` |
| Section `h2` | Verdana | 20px / 600 | `-0.02em` |
| Body | Verdana | 16px / 400 | normal |
| Sidebar nav, Ask textarea, page-CTA buttons | Verdana | 16px / 400 (nav active + buttons 500) | normal |
| Chat answers, tables, most controls | Verdana | 14px / 400 | normal |
| Captions, metadata | Verdana | 14px / 400 | normal |
| Chips, badges, eyebrows | Verdana | 12px / 500 | eyebrows `tracking-wide` uppercase |
| Excerpts / codes | mono stack | 13px / 400 | normal |

> Changed 2026-07-04 (size pass, user-requested): page `h1` 24→30px, wordmark 16→18px, sidebar nav 14→16px, primary CTAs to `text-base` — chrome and headline type grew to use the space; body copy, tables, and chips deliberately stayed at 14/12px so density didn't turn into clutter.

Line-height: **1.5** on CSR chat (dense, scannable), **1.6** on admin prose. Weights **400/500/600 only** — no 700+; Cohere's extrabold prose headings belong to its docs register, not this product. The tight-tracked headings over relaxed body is the typographic signature.

## Contrast (WCAG, computed — never eyeballed)

| Pairing | Target | Computed | Status |
|---|---|---|---|
| `--foreground` on `--background` | AAA | 13.05:1 | ✓ |
| `--foreground` on `--card` | AAA | 16.02:1 | ✓ |
| `--muted-foreground` on `--background` | AA | 5.54:1 | ✓ |
| `--muted-foreground` on `--card` | AA | 6.80:1 | ✓ |
| `--primary` on `--background` | AAA | 7.24:1 | ✓ |
| white on `--primary` | AAA | 9.05:1 | ✓ |
| `--destructive` on `--background` | AAA | 7.16:1 | ✓ |
| `--success` on `--card` | AAA | 7.61:1 | ✓ |

Rules:
- Body text and anything a CSR reads mid-call hit **AAA** (≥7:1). Chrome hits **AA** (≥4.5:1).
- **Force `::placeholder { opacity: 1 }`** globally (done in index.css) — browsers default to ~0.5, which silently halves contrast. Cohere's own docs fail AA here; we don't.
- `::selection` is `primary/0.15` — ink on the blend ≈ 12.2:1, AAA survives selection. Scrollbars: `scrollbar-width: thin` + `--border` thumb.
- Never `#000` or `#fff` directly. Warm near-black ink; warm near-white surfaces.
- When changing a token, recompute (the sRGB→OKLCH + contrast script lives in the design-pass session; any WCAG calculator works). Do not eyeball.
- Color is never the sole channel: active nav = tint **+ weight**; focus = 2px ring **+ offset**; selected chips = tint **+ border**.

## Spacing & density

Base unit **4px**. Multiples only: `4, 8, 12, 16, 20, 24, 32, 48, 64`.

| Surface | Line-height | Rhythm | Column |
|---|---|---|---|
| CSR chat (`/chat`) | 1.5 | tight: `gap-4`, `px-4 py-6`, cards `p-4` | `max-w-2xl` (~Cohere's 640px measure) |
| Admin (`/admin/*`) | 1.6 | airy: `gap-6`, `px-6 py-8`, cards `p-5` | `max-w-5xl` |

Citation excerpts get their own inset mono block — they're the receipt, not the chrome.

## Radius

`--radius: 0.5rem`. Usage rules (no bare `rounded` — it means "didn't decide"):

- **Cards, callouts, panels, tables**: `rounded-lg` (8px)
- **Inputs, selects, inset code blocks**: `rounded-md` (6px)
- **Buttons, chips, pills, badges**: `rounded-full` — the Cohere shape signature. Rectangular content, pill controls.

## Buttons

Two variants plus an icon recipe. All pills, all share the focus-ring spec, all `cursor-pointer` (Tailwind v3 preflight leaves buttons `cursor: default` — pointer is half of "looks clickable").

### Whisper (default — everywhere)

`.btn-whisper`: `--secondary` surface, ink text, 1px inset hairline (`--border`). Hover: hairline strengthens to `foreground/0.18` (box-shadow transitions — no snap). Active: `--muted` fill. Sizes via padding utilities (`px-3 py-1.5` regular, `px-3 py-1 text-xs` small).

### Primary — at most one per surface

`.btn-primary`: brand-blue filled, white text (9.05:1, AAA). Hover shifts to `--accent`; active darkens to `primary/0.92`. Allowed for **exactly one** action per surface — the thing the user came there to do: **Ask** (`/chat`), **Upload** (`/admin/documents`), **Create user** (`/admin/users`), **Create program** (`/admin/programs`). Sign-in stays whisper (nothing competes with it). `.btn-csr-ask` is a kept alias so the `/chat` Ask button stays greppable as the original exception. Adding a second filled button to a screen is a bug, not an emphasis choice. The four page CTAs render a size up from whisper defaults: `px-5 py-2 text-base`.

> Changed 2026-07-04 (polish pass 2, user-approved): generalized from "csr-ask only on /chat" because whisper-everything left form primary actions with zero hierarchy — Upload was invisible next to Browse.

### Icon buttons

`.btn-icon`: transparent at rest, `--muted` fill + ink on hover, for icon-only actions (copy, thumbs, close-X). Part of the whisper family, not a third variant. Destructive contexts may use a destructive-quiet pill (`border-destructive/40 text-destructive hover:bg-destructive/10`) — Retry/Delete only.

### File inputs

`::file-selector-button` gets the whisper spec via `file:` utilities: pill, 1px `--border` border, `--secondary` fill, pointer cursor, hover border strengthens to `foreground/0.30`. A bare OS file button is a bug.

## Interaction states

| State | Visual change |
|---|---|
| Default | Base tokens |
| Hover | Whisper: hairline strengthens. Primary: bg → `--accent`. Icon: `--muted` fill. Table rows: `bg-muted/40` wash |
| Focus | 2px `--ring` outline, 2px offset (`focus-visible:` on buttons/links; `focus:` on text inputs) |
| Active | Whisper: bg → `--muted`. Primary: `primary/0.92`. Citation chips: `bg-primary/25` |
| Disabled | `opacity-50`, `cursor-not-allowed`, hover suppressed |
| Selected | Nav: `bg-primary/10 text-primary font-medium` + `aria-current`. Chips: tint + border + `aria-pressed` |

## Tables

Cohere table language: **horizontal rules only**. Header = 12px uppercase muted + weight, **no fill**, no vertical cell borders. Markdown tables in answers: `th` = `border-b`, `td` = `border-t`, `border-collapse`.

Admin tables: card chrome (`rounded-lg border bg-card shadow-card`) lives on an `overflow-x-auto` **wrapper div**, never on the `<table>` (`overflow-hidden` on a table clips instead of scrolling). Tables carry a `min-w` floor (36–44rem) so narrow viewports scroll. Rows take a `hover:bg-muted/40` wash — a scanning aid, invisible at rest.

Numbers in tables (and the debug telemetry row) set `tabular-nums` so columns don't wobble. Timestamps render relative ("2 hours ago") via the `RelativeTime` component — a `<time>` with the absolute string in `title`/`dateTime`; raw `toLocaleString()` in a list is drift.

## Selects

`.select-quiet`: `appearance-none`, pointer cursor, `pr-8`, and an inline SVG chevron in `--muted-foreground`'s hex (`#5C5A50` — CSS `url()` can't read custom properties; revisit if a dark toggle ever ships). Call sites keep their own border/bg/size. Applies to every native `<select>`.

## Keyboard hints

`.kbd` (index.css): mono 11px, `--muted` fill, hairline border, `rounded`. Used for the chat shortcut line (Enter / Shift+Enter / "/"). The "/" key focuses the ask box anywhere on /chat unless focus is already in a field.

## Quiet alerts

Inline errors share one recipe everywhere (auth pages, admin forms, panels): `rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive` + `role="alert"`. Destructive text on the 10% tint over card ≈ 8.3:1 — AAA. Bare red text is drift.

## Loading states

`.skeleton` (index.css): `--muted` bars, `rounded-md`, slow opacity breathing (`skeleton-pulse` 1.8s ease-in-out, 100→55%) — **no shimmer sweep**. `motion-safe:` only; every skeleton group carries `role="status"` + `sr-only` "Loading…" text. Shapes mimic the loaded layout (table rows, cards, mono bars). Chat's pending exchange is the exception: a compact orbital evidence instrument visualizes retrieval while the live stage label carries the real pipeline state for assistive technology. App boot = the Georgia wordmark breathing with the same keyframes. Text "Loading…" as UI is drift.

## Empty states

`EmptyState` component (`components/EmptyState.tsx`): dashed hairline surface with a code-native 3D stack of cobalt, mineral-green, and persimmon sheets behind the muted lucide icon. It echoes the login sculpture at icon scale without importing a heavy bitmap into work surfaces. Optional actions render as teaching chips (used for chat example questions and the 404 "Go to Chat" link). Every list surface teaches on empty: Documents, Gaps (per-filter copy), Users, Programs, Chat first-run, 404.

## Status colors

Semantic tokens only — raw Tailwind palette classes (`emerald-*`, `amber-*`, `slate-*`, …) are a bug:

- ready / positive / confirmed → `--success` tints (`bg-success/15 text-success`)
- parsing / pending-attention / one-shot credentials → `--warning` tints
- failed / errors / destructive actions → `--destructive` tints
- pending / neutral / most role badges → `--muted` (labels carry information; color is not a legend — only super_user gets the `primary/10` tint)

**Refusal is not a status-color moment**: the refusal card is a normal `--card` answer card; only its "Not in knowledge base" badge chip is amber. Refusal is a feature, not an alarm.

**Program identity dots** are the one sanctioned computed color: `programSwatchColor(id)` hashes the program id to a hue at fixed `oklch(75% 0.06 h)` — every swatch equally quiet, decorative `aria-hidden`, the program name always carries the information. Data-driven identity, not a semantic token; do not reuse the pattern for states.

## Citations & receipts

- **Receipt strip**: every grounded answer carries a cobalt-tint evidence block under the body with a solid count medallion and `Grounded excerpt(s) · <doc titles>` (unique titles, first two + count). PRODUCT.md's "show the receipt," literal. Titles link into the knowledge base reader (`/kb/:doc_id`) when the server resolved the doc id — the receipt is openable, not just named.
- **Citation peek**: chips show a hover/focus popover (`--shadow-panel`, `w-72`, doc title + first 160 excerpt chars in mono) via pure CSS `group-hover`/`group-focus-within`. Decorative `aria-hidden` speed aid; the click-through CitationPanel remains the canonical, screen-reader-reachable receipt. The panel ends with a "Read the full document" whisper link into `/kb/:doc_id`.
- **Sticky composer**: the /chat form pins to the scrollport bottom (`sticky bottom-0`, solid canvas fill, 24px gradient fade above) so the ask box is always one glance away.

## Knowledge base reader (/kb)

CSR-facing read surface for the same corpus answers are grounded in (sidebar "Knowledge base," minRole csr). List: single card of divided rows (title + relative time), client-side title filter with an inset search icon. Reader: one article card, `max-w-3xl`, doc title in display face over a hairline rule, then the parsed markdown. Unlike AnswerMarkdown, real-document rendering allows headings (stepped display scale), links (underlined `--primary`, new tab), and code; images render as a dashed placeholder chip carrying the alt text — OCR-local image refs aren't served. Cross-program or removed docs land on a calm EmptyState, not an error.

## Chat session history

Every /chat conversation is a session, auto-named server-side (gpt-4o-mini) from its opening exchange; the title shows as a small `--primary` line under the chat intro. The header carries a **History** whisper button (with `New conversation` when a transcript exists) — it expands an inline card of recent sessions (title or "Untitled conversation" + relative time, newest first, active one tinted), not a floating dropdown: no z-index, no focus trap, dismisses by re-toggling. Opening a session reloads its exchanges into the transcript with citations intact and continues it. `New conversation` clears the transcript AND the session id so the next ask starts a fresh, separately-named conversation. History actions disable while an ask is in flight.

## Motion

Easing **`cubic-bezier(0.25, 1, 0.5, 1)`** (ease-out-quart). Micro-interactions `100–120ms`, layout `240ms`. Named Tailwind tokens: `ease-out-quart`, `duration-240` (tailwindcss-animate maps both onto animation properties too). Honor `prefers-reduced-motion` everywhere — every animation below is `motion-safe:`. No bounce, no overshoot, no decorative motion.

Shipped motion vocabulary (enter-only — panels are conditional-render; exit animation isn't worth keeping them mounted):

| Moment | Animation |
|---|---|
| CitationPanel / PreviewPanel open | 16px slide-in from right + fade, 240ms ease-out-quart |
| Answer / refusal card mount | 4px rise + fade, 240ms ease-out-quart |
| Credential banner reveal | fade-in, 240ms |
| Copy-confirm Check icon | zoom-in from 75%, 100ms |
| Skeletons, boot wordmark | `skeleton-pulse` 1.8s opacity breathing |
| Retrieval instrument | Two orbital rings rotate around an evidence core while the stage label changes; 2.8–3.4s linear |
| Login archive plate | 16s camera drift + 13–18s orbital traces, all disabled by `prefers-reduced-motion` |

## Brand moments: The Luminous Archive

The visual metaphor is evidence gathering into a trustworthy core. It uses three controlled art colors on the existing warm-neutral system: cobalt (`--primary`), mineral green (`--archive-green`), and persimmon (`--archive-coral`). These art colors never replace semantic status tokens.

1. **Login hero** — `public/visuals/luminous-archive.png`, an original 3D editorial sculpture generated for Truenote. Paper strata and translucent mineral rings orbit an ink-blue evidence core. The image is decorative, copy-safe, and slowly camera-drifts only when reduced motion is not requested.
2. **Retrieval state** — code-native orbital rings turn the same metaphor into purposeful progress. The text stage remains canonical.
3. **Empty states** — a tiny CSS 3D paper stack gives pressure-free surfaces a collectible object without using another bitmap.
4. **The mark** — layered green and persimmon sheets sit behind a cobalt Georgia `T`. In persistent chrome it remains small and functional; on login it has enough depth to bridge into the sculpture.

Authenticated task surfaces remain calm. Depth concentrates around the answer, receipt, composer, active navigation, and state transitions.

## Token consumer contract

Components consume `oklch(var(--token) / <alpha-value>)` via `tailwind.config.ts`. Variable names are stable; only values change. Adding a token is a deliberate conversation (`--success` was added by the design pass, C5). `shadow-card` / `shadow-panel` are the only shadow utilities — `shadow-sm`/`shadow-2xl` are drift.

## Dark mode

Mechanical inversion of the pre-pass HSL values, converted to OKLCH. No toggle. Before shipping it for real: re-run all contrast math, keep near-black (not `#000`) surfaces with the brand-blue hue baked in, cream (not `#fff`) foreground.

## What makes Truenote feel like Truenote

1. **The brand-blue accent is rare.** Once or twice per screen: Ask button, active nav, citation chips. The restraint is what makes it branded.
2. **Depth has a job.** Warm hairlines still divide ordinary content. Stronger elevation is reserved for the composer, cited answers, active navigation, and the login sculpture.
3. **Warm neutrals.** Stone, not slate. Semantic tokens only.
4. **Tight density on CSR chat, generous whitespace on admin.** Same tokens, different rhythm.
5. **Georgia headers over Verdana body.** The Carter pairing: editorial-serif page titles, workhorse-sans everything else — tight headings, relaxed body.
6. **Evidence has a physical form.** Layered sheets, orbital traces, and a dense blue core recur at three scales without becoming decorative chrome.

## Responsive

Pure-CSS breakpoints, no JS breakpoint state:

- **Sidebar** is `w-60` at `md`+ and collapses to a 64px icon rail below — labels `sr-only md:not-sr-only`, `title` tooltips, `aria-current` unchanged.
- **TopBar** hides the email below `sm`; the program select clamps to `max-w-[10rem] truncate` below `sm`.
- **Admin tables** scroll horizontally inside their wrapper (see §Tables); auth cards are `max-w-sm` and center at every width.
- **Panels** are `w-[min(560–640px, 90vw)]`.

## Follow-ups

- ~~Drag-and-drop upload zone~~ shipped (pass 3): the upload card is the drop target — drag-over = `border-primary/40 bg-primary/5`, client-side type/size validation through the quiet-alert recipe, dropped file handed to the native input via `DataTransfer`.
- **Dark mode**: still a mechanical inversion; `.select-quiet`'s chevron hex and the favicon are light-mode-tuned — revisit both if a toggle ships.
