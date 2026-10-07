# Skill Provenance

Where each skill came from, its license, and what this repo changed. Not loaded
into context; it is reference for maintainers and public users. It lists the
folders under `.claude/skills/` plus the Codex-only skills under `.agents/skills/`.

**License terms:** third-party material keeps its own license: the LICENSE or
NOTICE file in its skill folder. Homegrown skills are MIT, same as the
Harness-Firmware template (see its [`LICENSE`](https://github.com/ryanportfolio/Harness-Firmware/blob/main/LICENSE)).

**Maintenance rule:** when you materially change a forked skill, update its
"Our deltas" cell here. When adding a third-party skill, add a row and keep its
LICENSE/NOTICE files in the skill folder. When adding or deleting a skill
folder, update this file in the same change.

## Forked / third-party

| Skill | Upstream | License | Our deltas |
|---|---|---|---|
| `brainstorming` | [obra/superpowers](https://github.com/obra/superpowers) (Jesse Vincent) | MIT (in folder) | Two-lane scope calibration, authorization-safe artifacts, optional visual companion. Turned off here (`skillOverrides`). |
| `writing-plans` | obra/superpowers | MIT (in folder) | Stock. Turned off here (`skillOverrides`). |
| `writing-skills` (retired entrypoint) | obra/superpowers | MIT (in folder) | SKILL.md retired; legacy manuals, examples and scripts kept outside discovery. Authoring guidance moved into `addskill`. |
| `addskill` authoring resource | obra/superpowers writing-skills | MIT (`references/LICENSE` in both runtime folders) | Discovery, structure and behavioral evaluation guidance adapted into optional local authoring references; the end-to-end addskill workflow is homegrown. |
| `caveman` | Community token-compression pattern (viral skill, author attribution unclear) | Reimplemented here | Intensity tiers, clarity carve-outs, persistence and built-in session cleanup. |
| `caveman` `references/diff-cleanup.md` | Concept from [cursor/plugins `cursor-team-kit`](https://github.com/cursor/plugins/tree/b42effe/cursor-team-kit) `deslop` (Cursor; MIT); no text vendored | Reimplemented here | Removes only justified noise from a requested diff, keeps defensive code and caveats, and sends prose inside the diff to `writing`. |
| `writing` | Wikipedia "Signs of AI writing" tell catalog (CC BY-SA 4.0); `unslop` in [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan, MIT); others named in `NOTICE.md` | Notices in `NOTICE.md` and MIT `LICENSE` in both runtime folders; our text MIT | Consolidated outward-facing prose and explicit cleanup. Ordinary chat uses Caveman. |
| `refine` | Concept from [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) Continual Harness `/refine` (MIT); preference-evidence rules from pstack `automate-me` (Lauren Tan; MIT) and cursor-team-kit `workflow-from-chats` (Cursor; MIT); no code or text vendored | Reimplemented here | Cause-specific diagnosis, narrow scope, static validation for nonbehavioral fixes and baseline/candidate evaluation for material changes; delegates to recall and addskill. |
| `long-horizon` | Concept from [AMAP-ML/LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness) (MIT); no code or text vendored | Reimplemented here | Durable manager/executor/auditor rounds, frozen pre-dispatch audit brief, fresh-context audits and a final integrated audit. |
| `long-horizon-workflows` | Concept via this repo's `long-horizon`; no code or text vendored | Reimplemented here | Claude-only. Carries the `long-horizon` contract and runs each round as one `Workflow` tool script. |
| `bro` | Concept from cursor/plugins pstack `bro` (Lauren Tan; MIT); no text vendored | Reimplemented here | Opens with what the user must do or decide and keeps every fact and caveat. |
| `babysit-ci` | Concept from cursor-team-kit `loop-on-ci`, `fix-ci`, and the `ci-watcher` agent (Cursor; MIT); no text vendored | Reimplemented here | Separate watch and fix modes, `gh pr checks` as the source of truth, and a stop after three fix pushes. |
| `fable-mode` verification (claim classes, verdict words) | Concept from cursor-team-kit `verify-this` (Cursor; MIT); no text vendored | Reimplemented here | Current-state, change, and cause claims each get their own evidence bar and end in VERIFIED, NOT VERIFIED, or INCONCLUSIVE. |
| `wow-loop` browser rules | Concept from cursor-team-kit `control-ui` (Cursor; MIT); no text vendored | Reimplemented here | Travel in every page-driving subagent brief: headed Chrome through a placed-window launcher if present, else offscreen, one browser per session. |
| `arena` | Concept from pstack `arena` (Lauren Tan; MIT); no text vendored | Reimplemented here | Cross-vendor candidate and blind judge by default, one worktree or folder per candidate, parent rescoring against checkable criteria. |

The `evidence-report.md` references in `perf-loop` and `wow-loop`, and the
`shared-code-refactoring.md` references in `impartial-review` and the Codex-only
`external-review`, use concept-only inspiration from
[`michaelshimeles/skills` at `513f8a24aae6383b00356fa285144b1bc3730dc1`](https://github.com/michaelshimeles/skills/tree/513f8a24aae6383b00356fa285144b1bc3730dc1),
in original wording. No upstream source text was copied.

## Homegrown

`addskill`, `adopt-repo`, `advocate`, `astra-fullreview`, `astra-review`,
`claude-review`, `codex-fullreview`, `codex-review`, `dare`, `deep-plan`,
`design-truenote-ui`, `enhance-prompt`, `fable-mode`, `forge-repo-ui-skill`,
`handoff-audit`, `impartial-review`, `init-project`, `lab`, `merge`,
`optimize-context`, `perf-loop`, `recall`, `review-security-posture`, `servers`,
`session-hub`, `showpiece`, `sync-starter`, `why`, `wow-loop`, `wrapup`.

Codex-only (no `.claude/skills/` folder): `external-review`, `opus-fullreview`.

`design-truenote-ui` and `review-security-posture` are this repository's own
skills; the rest come from the Harness-Firmware template. `design-truenote-ui`
replaces the former third-party `impeccable` bundle with an original,
repo-specific synthesis. Its `NOTICE.md` records the public design skills
reviewed; no upstream scripts, datasets, templates, or catalogs are vendored.

`forge-repo-ui-skill` is an original synthesis workflow. It researches linked
third-party sources as untrusted inputs but does not vendor their skill text,
scripts, datasets, licenses, or configuration.

Runtime coverage follows `.agents/skill-modes.json` and `.claude/settings.json`:
`astra-fullreview`, `codex-fullreview`, `long-horizon-workflows` and `merge` are
Claude-only; `brainstorming`, `lab` and `writing-plans` are turned off in both
runtimes; every other skill ships in both.
