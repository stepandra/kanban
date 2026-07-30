# Kanban Decision Log

This file records product and architecture decisions that are not obvious from
the implementation alone. Entries are append-only; a superseding decision
should point back to the decision it replaces.

## D-001 — Kanban is an operational projection, not a second workflow authority

- **Status:** Accepted; implemented 2026-07-31
- **Date:** 2026-07-31

Absurd remains the durable execution scheduler and Kanban remains the operator
surface for task intent and lifecycle. jj owns repository history and workspace
state. Browser views may request existing task operations, but summaries,
visualizations, and links are read-only projections derived from those
authoritative sources.

**Consequence:** UI-only state must never advance a task, manufacture an
execution receipt, or repair scheduler state.

## D-002 — Execution identity is fenced by task generation

- **Status:** Accepted
- **Date:** 2026-07-31

A queued or running execution is identified by workspace, task, and task
generation. Changes to the task's execution contract increment the generation;
late starts and late session attachment for older generations are rejected.
Absurd retry attempts remain distinct from task generation.

**Consequence:** Editing execution inputs invalidates stale queued work without
changing the task's human-facing identity.

## D-003 — Amp Architect provenance is immutable context, not execution state

- **Status:** Accepted; implemented 2026-07-31
- **Date:** 2026-07-31

Tasks created through the Amp Kanban tool retain the originating Amp Architect
thread ID captured from the tool execution context. This is distinct from any
Amp Orb or other worker thread used to execute the task. The value is immutable
provenance metadata and does not increment task generation.

On the board it appears as a compact `Amp Architect` origin marker; the task
detail view shows the fuller context and copies the supported
`amp threads continue <thread-id>` navigation command. The raw thread ID is
fallback reference data, not the primary board label. Amp exposes no confirmed
local deep-link contract, so the UI deliberately does not invent one.

**Consequence:** Operators can trace why a task exists without making Amp a
second owner of Kanban lifecycle truth.

## D-004 — The default board optimizes for an operational picture

- **Status:** Accepted; implemented 2026-07-31
- **Date:** 2026-07-31

The default board should expose the whole lifecycle and the few signals needed
to decide where attention belongs. Dense machine details such as full workspace
paths stay available through disclosure, while cards lead with task intent,
worker, live state, jj identity, and change size.

The toolbar summary is derived from current board and session data; it is not
persisted. The first bounded redesign slice adds this summary and compacts
workspace metadata without adding new workflow controls.

**Consequence:** More tasks and state fit in one viewport while existing task
operations remain unchanged.

## D-005 — jj visualization links repository state to tasks by stable identity

- **Status:** Accepted; implemented 2026-07-31
- **Date:** 2026-07-31

The jj visualizer is a read-only graph of real jj changes and commits. Task
workspaces expose jj change ID and commit ID, and graph nodes link to cards by
the Kanban task ID associated with that workspace. The graph does not infer
task lifecycle from commit position and cannot mutate board state.

The first implementation reads at most 80 visible changes through `jj log`,
preserves jj's own graph glyphs, and exposes only refresh, return-to-board, and
linked-card navigation. It deliberately does not add rebase, abandon, bookmark,
or working-copy mutation controls.

**Consequence:** Operators can navigate between task intent and repository
history without conflating the two state machines.

## D-006 — Legacy Cline storage identifiers are migration input only

- **Status:** Accepted
- **Date:** 2026-07-31

User-facing product branding and active worker catalogs must say Kanban and must
not advertise Cline. Existing `.cline/kanban` storage paths, serialized
`agentId: "cline"` values, and migration tests remain temporarily readable so
upgrading users do not lose boards or accidentally start an old worker.

**Consequence:** A repository search may still find Cline in compatibility and
historical surfaces, but no Cline worker can be selected or launched. Moving
active storage to a new namespace requires a separate fail-safe migration.

## D-007 — Local attachment is not Absurd execution status

- **Status:** Accepted; UI terminology corrected 2026-07-31
- **Date:** 2026-07-31

The runtime session stream can authoritatively say whether this Kanban process
is attached to a task's durable terminal session. It cannot authoritatively say
whether an Absurd execution attempt is pending, running, sleeping, failed, or
cancelled. The operational summary therefore says `attached`, not `active`.

The installed Absurd inspection command lists attempt status, but its bounded
list response does not expose the Kanban identity stored in task parameters or
headers. Joining that output to a card by recency, pane name, or terminal state
would manufacture scheduler truth.

**Consequence:** Full queued/running visibility requires a read-only Absurd
projection contract keyed by `(workspace, task, generation)` or by a persisted
Absurd attempt reference. Until that contract exists, Kanban must not persist a
synthetic `queued` flag or infer execution status from its board column.

## D-008 — Every worker start must pass through Absurd admission

- **Status:** Accepted; implemented 2026-07-31
- **Date:** 2026-07-31

Browser and Amp/CLI starts enqueue the same generation-fenced task reference
through Absurd. The browser receives a queued receipt rather than a synthetic
running session. Resume intent is carried in the opaque execution reference;
after admission, direct-start reconstructs prompt, images, and plan mode from
the authoritative task card and preserves the existing Review resume flow.

The direct task-session RPC rejects normal browser callers. Only the runtime's
validated internal bearer context, used by the Absurd worker entrypoint, may
attach the deterministic zmx session.

**Consequence:** There is one admission path and one guarded attachment path.
Browser optimism can still render a column move, but it cannot bypass Absurd or
claim that a queued execution is running.

## D-009 — Amp Architect is not a selectable terminal worker

- **Status:** Accepted; implemented 2026-07-31
- **Date:** 2026-07-31

Amp Architect owns decomposition and task creation. Amp Orbs are isolated
execution contexts launched by the Amp integration, not a generic terminal
agent selected from a card. The native Absurd Kanban queue supports Claude,
Codex, Grok, and Kimi workers. Older Droid, Kiro, Gemini, and OpenCode config
values remain parseable for migration but are not launch-supported.

**Consequence:** The worker picker matches the actual scheduler contract, and a
legacy unsupported selection normalizes to the supported default instead of
bypassing Absurd through a direct terminal launch.

## D-010 — Kanban retains an Absurd attempt reference, not scheduler state

- **Status:** Accepted
- **Date:** 2026-07-31

After Absurd admits a task, Kanban may retain the returned Absurd task ID
together with the task generation that was queued and the local enqueue time.
This is a foreign-key-like reference to one execution attempt, not a copy of
its status. Pending, running, sleeping, completed, failed, and cancelled are
read live from Absurd through a read-only projection.

Editing execution-relevant task input increments generation. An older retained
attempt then remains visible as stale lineage and is never presented as the
execution of the edited task.

**Consequence:** Cards can show authoritative execution state without making
the board, terminal attachment, or optimistic column move a second scheduler.

## D-011 — Task detail is an operator dossier; terminals are evidence

- **Status:** Accepted
- **Date:** 2026-07-31

The default task detail view leads with intent, lifecycle, executor, origin,
dependencies, execution attempt, repository identity, and review readiness.
Terminal output and repository changes remain available as secondary evidence
views and retain their existing operations.

**Consequence:** Opening a task answers “what is this, where did it come from,
what is blocking it, and what should I inspect next?” before exposing machine
output.

## D-012 — The jj graph is task-aware and topology-first

- **Status:** Accepted
- **Date:** 2026-07-31

The default jj surface draws real parent relationships from jj commit IDs and
selects an operational subset around task workspaces, bookmarks, and the
current working copy. Linked tasks and changes navigate to each other. A
separate all-history mode preserves access to the wider immutable graph.

The visualizer is read-only. It does not add rebase, abandon, bookmark, or
working-copy mutation controls, and it does not infer Kanban lifecycle from
graph position.

**Consequence:** Repository topology becomes an operational map instead of a
terminal transcript while jj and Kanban remain distinct state machines.

## D-013 — Settings starts with read-only system readiness

- **Status:** Accepted
- **Date:** 2026-07-31

Settings exposes a first-class readiness surface for the execution queue,
worker service, jj repository, and supported worker commands. The checks are
diagnostic only: opening Settings must never install dependencies, start a
worker, repair state, or enqueue work.

Configuration sections remain independently navigable and risky execution
overrides stay separated from readiness facts.

**Consequence:** Operators can distinguish “configured”, “installed”,
“running”, and “unavailable” before pressing Queue, without turning Settings
into another runtime controller.
