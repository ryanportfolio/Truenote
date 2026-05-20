# Truenote — Design System

> Visual tokens for Phase 1. Strategic register and design principles live in [PRODUCT.md](./PRODUCT.md). This file is tokens, not philosophy.

Phase 1 keeps HSL because shadcn's `hsl(var(--token))` wrappers already consume it across the app. OKLCH migration is a follow-up — same variable names, same consumers, just swap the color space and update the wrapper.

## Palette

Cohere-derived. Warm cream + deep forest, with a single sparingly-used secondary blue for emphasis (e.g., code or link highlights).

| Token            | Hex       | HSL                 | Role                                            |
|------------------|-----------|---------------------|-------------------------------------------------|
| `--background`   | `#E8E6DE` | `43 16% 89%`        | App canvas (warm cream)                         |
| `--foreground`   | `#5B5A52` | `53 5% 34%`         | Body text (warm gray — never `#000`)            |
| `--primary`      | `#2C4D40` | `156 27% 24%`       | Deep forest green — CSR Ask button, brand mark  |
| `--accent`       | `#39594D` | `159 22% 29%`       | Lighter forest — links, accent surfaces         |
| `--secondary`    | `#FAFAFA` | `0 0% 98%`          | Whisper-button surface                          |
| `--border`       | `~#E0E0E0`| `40 8% 88%`         | Hairline (warm-tinted)                          |
| `--ring`         | `#2C4D40` | `156 27% 24%`       | Focus ring                                      |
| *(unscoped)*     | `#2D4CB9` | `226 62% 45%`       | Secondary blue — code highlights, sparing only  |

Light mode is the ship target. `.dark` ships as a sensible inversion so consumers don't break; the product does not surface a dark-mode toggle in Phase 1.

## Typography

Single sans for everything. **Verdana** as the primary face — system font, no network load, ships everywhere. No serif, no display face, no hero typography. (Cohere parity on rhythm and scale, not on specific letterforms; revisit faces in a later phase.)

| Token | Size  | Use                                   |
|-------|-------|---------------------------------------|
| `h1`  | 24px  | Page title, one per surface           |
| `h2`  | 20px  | Section heading                       |
| body  | 16px  | Default — paragraphs, controls, table |
| small | 14px  | Captions, metadata                    |
| micro | 12px  | Citation chips, role badges           |

Line-height: **1.5** on CSR chat (dense, scannable). **1.6** on admin surfaces (airier read).
Weights: 400 (body), 500 (UI labels), 600 (headings). No 700+ in Phase 1.

## Spacing

Base unit **4px**. Use multiples: `4, 8, 12, 16, 24, 32, 48, 64`. No arbitrary values.

## Radius

`--radius: 0.5rem` (8px). Shadcn's `lg / md / sm` derive from this — leave them alone.

## Borders & elevation

Hairline 1px **inset shadows** in place of conventional borders where possible. Cohere's surfaces lift via shadow, not chrome.

```css
/* whisper button surface */
box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
```

## Buttons

Two variants. That's it.

### Whisper (default — everywhere)

Background `#FAFAFA`, text `#5B5A52`, 1px inset hairline shadow. No fill color, no drop shadow. Hover: shadow strengthens to ~0.10 alpha. This is the app-wide default.

### CSR Ask — the one deliberate exception

The primary "Ask" button on `/chat`. **Forest-green filled** (`#2C4D40` background, white text). CSRs find it instantly under call pressure. Do not propagate this style anywhere else; the contrast is the point.

## Density

| Surface              | Line-height | Padding rhythm        | Sidebar    |
|----------------------|-------------|-----------------------|------------|
| CSR chat (`/chat`)   | 1.5         | tight (8/12px)        | compact    |
| Admin (`/admin/*`)   | 1.6         | airy (16/24px)        | full       |

Citation cards on CSR chat get extra room — they're the receipt, not the chrome.

## Motion

Easing: **`cubic-bezier(0.25, 1, 0.5, 1)`** (ease-out-quart). No bounce, no overshoot.
Durations: micro-interaction `120ms`, layout shifts `240ms`. Never animate color on hover for more than `120ms`.
Reduced motion: honor `prefers-reduced-motion` everywhere; fall back to opacity-only crossfades.

## Token consumer contract

Shadcn components consume `hsl(var(--token))` via `tailwind.config.ts`. Variable names are stable across Phase 1 — only values change. Adding a token is a Phase-2-or-later conversation.

## Follow-ups

- **OKLCH migration.** Same names, broader gamut, more predictable lightness. Update `:root` and `.dark` values, swap the wrappers in `tailwind.config.ts` and `index.css` from `hsl()` to `oklch()`. No component changes.
- **Phase 2 illustration system.** Organic blob shapes in the Cohere-illustration style. Asset work, not token work.
