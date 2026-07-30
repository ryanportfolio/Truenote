# Codex Skill Compatibility

`.claude/skills/` remains Claude's source. An adapter exposes a workflow; it does not prove every runtime capability exists.

- **Native**: direct mapping.
- **Adapted**: Codex paths, approvals, or UI substitutions.
- **Capability-gated**: requires a currently exposed tool.
- **Claude-only**: no faithful Codex implementation.
- **Dangerous**: explicit authorization required for Git, deploy, migration, publish, or persistent side effects.

| Status | Skills |
|---|---|
| Native | `brainstorming`, `caveman`, `design-truenote-ui`, `enhance-prompt`, `handoff-audit`, `humanizer`, `purposeful-writing`, `recall`, `review-security-posture`, `writing-plans` |
| Adapted | `addskill`, `init-project`, `lab`, `optimize-context`, `sync-starter`, `writing-skills` |
| Capability-gated | `advocate`, `impartial-review`, `why` |
| Dangerous | `merge` |
| Claude-only | None in the starter source set. |

`advocate`, `impartial-review`, and `why` require fresh independent context; do not replace them with self-review and call it equivalent. `merge` becomes session-wide only after explicit `$merge` or an unambiguous auto-merge request. Current system, developer, sandbox, approval, and user instructions win. Resolve canonical resources from `.claude/skills/<name>/` and never claim a gated workflow ran unless its tools were used.
