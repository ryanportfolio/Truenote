# Audit Truenote UI

Use for code-level UI review, UX critique, accessibility checks, and design-system compliance. Do not edit unless fixes are requested.

## Evidence order

1. User-stated acceptance criteria
2. `CLAUDE.md`, `PRODUCT.md`, and `DESIGN.md`
3. Target implementation, callers, shared primitives, and tests
4. Rendered behavior/screenshots when a runnable browser is available
5. General interface guidance only where project sources are silent

Never flag a deliberate Truenote rule merely because another design system prefers something else.

## Audit passes

### Product contracts

- CSR answers cannot render naked: clickable citation(s) or explicit refusal.
- Evidence remains identifiable, reachable, and usable by keyboard.
- Refusal is calm and useful, with a recovery path where one exists.
- Role/program UI does not weaken or misrepresent server-side authorization.
- Routes, deep links, selection ownership, and protected flows remain stable.

### Task and hierarchy

- Primary user action is obvious without competing filled actions.
- CSR surfaces optimize rapid scanning; admin surfaces support deliberate verification.
- Labels and terminology match neighboring flows and user language.
- Containers group real concepts; cards, badges, icons, and decoration earn their place.
- Dense information remains grouped and scannable instead of becoming spacious marketing UI.

### Accessibility

- Semantic landmarks, headings, controls, tables, lists, and links are used correctly.
- Every control has an accessible name; decorative icons/images are hidden appropriately.
- Keyboard order is logical; focus is visible; overlays manage and restore focus; no trap remains.
- Form labels, instructions, autofill, validation linkage, error summaries, and recovery are coherent.
- Async changes are announced at the correct urgency without duplicate announcements or focus theft.
- Color is not the sole signal. Apply Truenote's AAA/AA contrast targets, not a generic AA-only floor.
- Zoom/reflow, touch targets, pointer alternatives, and reduced-motion behavior preserve task completion.

### Responsive and content resilience

- No page-level horizontal overflow, clipped controls, unreachable actions, or obscured content.
- Long titles, excerpts, email addresses, program names, tables, and user-authored markdown behave safely.
- Sidebar, top bar, panels, sticky composer, tables, and auth surfaces follow `DESIGN.md`.
- Layout uses CSS rather than JavaScript breakpoint state.

### Visual-system integrity

- Semantic tokens, documented spacing, radius grammar, shadows, typography roles, and motion vocabulary are followed.
- No raw Tailwind status palette, arbitrary pixel values, unapproved font, rogue hue, random shadow, or new radius family.
- Existing primitives are reused; repeated one-offs indicate a missing shared primitive only when duplication is proven.
- Brand-blue and expressive Luminous Archive moments remain rare and purposeful.
- No generic AI defaults: repeated card grids, decorative gradients, side-stripe callouts, fake metrics, glass decoration, or motion spectacle.

### States, copy, and performance

- Relevant loading, empty, error, success, disabled, permission, overflow, and retry states exist.
- Copy is specific, concise, stable across action/result, and gives a next step on failure.
- No layout-property animation, `transition: all`, unnecessary eager media, broad scroll-frame state updates, or avoidable route/bundle regression.
- Do not recommend memoization, virtualization, or a new package without evidence.

## Severity

- **P0**: security boundary or citation/refusal contract violated; task impossible.
- **P1**: major task failure, WCAG failure affecting completion, data loss risk, broken responsive/keyboard path.
- **P2**: meaningful friction, inconsistency, missing state, or maintainability drift with a workaround.
- **P3**: bounded polish issue. Omit speculative or low-confidence P3 noise.

## Output

Lead with findings, ordered by severity. Use exact `file:line` locations and explain user impact plus smallest causal remedy. Group repeated instances under one systemic finding. Include positive findings only when they materially protect a good pattern.

If nothing actionable exists, say so plainly and name verification limits. Distinguish:

- code inspection;
- automated tests/checks;
- rendered browser acceptance;
- unverified Replit/runtime behavior.

Never convert taste preference into a defect without grounding it in product intent, design-system drift, task performance, or accessibility.
