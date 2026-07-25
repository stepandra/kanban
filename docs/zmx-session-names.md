# zmx durable session-name contract

Interactive agent sessions launched through Kanban's terminal runtime may be
wrapped in durable [zmx](https://zmx.dev) sessions. This page is the **single
canonical specification** of the session-name format. It is referenced by:

- `src/terminal/zmx-agent-session.ts` — the generator (implementation of record).
- `zj-agent-harness/zellij/bin/kanban-zmx-view` — the external viewer that parses
  session names to find attachable sessions.
- `test/runtime/terminal/zmx-agent-session.test.ts` — loud-failure fixture tests
  pinning the exact format.

**Any change to the name format must update this document, the generator, the
fixture test, and the harness viewer together.** The fixture test asserts exact
names and fails loudly on drift.

## Format

```
kanban.<workspace>.<agent>.<task>.<sha256[:12]>
```

Five dot-separated parts:

| Part           | Source                                                        |
| -------------- | ------------------------------------------------------------- |
| `kanban`       | Fixed literal prefix.                                          |
| `<workspace>`  | `safeSegment(workspaceId)` — see rules below.                  |
| `<agent>`      | `RuntimeAgentId`, emitted verbatim (all ids are `[a-z]` only). |
| `<task>`       | `safeSegment(taskId)` — see rules below.                       |
| `<sha256[:12]>`| First 12 lowercase hex chars of `sha256("<workspaceId>\0<taskId>")`. |

## Segment sanitization rules (`safeSegment`)

Applied to `<workspace>` and `<task>`:

1. Lowercase the value.
2. Replace every run of characters outside `[a-z0-9._-]` with a single `-`.
3. Trim leading and trailing `-`.
4. Truncate to 36 characters.
5. If nothing remains, use the literal `unknown`.

Consequences parsers must respect:

- **Segments may contain dots** (`.` is in the allowed character set), so a name
  is not reliably split into exactly five parts by splitting on `.`. Do not
  parse positionally.
- Safe parsing assumptions: the name starts with `kanban.`, ends with
  `.<12 lowercase hex chars>`, and contains the exact marker `.<agent>.`
  somewhere in between. The harness viewer matches on precisely these.

## Digest semantics

- The digest is computed over the **raw, unsanitized** `workspaceId` and
  `taskId`, joined with a NUL (`\0`) separator.
- Purpose: names stay unique and deterministic per (workspace, task) pair even
  when sanitization would otherwise collide (e.g. `task/a` and `task a`).
- `sha256[:12]` means: hex-encode the SHA-256 digest, take the first 12
  characters (48 bits).

## Example

For `workspaceId = "workspace-one"`, `agentId = "codex"`,
`taskId = "task/with spaces"`:

```
kanban.workspace-one.codex.task-with-spaces.<sha256("workspace-one\0task/with spaces")[:12]>
```

The exact digest value is pinned in
`test/runtime/terminal/zmx-agent-session.test.ts`.

## Disabling durable sessions

Set `KANBAN_DURABLE_AGENT_SESSIONS=0` in the runtime environment to opt out of
durable sessions entirely:

- Agents launch directly on the PTY (no `zmx attach` wrapper), so their
  sessions are interrupted on runtime shutdown like any non-durable session.
- Startup reconciliation (`TerminalSessionManager.reconcileDurableSessions`)
  skips all zmx interaction: it does not list, reattach, or kill sessions.

## Restart lifecycle

- The durable session name is persisted on the task session summary
  (`durableSessionName` in the workspace state record).
- On runtime start, `hydrateFromRecord` restores durable-session tracking from
  that field and `reconcileDurableSessions` verifies each persisted session
  against `zmx list`: live sessions stay reattachable; sessions that died
  while the runtime was down are cleared and the task surfaces as idle.
- `kanban.*` sessions for the same workspace that match no known task are
  treated as orphans and **killed automatically** (with a logged warning).
  Sessions owned by other workspaces are never touched.

