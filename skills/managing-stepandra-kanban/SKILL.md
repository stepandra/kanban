---
name: managing-stepandra-kanban
description: "Manages tasks, dependencies, jj task workspaces, execution, review, and acceptance with the installed stepandra/kanban fork of cline/kanban. Use whenever Kanban cards, kanban_tasks, task preparation, task submission, or the Kanban board are mentioned."
license: Apache-2.0
compatibility: Requires the local stepandra/kanban CLI and its Amp plugin; interactive agents additionally require the zj-agent Zellij controller.
metadata:
  repository: https://github.com/stepandra/kanban
  upstream: https://github.com/cline/kanban
---

# Managing stepandra/kanban

In this environment, **Kanban always means [`stepandra/kanban`](https://github.com/stepandra/kanban), the installed fork of `cline/kanban`**. It does not mean Hermes and it does not mean the unmodified `cline/kanban` upstream.

## Ownership contract

- `kanban_tasks` and the local `kanban` CLI own durable task, dependency, task-workspace, review, and acceptance state.
- Zellij and `zj-agent` own only ephemeral interactive pane lifecycle and launch metadata.
- Terminal output, process exit, controller state, and cockpit indicators never complete or accept a task.
- In a jj repository, task preparation creates a jj workspace/change. Do not describe it as a Git worktree.

## Lifecycle

1. Create concrete tasks with `kanban_tasks`; link only real prerequisites.
2. Start an assigned interactive task with `kanban_tasks action=start`. The plugin prepares and claims its task workspace before handing Codex, Claude, Grok, or Kimi to `zj-agent controller spawn`.
3. The worker implements only the bounded brief and runs focused validation.
4. The worker submits with the exact injected `kanban task submit` command. That moves the task to Review and automatically runs `zj-agent review-handoff`, which queues one isolated `ar-fixer-<task-id>` Amp thread; the worker does not accept the task.
5. The handoff and `kanban task list` expose the exact `taskWorkspacePath`; the project path is only the board scope. The isolated Fixer process starts from the project path so Amp resolves the correct Kanban board, passes that explicit `projectPath` to every `kanban_tasks` call, and targets every code read, edit, jj command, and test at the exact task workspace. It inspects the jj diff and evidence, repairs in-scope defects, isolates the task revision from unrelated parent changes, verifies it, commits it, and pushes it to the existing expected remote/ref. Prefer a task-specific bookmark when moving a shared base would race parallel work. Only after the remote ref resolves to the verified commit does Fixer use `kanban_tasks action=done` to accept. Acceptance may release the ephemeral Zellij lane and unblock dependants.

## Guardrails

- `list` is read-only. Every other `kanban_tasks` action mutates durable board state and needs explicit user execution intent.
- Workers never call `done`, accept their own work, push, squash, abandon, or rewrite shared history.
- Fixer never force-pushes, changes remotes, mixes unrelated changes, or marks a task done before its verified commit is reachable on the expected remote.
- A Review transition must use submit's built-in isolated handoff. At most two Fixers execute concurrently; additional cards remain queued in Review. Runner state is telemetry, never task truth. If enqueue fails, leave the task in Review and surface `reviewHandoff.ok=false`; never silently reroute it or accept it.
- Do not mirror tasks into Hermes or another board.
- Do not run ordinary `kanban task start` for cockpit work; it starts Kanban's own local executor. Use `kanban_tasks action=start` so workspace preparation and controller handoff stay coordinated.
- Do not use `npx kanban`; it can resolve the wrong package. Use the installed fork binary or set `KANBAN_BIN` explicitly.
- Interactive lane agents are `codex`, `claude`, `grok`, and `kimi`. Amp work uses `agentId=amp` and an Orb.
- The cockpit is a shared host, not one CI machine per worker. Start with exact affected tests and cap Vitest at two workers. Run a package-wide suite or production build at most once after focused checks pass; do not let several workers repeatedly saturate the host with the same broad check.

## Local identity checks

```sh
git -C ~/dev/kanban remote get-url origin
readlink ~/.config/amp/plugins/kanban.ts
```

The expected remote is `https://github.com/stepandra/kanban.git`, and the global plugin must resolve to `~/dev/kanban/amp/kanban.ts`.
