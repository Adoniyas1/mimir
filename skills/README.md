# Skills

Hot-reloadable capability modules Mimir writes for itself via the
`propose_edit` tool with `tier: "skill"`. Each skill applies immediately
after a fast typecheck — no restart, no approval gate (unlike `tier: "core"`
edits to `src/main`/`src/renderer`).

See `src/main/self-edit/tools.ts` for how these get proposed and applied,
and `src/main/self-edit/verifyPresets.ts` for the gate they have to pass.
