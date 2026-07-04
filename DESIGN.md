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
| Page `h1` | Georgia (`font-display`) | 24px / 600 | `-0.02em` (`tracking-tight`) |
| Auth-card title / wordmark | Georgia (`font-display`) | 20px / 600 | `-0.02em` |
| Section `h2` | Verdana | 20px / 600 | `-0.02em` |
| Body | Verdana | 16px / 400 | normal |
| Chat answers, controls, tables | Verdana | 14px / 400 | normal |
| Captions, metadata | Verdana | 14px / 400 | normal |
| Chips, badges, eyebrows | Verdana | 12px / 500 | eyebrows `tracking-wide` uppercase |
| Excerpts / codes | mono stack | 13px / 400 | normal |

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

Two variants plus an icon recipe. All pills, all share the focus-ring spec.

### Whisper (default — everywhere)

`.btn-whisper`: `--secondary` surface, ink text, 1px inset hairline (`--border`). Hover: hairline strengthens to `foreground/0.18`. Active: `--muted` fill. Sizes via padding utilities (`px-3 py-1.5` regular, `px-3 py-1 text-xs` small).

### CSR Ask — the one deliberate exception

`.btn-csr-ask`: brand-blue filled, white text, **only** on `/chat`. Hover shifts to `--accent`; active darkens to `primary/0.92`. Do not propagate — the contrast is the point.

### Icon buttons

`.btn-icon`: transparent at rest, `--muted` fill + ink on hover, for icon-only actions (copy, thumbs, close-X). Part of the whisper family, not a third variant. Destructive contexts may use a destructive-quiet pill (`border-destructive/40 text-destructive hover:bg-destructive/10`) — Retry/Delete only.

## Interaction states

| State | Visual change |
|---|---|
| Default | Base tokens |
| Hover | Whisper: hairline strengthens. Ask: bg → `--accent`. Icon: `--muted` fill |
| Focus | 2px `--ring` outline, 2px offset (`focus-visible:` on buttons/links; `focus:` on text inputs) |
| Active | Whisper: bg → `--muted`. Ask: `primary/0.92` |
| Disabled | `opacity-50`, `cursor-not-allowed`, hover suppressed |
| Selected | Nav: `bg-primary/10 text-primary font-medium` + `aria-current`. Chips: tint + border + `aria-pressed` |

## Tables

Cohere table language: **horizontal rules only**. Header = 12px uppercase muted + weight, **no fill**, no vertical cell borders. Markdown tables in answers: `th` = `border-b`, `td` = `border-t`, `border-collapse`.

## Status colors

Semantic tokens only — raw Tailwind palette classes (`emerald-*`, `amber-*`, `slate-*`, …) are a bug:

- ready / positive / confirmed → `--success` tints (`bg-success/15 text-success`)
- parsing / pending-attention / one-shot credentials → `--warning` tints
- failed / errors / destructive actions → `--destructive` tints
- pending / neutral / most role badges → `--muted` (labels carry information; color is not a legend — only super_user gets the `primary/10` tint)

**Refusal is not a status-color moment**: the refusal card is a normal `--card` answer card; only its "Not in knowledge base" badge chip is amber. Refusal is a feature, not an alarm.

## Motion

Easing **`cubic-bezier(0.25, 1, 0.5, 1)`** (ease-out-quart). Micro-interactions `100–120ms`, layout `240ms`. Wait-stage pulse is `motion-safe:` only; honor `prefers-reduced-motion` everywhere. No bounce, no overshoot, no decorative motion.

## Brand moments

Exactly one: the Login page's organic blob washes (`bg-primary/10` + `bg-success/15`, `blur-3xl`, pure CSS) — the PRODUCT.md Cohere-illustration direction. Decorative `aria-hidden` layers behind an opaque card; contrast guarantees untouched. Everywhere else stays calm.

## Token consumer contract

Components consume `oklch(var(--token) / <alpha-value>)` via `tailwind.config.ts`. Variable names are stable; only values change. Adding a token is a deliberate conversation (`--success` was added by the design pass, C5). `shadow-card` / `shadow-panel` are the only shadow utilities — `shadow-sm`/`shadow-2xl` are drift.

## Dark mode

Mechanical inversion of the pre-pass HSL values, converted to OKLCH. No toggle. Before shipping it for real: re-run all contrast math, keep near-black (not `#000`) surfaces with the brand-blue hue baked in, cream (not `#fff`) foreground.

## What makes Truenote feel like Truenote

1. **The brand-blue accent is rare.** Once or twice per screen: Ask button, active nav, citation chips. The restraint is what makes it branded.
2. **Hairlines over shadows.** 1px warm `--border` divides; `shadow-card` whispers; only floating panels cast real shadow.
3. **Warm neutrals.** Stone, not slate. Semantic tokens only.
4. **Tight density on CSR chat, generous whitespace on admin.** Same tokens, different rhythm.
5. **Georgia headers over Verdana body.** The Carter pairing: editorial-serif page titles, workhorse-sans everything else — tight headings, relaxed body.

## Follow-ups

- **Illustration system**: extend the blob language (login today) to empty states — asset work, not token work.
- **Skeleton loading states**: replace "Loading…" text with skeletons on admin lists.
