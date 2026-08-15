# Grok Build workers and Amp QA campaigns

Date: 2026-08-11
Status: accepted target; implementation pending
Scope: worker execution, remote workspaces, QA campaigns, Zellij, UI/UX, and acceptance

## Decision

Kanban remains the only durable authority for tasks, dependencies, execution
placement, execution-workspace identity and lifecycle, immutable submissions,
campaign membership, review, and acceptance. Absurd authoritatively records
execution and campaign-delivery attempts, checkpoints, waits, results, retries,
and admission, but those records cannot mutate Kanban lifecycle. Hosts and VCS
own physical file presence and repository contents/history; their observations
do not own Kanban workspace lifecycle.

Grok Build becomes the primary implementation harness. Kanban assigns work to
a Grok Build execution profile, not to a particular model provider. Model
selection, LLM Gateway routing, agent roles, subagents, and Rhai workflows are
internal to Grok Build. Kimi may remain as an additional harness, but the domain
model and UI must not require it.

Amp has three roles:

- Architecture, Product, and UI/UX planning;
- task decomposition and explicit typed Kanban mutations; and
- one owning `a1.xxlarge` Amp Orb thread per QA/production campaign.

Amp is not a task worker. The per-task Amp Orb path and the per-task Amp Fixer
are legacy paths to remove. A QA campaign is the batch integrator, reviewer,
fixer, and verifier. It owns the only writable campaign workspace, fans tests
out to read-only isolated lanes, fixes all in-scope findings in the same Orb,
retests until clean, and submits one fenced verification receipt. Kanban alone
accepts the frozen member set after the verified revision is published through
the release boundary.

Until that campaign boundary is implemented, the local single-user control
plane supports bounded per-task acceptance through `kanban task accept`. The
installed `kanban_tasks` Amp plugin is the normal caller and passes its current
`PluginToolContext` thread; direct CLI use by the same local OS user is trusted
by the same compatibility boundary. Kanban requires the supplied thread to
exactly match immutable task origin and still re-verifies the current task
generation, execution attempt, local workspace identity/state, base identity,
and conflicts before atomically recording acceptance. This compatibility path
neither publishes a revision nor changes the campaign acceptance target.

This decision supersedes the per-task Promoter/Fixer and Amp task-worker parts
of `2026-07-25-kanban-vnext-ownership-and-lifecycle.md`. Generation and attempt
fencing, immutable submission identity, workspace isolation, and the rule that
generic board movement cannot accept Review work remain valid.

The authority boundary is explicit:

| Concern | Authority | Non-authoritative projections or executors |
| --- | --- | --- |
| Task, dependency, placement, fence, candidate, campaign, release intent, execution-workspace lifecycle, acceptance | Kanban | Browser, Zellij, Grok, Amp, hooks |
| Delivery admission, attempt records, checkpoints, waits, retry scheduling, results | Absurd | Kanban lifecycle projections |
| Physical directories, repository objects, refs, and history | Execution host and VCS | Kanban observations and durable identity records |
| Model routing, Rhai workflow, child agents, ACP stream | Grok Build | Kanban execution telemetry |
| QA fan-out, campaign repair, evidence production | Owning Amp Orb under the current Kanban campaign fence | QA lanes and Amp thread state |
| Desired cockpit focus | Kanban `FocusSelection` | Realized Zellij panes and attachments |

## Worker execution boundary

Grok Build's Agent Client Protocol (ACP) is the preferred remote execution
surface. A remote Grok process may expose a long-lived authenticated WebSocket
server with `grok agent serve`, connect outbound through the Grok WebSocket
relay, or use ACP stdio behind a host-local adapter. The persisted connection
identity includes host, endpoint/transport, an authentication-secret reference,
and ACP session ID; session ID alone is not assumed to locate a remote worker.
The implementation must prove `session/load` and reconnect behavior for every
supported transport before cutover.

Headless `grok -p` is appropriate for bounded one-shot automation and
validation. It is not the primary interactive or reconnectable worker
transport.

When the installed Grok build exposes its documented SSH wrapper (currently
documented as `grok wrap ssh`), the wrapper executes locally around SSH while
the remote shell, Grok process, file edits, tests, and service operations execute
on the selected remote host. Availability is a host capability to probe, not an
architectural assumption. SSH remains an operator/transport surface, not
scheduler or lifecycle authority. An SSH tunnel may carry ACP WebSocket traffic
without exposing the remote ACP port directly.

The host-side Kanban adapter must stay narrow. It owns only:

- host registration, capabilities, capacity, and heartbeat;
- claiming one fenced Absurd assignment;
- materializing or locating the assigned workspace;
- launching or reconnecting the Grok ACP session;
- projecting ACP events as telemetry; and
- publishing the immutable candidate and submitting it with the current fence.

It must not parse terminal prose to infer lifecycle, duplicate Grok's model or
workflow orchestration, or treat process/session/workflow completion as task
acceptance.

## Task submission contract

A Grok Build worker owns one bounded task contribution. The worker may use a
large Rhai workflow and internal model/subagent fan-out, but Kanban sees one
fenced top-level execution and one immutable candidate.

Review entry must atomically verify and persist:

- task ID, generation, execution attempt, and current fence;
- worker host and workspace identity;
- base SHA, candidate SHA, and unique candidate ref;
- focused validation evidence and its digest; and
- the Grok ACP session ID used to produce the candidate.

If candidate verification or persistence fails, the task remains In Progress.
Repeating the same submission is idempotent; changing the candidate for the same
generation is rejected. A Grok session, Rhai workflow, Absurd attempt, hook,
terminal, or Zellij pane never moves a card by itself.

## QA campaign contract

A task generation has zero candidates before submit and exactly one immutable
candidate after successful submit. If worker-level rework is required, Kanban
creates a new task generation and candidate rather than rewriting the submitted
candidate.

A campaign belongs to one Kanban project/repository and freezes a non-empty set
with no duplicate candidates and at most one candidate per task. Every member
must be the current unaccepted Review candidate for its exact task generation
and must not belong to another nonterminal campaign. An accepted candidate is
never eligible for another campaign. While the campaign is nonterminal, Kanban
locks every frozen generation against candidate replacement, acceptance, or
rework outside that campaign. Within the project, a campaign may include
candidates from several tracks and milestones when that is the coherent
integration boundary. Track and milestone membership remains planning context;
it neither implicitly enrolls a candidate nor prevents a cross-track campaign.
Global Tracks aggregates campaigns from several projects, but one campaign is
never a multi-repository transaction.

Kanban validates the exact requested candidate set without filtering,
deduplication, or implicit expansion. If any requested member is duplicate or
ineligible, no campaign, membership digest, owner, release lease, or campaign
workspace record is created.

Kanban atomically creates a stable `campaignId`, freezes membership and its
digest, and records the one owning Amp thread/workspace identity before
dispatching Amp; the Orb never authors its own member set. Campaign states are
`pending`, `running`, `verified`, `releasing`, `accepted`, and `aborted`.
`accepted` and `aborted` are terminal; an aborted campaign's unaccepted
candidates become eligible for a new, explicitly linked successor `campaignId`.
The only forward path is `pending -> running -> verified -> releasing ->
accepted`. Explicit abort is allowed from `pending`, `running`, or `verified`,
but not after entering `releasing`: physical publication may have succeeded even
when its receipt was lost. A releasing campaign must recover/retry publication
and finish Kanban acceptance; it cannot be replaced by an aborted successor.

Exactly one owning Amp thread and Orb belong to a campaign. Kanban stores the
current campaign fence and a foreign-key-like reference to the active Absurd
campaign-delivery attempt. Each delivery retry uses a new Absurd attempt paired
with a strictly greater Kanban fence, then reconnects that same thread and
campaign workspace; it never allocates a second owner. Absurd may durably mark
delivery attempts queued, claimed, waiting, retryable, completed, or failed,
but those attempt records do not change the Kanban campaign state. Lease expiry
or host loss may make an attempt stale and start a fenced retry; every late
checkpoint, finding batch, verification receipt, and acceptance request from
the stale attempt is rejected. If the Orb is irrecoverable, Kanban aborts the
campaign and creates an explicitly linked successor instead of silently
replacing the owner.

A verification receipt binds `campaignId`, membership digest,
Absurd campaign-attempt reference, current fence, campaign workspace,
integration base, verified SHA/ref, and evidence-manifest digest. Kanban verifies
that receipt before moving `running -> verified`.

Moving `verified -> releasing` atomically acquires the repository-scoped
integration/release lease and records an immutable release intent for exactly
that verified SHA. The delivery assignment binds the current release-lease
fence. Absurd durably delivers and retries the intent; the host/VCS performs an
idempotent compare-and-set publication. A stale delivery cannot overwrite a
divergent ref or authorize acceptance, but it may publish the same immutable
intent after its lease expires. A current retry then observes that exact SHA as
already published and recovers a current fenced receipt.

The successful VCS receipt binds `campaignId`, `releaseIntentId`, target ref,
expected prior SHA, exact verified SHA, observed final SHA, outcome (`published`
or `already_published`), Absurd release-attempt reference, and current
release-lease fence. A divergent compare-and-set is a failed delivery result,
not a publication receipt. Moving `releasing -> accepted` atomically verifies
that receipt, current campaign fence, current release-lease fence, membership
digest, and every frozen task generation/candidate, then accepts all members and
records the release revision in one Kanban transaction. If any member or receipt
fails validation, the transaction makes no task or campaign changes; partial
acceptance is forbidden and the campaign remains `releasing` for explicit
receipt recovery or retry. Release delivery state never changes which SHA was
verified. The repository-scoped lease serializes campaigns that could modify
the same integration base or release ref. All campaign mutations and terminal
transitions are fenced and idempotent.

The campaign lifecycle is:

```text
Review / QA eligible
  -> atomic freeze of exact task generations and candidate SHAs
  -> one campaign workspace in one a1.xxlarge Amp Orb
  -> dependency-ordered integration
  -> immutable campaign checkpoint
  -> read-only deterministic QA fan-out
  -> canonical findings ledger and barrier
  -> coherent fix batch by the same main Amp agent
  -> targeted retest and full sweep
  -> verified campaign SHA/ref and evidence manifest
  -> immutable release intent for only the verified campaign SHA
  -> idempotent VCS publication and fenced receipt
  -> atomic Kanban acceptance of the frozen member set
```

QA lanes may read isolated snapshots and return findings/evidence. They never
write the canonical campaign workspace. A code change during a test wave
invalidates that wave and requires a new checkpoint. All ordinary in-scope
findings are repaired in the same campaign Orb rather than creating per-finding
Fixers or returning immutable task candidates to their original workers.

## Durable workspace inventory

Kanban must expose every physical workspace whose lifecycle is not `deleted`,
including retained task workspaces and campaign workspaces. A workspace path is
meaningful only together with its execution host.

In target vocabulary, **Project** is the logical Kanban scope for one repository.
**ProjectRoot** is a registered host-qualified checkout/root used to operate on
that project; the current API often calls this object a workspace.
**ExecutionWorkspace** is a physical task or campaign directory on a particular
host. User-facing UI and new domain contracts must not collapse those three
concepts.

The durable identity is a workspace record, not a path inferred from a task ID:

```text
ExecutionWorkspace
  workspaceId
  kind: task | campaign
  projectId
  projectRootId
  hostId
  canonicalPath
  vcs
  predecessorWorkspaceId?
  lifecycle: active | retained | deleting | deleted
  observedState: present | missing | host_unreachable
  createdAt
  lastObservedAt
```

One execution-workspace record represents one immutable `(projectRootId,
hostId, canonicalPath)` incarnation. Placement selects the registered
`ProjectRoot` before Kanban creates the execution-workspace identity; the host
adapter materializes that exact identity rather than inventing a path.
Relocation or rematerialization creates a new workspace ID linked to its
predecessor. A task generation has at most one active execution workspace at a
time, but a fenced replacement operation may move a retry to a new workspace
when the old host is unreachable. The prior record and usage history remain;
replacement is never inferred from a heartbeat.

An append-only `WorkspaceUse` associates a physical workspace with every task
generation or campaign that used it and records `workspaceId`, subject identity,
execution/campaign attempt, ACP or Amp thread identity, `startedAt`, optional
`endedAt`, and observed base/final revision. This supports workspaces that
outlive an execution and campaign workspaces that contain multiple tasks.

The primary UI identity is host-qualified, for example:

```text
grok-worker-17:/srv/kanban/workspaces/K-142
```

The Workspaces UI must show at least host, path, kind, project, task IDs,
campaign ID, current revision/change, lifecycle, observed presence, and last
observation. `observedState` is host telemetry and never silently rewrites the
durable lifecycle. `retained + missing` is visible drift, not proof of deletion.
`deleted` means an explicit operation removed the physical directory; Kanban
retains the workspace tombstone and every `WorkspaceUse`. Deleted workspaces are
hidden from the default active inventory but remain available in task/campaign
history and an explicit history filter.

## Grok workflow boundary

Rhai workflows are internal Grok execution machinery. Their plans, child-agent
state, progress, and run dashboard are telemetry. Workflow pause/resume is not
an exactly-once cross-process protocol, so Kanban generation/attempt fencing and
idempotent candidate submission remain mandatory even when a workflow handles
most of a large task autonomously.

## Zellij and UI/UX

Kanban keeps a supported keyboard-first Zellij Focus Cockpit, but the browser is
the global operating and lifecycle surface. The canonical cockpit has:

- one always-present Amp Architect thread in the left pane;
- a dynamic stacked working set on the right, normally three or four selected
  In Progress task executions and one or two active QA campaigns;
- an explicit revisioned `FocusSelection` supplied by Kanban with exact task
  execution, ACP session, and campaign identities rather than fixed per-harness
  slots or discovery by parsing zmx names; and
- attach, observe, and interactive session traffic only. Lifecycle mutations
  still use typed Kanban operations.

`FocusSelection` is Kanban-owned, non-workflow presentation state. Browser
pin/unpin and an explicit cockpit focus command may update it. Zellij owns only
the realized pane IDs, order, dimensions, expanded pane, and attachment health.
Closing, replacing, resetting, or reordering a pane does not implicitly update
the selection and cannot stop a worker, submit a candidate, change campaign
membership, accept work, or delete a workspace.

Interactive input may change execution artifacts. Amp Architect or a campaign
thread displayed inside a pane may also call authenticated typed Kanban
operations. The prohibited shortcut is deriving a Kanban mutation from pane
existence, output text, focus, or exit. Zellij must not raw-spawn a second
worker. A task pane uses a Kanban-managed ACP client to load the exact remote
session for the current fenced execution. The intended interactive campaign
path is `amp threads continue <threadId>`; cross-host Orb continuation must be
validated before implementation. If unavailable, the pane is a visibly
read-only campaign projection with a deep link to the supported Amp client, not
an equivalent pseudo-attachment built by scraping logs.

The existing fixed Codex/Claude/Kimi/Grok stack and `latest zmx session by
harness` lookup are legacy. They cannot represent multiple concurrent Grok
executions, remote hosts, or campaign Orbs and must be replaced rather than
extended.

Tracks is the primary browser place for delivery and operations. It becomes a
global projection over projects instead of adding a separate generic
Operations dashboard. Phase 1 remains read-only. Target Tracks may expose
navigation, focus/pin actions, and authenticated typed commands, but campaign
membership, acceptance, and workspace lifecycle remain authoritative Kanban
records and APIs. The target interaction model is:

```text
Tracks
  -> track and active milestone scope
  -> Backlog, In Progress executions, Review candidates, accepted scope
  -> campaigns touching candidates in that scope
  -> cross-track blockers and explicit unassigned scope

Task
  -> task definition and dependencies
  -> current fenced execution and structured ACP activity
  -> immutable candidate and focused evidence
  -> physical workspace history

QA campaign
  -> exact frozen candidate membership across tracks/milestones
  -> campaign workspace and Amp Orb thread
  -> integration checkpoint, QA lanes, findings, fixes, and retests
  -> verified revision, evidence manifest, acceptance, and release

Workspaces
  -> every non-deleted host-qualified task or campaign workspace
  -> usage history, current revision, lifecycle, and observed host state
```

The project Board remains the tactical task planning and editing surface; it is
not the fleet cockpit. Raw terminal and remote-shell access remains a contextual
workspace/session action, while structured ACP activity is the primary task
execution view. Browser actions may pin or open an exact task execution or
campaign in the Zellij Focus Cockpit, but pane presence is never workflow truth.

## Migration direction

1. Add the authoritative repository/schema for candidates, campaigns, campaign
   state/current fences, Absurd campaign-attempt references, acceptance and
   release-intent receipts, execution workspaces/uses, and a local host identity.
   Backfill current local workspaces under one writer and expose a reconciliation
   report between old projections and new records.
2. Make submit candidate-backed under the new single writer. Keep campaign
   acceptance fail-closed while contract tests prove candidate identity,
   stale-fence rejection, and recovery; retire the local per-task compatibility
   mutation when the campaign boundary replaces it.
3. Implement one-host campaigns using the final workspace records, campaign
   fencing, repository lease, VCS release receipts, and atomic Kanban batch
   acceptance, but keep campaign dispatch and acceptance dark/test-only.
4. Enable campaign dispatch and acceptance only after its fences and receipts
   are complete. Remove the post-submit Fixer, Amp task Orbs, and bounded local
   per-task acceptance compatibility path as part of that cutover.
5. Add remote Grok Build host placement, ACP reconnect, and explicit workspace
   replacement under the same final identities.
6. Expose the workspace inventory, global Tracks, and candidate/campaign detail
   projections.
7. Replace the fixed zmx-by-harness cockpit with the identity-driven Zellij
   Focus Cockpit.

There is no steady-state dual authority. Current local PTY/zmx behavior may be
used during migration, but it must not be generalized into a second remote
execution protocol beside Grok ACP.
