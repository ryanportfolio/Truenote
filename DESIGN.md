# Truenote — Design System

> Visual tokens for Phase 1. Strategic register and design principles live in [PRODUCT.md](./PRODUCT.md). This file is tokens, not philosophy.

Phase 1 keeps HSL because shadcn's `hsl(var(--token))` wrappers already consume it across the app. OKLCH migration is a follow-up — same variable names, same consumers, just swap the color space and update the wrapper.

## Palette

Cohere-derived rhythm (warm cream surface, warm-near-black text, hairline borders) with the **parent company's brand blue** as the accent. The deep blue is sourced from the corporate logo's gradient stop and darkened to clear WCAG AAA both ways. Forest-green was the Phase 1 placeholder; brand-blue is the production accent.

| Token            | Hex       | HSL                 | Role                                            |
|------------------|-----------|---------------------|-------------------------------------------------|
| `--background`   | `#E8E6DE` | `43 16% 89%`        | App canvas (warm cream)                         |
| `--foreground`   | `~#363430`| `53 7% 22%`         | Body text (warm near-black — never `#000`). AAA on bg (~7.9:1) |
| `--primary`      | `~#0040AB`| `217 100% 33%`      | Deep brand blue — CSR Ask button, brand mark. AAA on cream (~7:1) and white-on-primary (~9:1) |
| `--accent`       | `~#005DE5`| `213 100% 45%`      | Vivid brand blue — hover, citation tints (sparingly). AA on cream |
| `--secondary`    | `#FAFAFA` | `0 0% 98%`          | Whisper-button surface                          |
| `--border`       | `~#E0E0E0`| `40 8% 88%`         | Hairline (warm-tinted)                          |
| `--ring`         | `~#0040AB`| `217 100% 33%`      | Focus ring (matches primary)                    |

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

## Contrast (WCAG)

| Pairing                                  | Target | Computed | Status |
|------------------------------------------|--------|----------|--------|
| `--foreground` on `--background`         | AAA    | ~7.9:1   | ✓      |
| `--foreground` on `--card` (white)       | AAA    | ~12:1    | ✓      |
| `--muted-foreground` on `--background`   | AA     | ~5.5:1   | ✓      |
| `--primary-foreground` on `--primary`    | AAA    | ~10:1    | ✓      |
| `--accent-foreground` on `--accent`      | AAA    | ~8:1     | ✓      |

Rules:
- Body text and anything a CSR reads mid-call hit **AAA** (≥7:1).
- Chrome (captions, placeholder hints, role chips, table headers) hits **AA** (≥4.5:1).
- **Force `::placeholder { opacity: 1 }`** globally — browsers default to ~0.5, which silently halves contrast and pushes placeholders below AA on any non-white surface.
- Never use `#000` or `#fff` directly. Warm near-black for text; cream/white for surfaces. Pure black on cream reads as a UI bug, not as polish.
- When darkening a token to meet AAA, re-run the math; do not eyeball.

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

The primary "Ask" button on `/chat`. **Brand-blue filled** (`--primary` background ~`#0040AB`, white text). CSRs find it instantly under call pressure. Hover shifts to the vivid `--accent` (~`#005DE5`) — vibrancy reserved for the moment of intent. Do not propagate this style anywhere else; the contrast is the point.

## Density

| Surface              | Line-height | Padding rhythm        | Sidebar    |
|----------------------|-------------|-----------------------|------------|
| CSR chat (`/chat`)   | 1.5         | tight (8/12px)        | compact    |
| Admin (`/admin/*`)   | 1.6         | airy (16/24px)        | full       |

Citation cards on CSR chat get extra room — they're the receipt, not the chrome.

## Interaction states

Every interactive element defines five states. Color alone is never the focus signal.

| State    | Visual change                                                                |
|----------|------------------------------------------------------------------------------|
| Default  | Base token values                                                            |
| Hover    | Whisper: hairline strengthens. CSR-Ask: bg shifts to `--accent`              |
| Focus    | 2px `--ring` outline, 2px offset (`focus-visible:ring-2 ring-offset-2`)      |
| Active   | Whisper: bg → `--muted`. CSR-Ask: bg darkens to `--primary/92`               |
| Disabled | `opacity: 0.5`, `cursor: not-allowed`, hover changes suppressed              |

**Selected state** (sidebar item, active tab): `bg-secondary text-secondary-foreground` (existing pattern — keep).

## Motion

Easing: **`cubic-bezier(0.25, 1, 0.5, 1)`** (ease-out-quart). No bounce, no overshoot.
Durations: micro-interaction `120ms`, layout shifts `240ms`. Never animate color on hover for more than `120ms`.
Reduced motion: honor `prefers-reduced-motion` everywhere; fall back to opacity-only crossfades.

## Token consumer contract

Shadcn components consume `hsl(var(--token))` via `tailwind.config.ts`. Variable names are stable across Phase 1 — only values change. Adding a token is a Phase-2-or-later conversation.

## Dark mode

Ships as a sensible inversion so shadcn consumers don't break. No theme toggle in Phase 1. When it does land:

- **No pure black backgrounds.** Use a near-black with the brand-blue hue baked in (current: `217 12% 10%`).
- **No pure white text.** Cream foreground (`43 16% 89%`) reads warmer and reduces halation on dark surfaces.
- Re-run contrast math against dark tokens — current `muted-foreground` is ~6.9:1 on the dark bg, close to AAA but not over.

## What makes Truenote feel like Truenote

If we only get five things right, get these. These are the brand-character version of Cohere's essence points, translated to our tokens.

1. **The brand-blue accent is rare.** `--primary` shows up once or twice per screen — the CSR Ask button, the active citation chip. Everywhere else is cream/white/warm-near-black. The restraint is what makes the blue feel branded; spray it everywhere and it's just another corporate-tool blue.
2. **Hairlines over shadows.** Cards, tables, callouts, sidebars — every division is a 1px inset hairline (`--border`), not a drop shadow. Reserve drop shadow for floating elements only (popovers, modals).
3. **Warm neutrals.** The gray is tinted toward stone, not slate. If a contributor reaches for `slate-*` / `zinc-*` / `gray-*`, that is a bug — use the semantic tokens.
4. **Generous whitespace on admin, tight density on CSR chat.** Admin surfaces breathe like Cohere docs. CSR chat is denser by intent — CSRs scan under call pressure, not browse.
5. **Tight headings, relaxed body.** Headings 600 weight, slight negative tracking. Body 400 weight, line-height 1.5 (chat) / 1.6 (admin). The contrast between tight headings and loose body is the typographic signature.

## Follow-ups

- **OKLCH migration.** Same names, broader gamut, more predictable lightness. Update `:root` and `.dark` values, swap the wrappers in `tailwind.config.ts` and `index.css` from `hsl()` to `oklch()`. No component changes.
- **Phase 2 illustration system.** Organic blob shapes in the Cohere-illustration style. Asset work, not token work.
