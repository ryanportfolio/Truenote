# Build and refine

Use for implementation, redesign, adaptation, hardening, and polish.

## 1. Inspect before choosing

Read the target and enough neighboring code to answer:

- What task is the person completing, under what time pressure?
- Which existing component, class, token, or flow already solves something similar?
- Which routes, role checks, API contracts, focus paths, tests, and persistent state are protected?
- What are the shortest, typical, longest, empty, loading, error, permission, and stale-data cases?
- Is the problem functional, structural, visual, or merely cosmetic?

For existing UI, record mentally or briefly:

```text
Mode: extension | preserve | overhaul
Surface: CSR | admin | knowledge base | auth/brand
Preserve:
Improve:
Protected contracts:
Highest-risk change:
Verification:
```

Do not manufacture a new aesthetic direction. `PRODUCT.md` and `DESIGN.md` already settled it.

## 2. Choose the smallest causal change

Apply levers in this order, stopping when the request is satisfied:

1. Fix functional and accessibility failure.
2. Repair information hierarchy, semantics, and task order.
3. Normalize spacing, alignment, wrapping, and responsive behavior.
4. Replace rogue values with existing tokens/classes.
5. Complete missing interaction and async states.
6. Add justified motion.
7. Change shared primitives or page composition only when local repair cannot solve the cause.

Do not turn polish into redesign. Do not “clean up” unrelated surfaces.

## 3. Design from task and evidence

- CSR work optimizes the one-handed ask → scan → verify source → return path. Evidence is part of the answer, not a footnote.
- Admin work optimizes upload, scope, inspect, correct, and verify. Density may relax, but hierarchy stays operational.
- Knowledge-base work optimizes orientation, reading measure, source identity, highlighting, and return paths.
- Auth/brand work may use the Luminous Archive vocabulary. Keep expressive assets out of authenticated task chrome unless `DESIGN.md` explicitly permits them.
- Structure must encode real meaning. Avoid ornamental eyebrows, fake sequence numbers, decorative metrics, and cardification.
- Spend visual emphasis once. The primary task, active state, or evidence moment gets it; surrounding UI stays quiet.
- Write from the user's side: specific verbs, stable nouns, sentence case, no filler. Errors state what happened and the recovery path. Empty states teach the next action.

## 4. Implement natively

- Follow current project file structure and local component style; do not impose a generic folder architecture.
- Prefer existing `btn-*`, status, table, alert, empty-state, shell, and typography recipes.
- Use Lucide consistently and mark decorative icons `aria-hidden`. Icon-only controls need an accessible name.
- Use `<button>` for actions and Wouter `<Link>` for navigation. Preserve Cmd/Ctrl-click behavior.
- Keep form labels visible and associated. Use meaningful `name`, correct `type`, appropriate `autocomplete`, inline errors, `aria-invalid`, and focus the first invalid field when useful.
- Async actions expose pending state without erasing user input. Dynamic status uses an appropriate live region without stealing focus.
- Destructive actions use the existing confirmation flow or a safer undo pattern. Restore focus after overlays close.
- Prefer wrapping and reflow over truncation. If truncation is necessary, preserve access to the full value.
- Product-owned tables adapt columns/content at narrow widths; irreducible user-authored tables and code may scroll locally. Do not create page-level horizontal overflow.
- Keep fixed/sticky UI from obscuring content. Preserve safe keyboard access and scroll position.

## 5. States and responsive proof

Exercise only relevant states, but never assume the happy path is enough:

- default, hover, focus-visible, active, disabled;
- loading/pending, empty, populated, error, retry, success;
- missing/long titles, long excerpts, many rows, narrow program names;
- unauthorized/permission-limited and cross-program-not-found presentation;
- reduced motion and 200% zoom/reflow.

When browser verification is possible, choose viewports from the actual risk. Useful defaults when unspecified: 390×844, 768×1024, 1280×720, and 1440×900. Do not mechanically test all four for a tiny isolated change.

## 6. Performance restraint

- Preserve route lazy-loading and intent preload patterns.
- Reserve media dimensions and lazy-load only below-fold media.
- Avoid broad state updates during scroll/pointer frames, layout reads during render, and casual blur/filter/shadow expansion.
- Animate transform/opacity where possible. Do not add `transition: all`.
- Do not add memoization, virtualization, or dependencies without measured or structurally obvious need.

## 7. Completion

Before declaring done:

- Compare result to `PRODUCT.md` and the exact relevant `DESIGN.md` sections.
- Confirm no second primary action, rogue token, new visual vocabulary, fabricated content, or weakened product contract appeared.
- Run targeted tests and required repository checks.
- Report browser evidence only if actually gathered.
