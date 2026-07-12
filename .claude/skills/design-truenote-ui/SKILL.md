---
name: design-truenote-ui
description: Design, implement, review, or polish Truenote's React frontend. Use for any user-facing change under artifacts/rag-app involving pages, components, layout, visual hierarchy, UX copy, forms, tables, navigation, responsiveness, motion, accessibility, loading/empty/error states, or design-system compliance. Enforces PRODUCT.md, DESIGN.md, citation/refusal presentation, CSR-versus-admin density, and the existing React/Vite/Tailwind v3 stack. Not for backend-only work.
---

# Design Truenote UI

Build calm, precise, cited product UI. Design serves mid-call lookup and deliberate knowledge curation; it never becomes a generic showcase.

## Authority

Resolve conflicts in this order:

1. Current user request
2. `CLAUDE.md` product non-negotiables and runtime rules
3. `PRODUCT.md` strategy, users, voice, and anti-references
4. `DESIGN.md` shipped visual and interaction system
5. Existing code, shared primitives, and nearby tests
6. This workflow

Never silently override a higher-authority contract. Ask only when a material conflict remains after inspection.

## Preflight

Before UI analysis or edits:

1. Read `PRODUCT.md` and `DESIGN.md` completely. If either is missing or placeholder, stop and report it.
2. Inspect the target route/component, its callers, adjacent comparable surfaces, relevant styles, and tests.
3. Confirm the actual stack from `artifacts/rag-app/package.json`: React, TypeScript, Vite, Tailwind v3, Wouter, Lucide. Do not assume shadcn, Radix, Motion, Tailwind v4, Next.js, or another library.
4. Classify change mode:
   - **Extension**: bounded change; match current vocabulary exactly.
   - **Preserve redesign**: improve hierarchy or flow while retaining identity and contracts.
   - **Overhaul**: new visual language or interaction model. Requires explicit user approval.
5. Classify surface:
   - **CSR**: dense, keyboard-efficient, evidence-forward, AAA reading contrast.
   - **Admin**: deliberate, roomier, verification-forward.
   - **Knowledge base**: readable source material and durable orientation.
   - **Auth/brand**: rare expressive surface; must remain fast and accessible.

For an extension or clear repair, proceed without ceremony. Before changing tokens, navigation, information architecture, shared component APIs, core interaction models, or signature brand assets, present a compact brief covering `preserve`, `change`, `protected contracts`, and `verification`, then wait for approval.

## Product contracts

Treat these as release blockers:

- A CSR-facing answer has at least one clickable citation or is an explicit refusal.
- Citation evidence remains easy to inspect and return from by keyboard.
- Refusal looks intentional, calm, and non-destructive.
- Program scoping remains server-enforced; UI changes never imply that client state is authorization.
- Role-aware navigation and protected routes remain intact.
- Existing real copy/data beats invented content. Never fabricate claims, metrics, testimonials, or source material.
- The ask-to-answer path stays faster and visually quieter than secondary features.

## Work routing

- **Build, change, redesign, adapt, harden, or polish**: read [references/build.md](references/build.md) completely and follow it.
- **Review, critique, accessibility check, UX audit, or design-system check**: read [references/audit.md](references/audit.md) completely and follow it. Diagnose only unless the user also requests fixes.
- A task containing both starts with the audit, then applies the smallest causal fixes through the build workflow.

## Always enforce

- Consume existing semantic tokens and documented component recipes. Do not invent raw colors, arbitrary spacing, new radii, shadows, fonts, or motion curves.
- Reuse existing primitives before creating another. A new primitive must solve repeated, proven duplication.
- Preserve routes, labels, form contracts, focus behavior, persistent-state keys, analytics/test hooks, accessibility wins, and public component APIs unless the request requires change.
- Use semantic HTML before ARIA. All controls need accessible names, visible focus, correct keyboard behavior, and coherent focus movement.
- Color never carries meaning alone. CSR-readable content meets the stronger contrast target in `PRODUCT.md`/`DESIGN.md`.
- Cover realistic loading, empty, error, success, disabled, permission, overflow, and long-content states when relevant.
- Make responsive behavior structural. Prefer CSS Grid/Flexbox and content-driven breakpoints; never add JavaScript breakpoint state for layout.
- Motion communicates state, hierarchy, causality, or retrieval progress. Prefer CSS, transform, and opacity; honor reduced motion; add no decorative ambient motion to task surfaces.
- Keep one primary action per surface. Subordinate everything else using the documented whisper/icon patterns.
- No new runtime dependency unless the current stack cannot solve a demonstrated requirement and the user authorizes the Replit install path.

## Verification contract

Verify in proportion to the change:

1. Inspect the diff for contract, token, component, copy, and scope drift.
2. Run targeted tests plus the repository-required checks from `CLAUDE.md` when the environment supports them.
3. If a runnable UI and browser capability exist, exercise the affected route, keyboard path, relevant states, reduced motion, and narrow/wide viewports. Capture screenshots only when they help judge hierarchy or regression.
4. If runtime/browser verification is unavailable, say exactly what was verified and what remains for Replit or the user's environment. Never claim visual verification from code inspection.

Finish with the outcome, files changed, checks run, and remaining risk. Do not narrate every design thought.
