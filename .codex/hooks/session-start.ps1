$ErrorActionPreference = "Stop"

@"
[AI Operating System]
- Read AGENTS.md.
- Caveman Ultra is the prose default without asking.
- Use RTK explicitly for supported noisy reads; there is no transparent rewrite.
- Do not inherit Claude automatic Git actions or execute its SessionStart hook.
- Verify capability-gated tools before starting.
"@ | Write-Output
