# jj workspace health inventory (`kanban jj doctor`)

`kanban jj doctor` reports registered jj workspaces and visible heads, and reconciles `kanban-<task>` workspaces with the Kanban board. It is diagnostic only: it never updates, forgets, rebases, or repairs a workspace.

```text
kanban jj doctor [--project-path <path>]
```

The command prints JSON. It exits nonzero only when `ok` is `false` and no complete report could be produced (for example, the path is not a jj repository or workspace enumeration failed). `healthy: false` is report data, not a process failure.

## Read-only behavior

All repository-state jj calls use `--ignore-working-copy`. This prevents jj from snapshotting a working copy during inspection. The integration test verifies that repeated inspection leaves both the operation head and operation count unchanged. The version query is repository-independent and does not inspect repository state.

Kanban state is loaded with auto-creation disabled. If the repository is not registered, board reconciliation is omitted and recorded in `gaps` rather than creating storage state.

## Report

- `ok`, `reason`: whether a report was produced.
- `repoPath`, `vcs`, `jjVersion`, `boardConnected`, `healthy`.
- `workspaces`: registered workspace identity, target flags, expected Kanban path, board ownership, and classification.
- `heads`: visible heads and the workspace owning the same commit, if any.
- `issues`: actionable states such as missing paths, conflicts, divergence, hidden targets, and unowned empty task workspaces.
- `gaps`: limitations or incomplete reads. Incomplete workspace-row or head parsing makes `healthy` false. Ordinary limitations—such as unavailable board reconciliation or inability to prove per-workspace staleness from repository-level reads—do not by themselves make the report unhealthy.

Task workspace classifications are `active`, `completed`, `stale-empty`, `orphaned`, or `unknown`. The main workspace is `default`; non-Kanban workspace names are `unowned`.

The inventory cannot reliably prove per-workspace staleness without entering individual workspaces, so it does not guess or mutate them. Foreign workspace paths are also not inferred from Kanban conventions.
