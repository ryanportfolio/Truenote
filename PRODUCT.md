# Truenote

> Product brief. Strategic register, not visual specs. For visual tokens see [DESIGN.md](./DESIGN.md). For engineering kernel see [CLAUDE.md](./CLAUDE.md).

## Register

`product`

## Who uses Truenote

**Customer Service Reps (CSRs).** Mid-call, on the phone, scanning. They ask Truenote a question while a caller is talking and need a defensible answer in seconds. They are not browsing — they are looking up. Wrong answers cost the caller money, the rep their AHT, and the program its credibility.

**Admins (program managers, ops leads).** Off-call, deliberate. They upload SOPs, screenshots, policy PDFs, tables. They scope content to programs and curate what CSRs see. Their interaction with Truenote is mostly upload + verify, not chat.

## What Truenote does

A retrieval-augmented knowledge assistant for call-center CSRs. Admins load the source-of-truth; CSRs query it during calls and get cited, verifiable answers — or an explicit refusal. Program scoping is a security boundary, not a UX nicety. Every answer either points to a real excerpt the CSR can click and re-read, or it tells the CSR it doesn't know. There is no middle ground.

## Brand personality (three words)

**Calm. Precise. Cited.**

## Design principles

These are strategic, not visual. Visual rules live in DESIGN.md.

1. **Show the receipt.** Every claim points to its source. The citation is part of the answer, not a footnote. If we can't cite it, we don't say it.
2. **Calm under pressure.** The CSR is already stressed; the interface should not add noise, motion, or color it doesn't earn. Surfaces whisper unless they need to be heard.
3. **Refusal is a feature.** "I couldn't find this" is a successful response — far better than a confident hallucination. The UI should make refusal feel intentional, not like a failure mode.
4. **Density matches the moment.** CSR surfaces are dense and scannable — built for one-handed lookups under call pressure. Admin surfaces are airy and deliberate — built for slow, considered curation.
5. **Trust accrues.** The product is the long-term reputation of its answers. Every shortcut that produces a slightly-wrong answer trades trust we won't get back.

## Anti-references (explicitly NOT this)

- Not ChatGPT chat-bubble UI — Truenote is a lookup tool, not a conversation toy.
- Not Notion clutter — no sidebars of nested rabbit holes.
- Not Salesforce enterprise gray — warmth and clarity, not corporate dread.
- Not Slack-style notification noise — no badges, dots, or chimes competing for attention.

## Accessibility

Target **WCAG 2.1 AAA for body text** (≥7:1 contrast) and **AA minimum for everything else** (chrome, captions, placeholders, role chips). Color is never the sole channel; focus rings are visible at 2px with offset; tab order is sane; CSR chat is operable from keyboard for the entire ask → read → cite-click → return flow. Anything a CSR has to *read mid-call* hits AAA — eyestrain compounds across an 8-hour shift.

---

*Illustration direction: The Luminous Archive, layered paper and translucent mineral forms gathering around a dense evidence core, supported by the living BrandField watercolor on auth surfaces. Use both for rare brand moments and purposeful retrieval states, never as decorative noise across task surfaces.*
