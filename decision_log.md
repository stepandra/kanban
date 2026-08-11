# Kanban Decision Log

This file records product and architecture decisions that are not obvious from
the implementation alone. Entries are append-only; a superseding decision
should point back to the decision it replaces.

## D-001 — Kanban is an operational projection, not a second workflow authority

- **Status:** Authority wording superseded by D-020 and D-021; projection rule retained
- **Date:** 2026-07-31

The original local-stage wording assigned scheduler authority broadly to Absurd
and “workspace state” broadly to jj. D-020 and D-021 replace that ambiguous
split: Kanban owns task/campaign lifecycle, placement, fences, candidates,
execution-workspace identity/lifecycle, and acceptance; Absurd owns durable
delivery attempts, admission, retries, checkpoints, waits, and results; hosts
and VCS own physical file presence and repository contents/history. Browser and
Zellij views may request typed Kanban operations, but summaries,
visualizations, terminal/session state, and links are projections rather than
workflow authority.

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

## D-014 — tldraw consumes Tracks as a one-way projection

- **Status:** Accepted; Phase 1 implemented 2026-07-31
- **Date:** 2026-07-31

Kanban owns tracks, milestones, task scope, lifecycle, dependencies, and
acceptance. It exposes a revisioned `kanban-tracks-projection/v1` read model
through opaque project refs. tldraw Offline may materialize native lanes,
milestones, pipeline summaries, and bound cross-track blockers, but has no
Kanban mutation route.

Refresh preserves canvas layout and marks removed references orphaned instead
of deleting them. Canvas metadata contains only stable projection refs and
revision data; it never contains Amp thread IDs, task prompts, repository
paths, credentials, or scheduler state.

**Consequence:** tldraw becomes the zoomed-out planning lens without becoming a
second source of workflow truth. See
`docs/decisions/2026-07-31-tldraw-tracks-projection.md`.

## D-015 — Tracks is a read-only operational map

- **Status:** Accepted; Phase 1 implemented 2026-07-31; target expanded 2026-08-11
- **Date:** 2026-07-31

Kanban exposes Tracks as a first-class zoomed-out screen. Each track shows its
active milestone, weighted or count-based progress, lifecycle distribution,
scoped tasks, and cross-track blockers. Unassigned work remains visible as
explicit planning debt instead of disappearing from the overview.

The screen offers navigation only: a task opens its Kanban detail and a linked
workspace opens the corresponding change in the jj graph. Track and milestone
authoring remains deferred until typed Amp Architect mutations exist. The
original Phase 1 projection treated every legacy `trash`/Done card as accepted;
that approximation has been removed. Only retained, verified acceptance
evidence counts as accepted, while unverified archived cards count as discarded.

**Consequence:** Operators get a human-readable delivery map without creating
another workflow authority or presenting speculative controls. Progress cannot
mistake an ordinary discard for proof of acceptance.

## D-016 — Review acceptance fails closed on verified remote revision evidence

- **Status:** Superseded and implementation removed by D-020
- **Date:** 2026-07-31

> Historical record: the per-task command and Fixer credential described below
> were removed before campaign acceptance shipped. Review now fails closed with
> no acceptance entrypoint until D-020 campaign receipts are implemented.

Moving a task from Review to Done is no longer a generic board move. The
reviewer-only `task accept` command requires a full commit ID and an exact
task-scoped remote ref under `refs/heads/kanban/<task-id>-*`. Kanban resolves
the repository's existing `origin`, verifies that exact pair with
`git ls-remote`, stores the evidence on the task, and only then performs the
terminal move and guarded cleanup. The command also requires the matching
`KANBAN_REVIEW_TASK_ID` injected into the isolated per-task Fixer process, so
ordinary worker and Architect contexts fail closed before remote verification.

`task done`/`task trash`, drag-and-drop, bulk actions, whole-board snapshot
saves, and browser auto-review cannot accept Review work. Runtime shutdown
marks non-durable process telemetry interrupted but does not move cards to Done
or reap their task workspaces.

This evidence is a bounded safety seam, not the full vNext promotion protocol:
immutable submission provenance, independently persisted Promoter attempts,
promotion receipts, integration leases, and final acceptance receipts remain
the next repository-stage migration. The UI therefore says “verified remote
revision” rather than claiming a complete promotion receipt.

**Consequence:** A worker exit, clean diff, UI gesture, runtime shutdown, or
reviewer assertion cannot silently become acceptance. Existing review
publication continues to work, while the remaining receipt migration stays
explicit instead of being approximated in the data model. In the accepted
target, campaign-level verified evidence and atomic frozen-set acceptance
replace the isolated per-task Fixer credential and task-scoped remote ref.

## D-017 — Worker command history is bounded runtime telemetry

- **Status:** Accepted; implemented 2026-08-02
- **Date:** 2026-08-02

Kanban exposes the actual PTY command attempted for each local task-worker
launch in a runtime-local journal. The journal is scoped to the workspace
terminal manager, keeps at most 200 newest attempts, and disappears when that
runtime restarts. It records launch time, task, worker, cwd, outcome, pid, and
sanitized argv. It never records the launch environment, and it redacts task
prompts and token, secret, password, or API-key option values before storage.

The browser exposes this journal as an operator inspector between Terminal and
Settings and refreshes it while open. It does not persist entries into board
state or infer task, Absurd-attempt, or review status from process launch.

**Consequence:** Operators can answer “what did Kanban actually execute?”
without turning debug history into workflow truth or creating an unbounded
secret-bearing log.

## D-018 — jj repository health inspection is read-only and fails visibly when incomplete

- **Status:** Accepted; implemented 2026-08-09
- **Date:** 2026-08-09

Kanban exposes `kanban jj doctor` as a standalone JSON inventory of registered
jj workspaces, visible heads, task ownership, expected workspace paths,
conflicts, divergence, and stale empty task workspaces. Repository-state reads
always use `--ignore-working-copy`; repeated inspection must leave the jj
operation head and operation count unchanged. The command may read an
unregistered repository, but it must not register the project or repair any
state.

`ok` reports whether an inventory could be produced, while `healthy` reports
the inventory's findings. Ordinary diagnostic limits, such as unavailable
Kanban board reconciliation or repository-level inability to prove workspace
staleness, are recorded as gaps without making the inventory unhealthy.
Incomplete workspace or head parsing does make it unhealthy so a partial read
cannot appear clean. Process failure remains reserved for `ok: false`.

**Consequence:** Operators and cleanup tooling can inspect jj topology without
creating the very repository operations they are trying to diagnose, and an
incomplete inventory fails visibly instead of manufacturing a clean result.

## D-019 — Superseded campaign workspaces are retired after preserving unique work

- **Status:** Accepted; cleanup executed 2026-08-09
- **Date:** 2026-08-09

The 2026-07 Wave A workspace stack, its two anonymous integration snapshots,
the empty post-task workspace commits, and the pre-main integration bookmark
are historical cleanup inputs rather than unmerged product work. A semantic
comparison against current `main` found the Wave A runtime behavior and tests
already integrated and subsequently evolved. The two anonymous snapshots add
no implementation beyond that history; their extra SDD reports are stale
execution artifacts rather than canonical documentation.

The detached `07aeb` Git worktree was the only exception: it contained a unique
jj health diagnostic. That feature is preserved on current `main` as
`kanban jj doctor`, with current CLI wiring, stable documentation, complete
integration coverage, and an explicit no-new-jj-operation regression test. Its
generated Husky symlink and obsolete whole-file CLI patch are discarded.

After publication of the preserved feature, inactive local workspaces may be
forgotten and removed, obsolete anonymous heads may be abandoned, and the
unpublished `wip/pre-main-integration-20260731` bookmark may be deleted. Existing
published remote feature branches remain historical Git refs; they are not
dirty workspace state and are not deleted as part of this cleanup.

**Consequence:** `main` remains the sole implementation authority, unique work
is not lost during cleanup, and old jj workspace protection no longer keeps
superseded local heads alive indefinitely.

## D-020 — Grok Build is the primary worker harness; Amp owns planning and QA campaigns

- **Status:** Accepted target; implementation pending
- **Date:** 2026-08-11

Kanban assigns implementation work to a Grok Build harness/profile rather than
to an LLM provider. Grok Build owns LLM Gateway routing, model roles, subagents,
and Rhai workflows. Remote execution uses Grok ACP sessions over authenticated
WebSocket, relay, or host-local stdio; SSH is an operator/tunnel surface. ACP,
workflow, terminal, and hook state remain telemetry around a fenced Kanban
execution attempt. Absurd attempt state is authoritative delivery state and is
projected into Kanban without becoming Kanban lifecycle truth.

Amp owns Architecture, Product, UI/UX planning, and one `a1.xxlarge` Orb per QA
campaign. A campaign is limited to one project/repository, though its explicit
frozen candidate set may span Tracks and milestones. Kanban freezes that set
before dispatch; the Orb integrates it, runs read-only QA fan-out, fixes all
in-scope findings in its one writable campaign workspace, retests, produces
one verified campaign revision, and submits a fenced verification receipt.
Kanban records an immutable release intent, Absurd delivers it, and Kanban then
atomically accepts the frozen members only after validating the idempotent VCS
publication receipt.
Campaign delivery retries advance a Kanban-owned fence and reconnect the same
Amp thread/workspace; a stale campaign attempt cannot submit verification or
request acceptance. A stale release attempt cannot overwrite a divergent ref or
authorize acceptance, but may idempotently publish the same immutable intent;
a current retry must recover a current-fenced receipt. Per-task Amp workers,
Promoters, Fixers, and acceptance are superseded.

**Consequence:** `agentId=amp`, the per-task review-Fixer queue, and model-centric
worker catalogs are migration code, not extension points. See
`docs/decisions/2026-08-11-grok-build-workers-and-qa-campaigns.md`.

## D-021 — Workspaces are durable, host-qualified operational objects

- **Status:** Accepted target; implementation pending
- **Date:** 2026-08-11

Kanban must inventory every task or campaign workspace whose lifecycle is not
deleted. In target vocabulary, Project is the logical scope for one repository;
ProjectRoot is a registered host-qualified checkout of that Project; and
ExecutionWorkspace is a physical task or campaign directory materialized from
one selected ProjectRoot. Its durable identity includes `projectRootId`, host,
and path and is independent of a task ID. Append-only usage records associate it
with task generations, campaigns, execution attempts, and Grok ACP sessions.
Host reports of `present`, `missing`, or `host_unreachable` are observations and
cannot silently mutate the durable workspace lifecycle.

**Consequence:** the UI exposes a global Workspaces surface led by a
host-qualified path, with task IDs, campaign ID, revision, lifecycle, observed
presence, and last observation. The current task-keyed, current-project-only
workspace metadata stream becomes a projection of this inventory rather than
its source of truth.

## D-022 — Zellij is an identity-driven Focus Cockpit

- **Status:** Accepted target; implementation pending
- **Date:** 2026-08-11

The supported Zellij cockpit always keeps the Amp Architect thread on the left.
Its right-hand stack contains a bounded working set, normally three or four
selected In Progress task executions and one or two active Amp QA campaigns.
Kanban persists a revisioned desired `FocusSelection` with exact execution, ACP
session, and campaign identities. Zellij separately observes realized pane IDs,
layout, and attachment health; those facts do not become Kanban selection or
lifecycle state. Panes are not fixed by harness and do not discover work by
parsing the newest zmx session.

The cockpit may observe and interact with the referenced Grok ACP or Amp Orb
thread, but pane state is presentation state. It cannot launch a second worker,
infer submit or acceptance from terminal output, mutate campaign membership, or
delete a workspace.

**Consequence:** the fixed Codex/Claude/Kimi/Grok slots and zmx-name scanner are
legacy. Browser and Zellij can share one explicit focus selection without
becoming competing control planes.

## D-023 — Tracks is the global delivery and operations place

- **Status:** Accepted target; implementation pending
- **Date:** 2026-08-11

Tracks, rather than a new generic Operations dashboard, becomes the primary
cross-project browser view. It rolls up active milestone scope, task lifecycle,
fenced remote executions, immutable Review candidates, QA campaign status,
unassigned work, and cross-track blockers. The project Board remains the
tactical task planning and editing view; Workspaces remains a separate global
physical-resource inventory.

A QA campaign is a frozen verification run, not a track or milestone. Its
explicit immutable candidate set may span several tracks and milestones inside
one project/repository. Each affected Track projects campaign status, while
Campaign Detail presents the authoritative Kanban campaign record and exposes
authenticated typed operations for membership, integration evidence, verified
revision, acceptance, and release.

**Consequence:** Kanban reuses its existing delivery primitive instead of
creating a mega-board or a second dashboard object. Task and Campaign details
drill down to structured ACP activity and workspace history; raw terminals are
contextual access, not the primary operational model.
