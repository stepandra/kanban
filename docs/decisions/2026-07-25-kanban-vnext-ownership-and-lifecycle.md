# Kanban vNext ownership and lifecycle

Date: 2026-07-25  
Status: superseded in part on 2026-08-11
Scope: stepandra/kanban development-task orchestration

> The abstract generation, attempt-fencing, immutable-submission, guarded
> cleanup, and projection boundaries in this record remain valid. The per-task
> Amp Promoter/Fixer model, Amp task-worker role, per-task acceptance flow,
> deterministic zmx identity, and one-exact-path-per-generation rules are local
> migration behavior superseded in the remote target by execution-workspace
> records, explicit replacement, and persisted Grok ACP connection identity. See
> [`2026-08-11-grok-build-workers-and-qa-campaigns.md`](./2026-08-11-grok-build-workers-and-qa-campaigns.md).

## Decision

Kanban remains the authority for development tasks. `kanban_tasks` and the
Kanban CLI are the sole mutation surface for cards, dependency DAGs,
generations, task-workspace ownership, immutable submissions, review and
acceptance, generation-scoped execution leases, repository-workspace-scoped
integration leases, and promotion receipts.
Existing board columns and runtime contracts remain unchanged during stage 1.

Absurd owns durable execution attempts, checkpoints, waits, results, retries,
and admission. Absurd identifiers may be referenced by a Kanban generation,
but an Absurd attempt cannot move a card, create or replace a submission,
accept a generation, or become task truth.

Kanban owns deterministic zmx process identity and lifecycle for task
execution. A generation's task-workspace path and executor zmx identity inputs
are fixed when the generation is created and are reused by retries and
reconnects. zmx is a durable process mechanism, not a task-state owner.

This zmx/path rule describes the current local implementation only. The remote
target preserves “new retry attempt, exact reconnect identity, stale fences fail
closed” while allowing an explicit replacement execution workspace and using
ACP connection/session identity instead of zmx identity.

Amp Promoter Orbs are isolated executors. Their output is recorded as a
promoter-derived revision and promotion receipt; it does not mutate task state
directly and never replaces submitted provenance.

Zellij is a view-only telemetry and focus surface. Pane existence, pane text,
exit status, or inferred activity never mutates a card or proves completion.

This record narrows and extends the accepted harness decision at
`/Users/jerryjohnson/dev/zj-agent-harness/docs/decisions/2026-07-24-absurd-orchestration-and-kanban-tui.md`.
That decision establishes the Kanban/Absurd/zmx/Zellij ownership split. This
record defines the Kanban-side generation, submission, fencing, promotion, and
acceptance contracts that later storage and execution slices must preserve.

## Source-of-truth boundaries

| Record or behavior | Authority | Other systems may retain |
| --- | --- | --- |
| Task card, board column, dependency DAG | Kanban | Read-only projections and stable task IDs |
| Generation identity and task-workspace ownership | Kanban | Generation references |
| Generation execution lease fencing | Kanban | The exact current token needed for an execution mutation |
| Repository integration/shared-E2E lease fencing | Kanban | One current token per repository workspace |
| Execution attempt/checkpoint/wait/result/admission | Absurd | Attempt reference and bounded status projection |
| Deterministic zmx identity and process lifecycle | Kanban | Attach/view information |
| Submitted SHA and remote ref | Kanban, immutable | Exact provenance copy |
| Promoter-derived revision and promotion attempt | Kanban receipt around Promoter output | Execution result |
| Accepted revision and acceptance receipt | Kanban | Read-only receipt projection |
| Zellij pane and presentation state | Zellij | No authoritative workflow state |

There is one writer per concern. Cross-system identifiers and projections do
not transfer ownership.

## Terms that must not be collapsed

- **Task**: the durable card and dependency node. It can have multiple
  generations.
- **Generation**: one owned implementation lineage for a task, identified by
  `(workspaceId, taskId, generation)`. It owns one task-workspace and one set
  of deterministic zmx identity inputs.
- **Execution attempt**: an Absurd-owned durable try within a generation.
  Retry creates a new attempt reference without creating a new generation,
  workspace, or zmx identity.
- **zmx session**: the durable task-executor process identity chosen by Kanban
  from the generation identity and agent. It is not an attempt or a card, and
  Promoter Orbs are not zmx sessions.
- **Immutable submission**: the first accepted pair of `submittedSha` and
  `remoteRef` for a generation. The pair cannot be edited by retry, promotion,
  or acceptance. Its deterministic dispatch intent is derived at the dispatch
  boundary and is not persisted as duplicate lifecycle state.
- **Promotion attempt**: one isolated Amp Promoter Orb execution against the
  immutable submission. Independent Promoters may fan out; they do not hold
  the repository integration lease for their review/repair work.
- **Promoter-derived revision**: the revision emitted by a Promoter. It is
  stored separately from submission provenance.
- **Accepted revision**: the revision named by a matching acceptance receipt.
  It may differ from both the submitted and promoter-derived revisions.
- **Projection**: a disposable read model of authoritative records. A
  projection may be rebuilt and never becomes a mutation surface.

## Executable contract

The additive, framework-independent TypeScript contract lives in
`src/domain/kanban-generation.ts`, `src/domain/kanban-leases.ts`,
`src/domain/kanban-submission.ts`, and
`src/domain/kanban-generation-lifecycle.ts`.

Lifecycle state is a discriminated union rather than a record with unrelated
optional fields:

```text
ready
  -> executing
       -> awaiting-submission
            -> submitted
                 -> promoted (after selecting one completed Promoter receipt)
                      -> accepted

executing -> execution-stuck -> executing
pre-submission -> cancelled
submitted/review/promotion -> rejected

submitted -> promotion-running[*] -> promotion-completed[*]
                               \-> promotion-stuck[*] -> promotion-running[*]
```

Promoter attempts are separate records keyed by generation and attempt ID, not
singular generation states. They contain the generation identity, immutable
submission provenance, and Promoter attempt data, but no task-workspace path,
zmx identity, or lease. Multiple attempts may run, become stuck, or finish
concurrently while the authoritative generation remains `submitted`. Selecting
one completed receipt advances the generation to `promoted` only after its
generation, submission, and attempt ID bindings are verified; unselected
attempts do not fork or overwrite generation state.

Illegal transitions throw. Accepted, rejected, and cancelled generations are
terminal. Execution-stuck and promotion-stuck are explicit states rather than
inferred timeout flags.

## Retry, reconnect, dispatch, and fencing invariants

Items that name an exact path, zmx identity, Promoter, or per-task promotion are
historical local-stage rules. The 2026-08-11 target preserves their abstract
fencing and immutable-provenance intent but replaces those concrete mechanisms.

1. Every execution retry remains in the same generation and therefore reuses
   the exact task-workspace path and deterministic zmx identity inputs.
2. Reconnect targets the existing Absurd attempt reference and current
   execution lease. It does not create a generation or silently restart work.
3. An execution retry uses a new attempt reference and a strictly greater
   generation-scoped execution fencing value. Authoritative Kanban storage
   serializes fencing advancement; callers cannot independently choose or race
   the next value. A Promoter retry also uses a new attempt reference, but does
   not acquire an execution or integration lease merely to run.
4. The repository integration/shared-E2E lease is scoped to the Kanban
   repository workspace, not a generation. Exactly one current fence serializes
   the eventual final integration and shared end-to-end boundary for that
   repository. A stale, future, or foreign-workspace token fails closed.
   Promoter review and repair before that boundary may fan out independently.
5. A generation has exactly one submission-dispatch outbox identity, derived
   at the dispatch boundary from generation identity and immutable submission
   provenance. Lifecycle state and artifact history do not persist a duplicate
   intent. Replaying derivation with the same inputs yields the same identity.
6. Repeating submission with the same provenance is idempotent. Repeating it
   with a different SHA or remote ref is rejected.
7. Promoter output is stored as a separate derived revision. It never rewrites
   `submittedSha` or `remoteRef`.
8. Acceptance is legal only after promotion and only with a receipt that
   references the exact promotion receipt, generation, and immutable
   submission. The accepted revision remains a separate named value.
9. Promoter attempt lifecycle is independent of the singular generation state.
   Starting one attempt does not consume `submitted` or block another attempt;
   only explicit selection of one completed receipt advances the generation.

## Guarded reaping

Generation-workspace cleanup is considered on every explicit terminal or
stuck generation path:

- `accepted`
- `rejected`
- `cancelled`
- `execution-stuck`

The `execution-stuck` path permits process cleanup only. Its generation
workspace must remain because a legal retry reuses that exact workspace and
deterministic zmx identity. Workspace reaping becomes eligible only after an
explicit terminal transition.

Promoter-attempt cleanup is a separate executor concern and is deferred to the
promotion stage. A `promotion-stuck` attempt never enters generation-workspace
reaping because Promoter attempts own no task-workspace path, generation
context, or zmx identity.

Eligibility is not permission. Before a terminal generation's workspace is
reaped, Kanban must prove that it is clean, non-conflicted, and published. A
dirty, conflicted, or unpublished workspace blocks reaping and keeps its
evidence intact. Missing or unknown safety evidence is represented as a failed
guard, not as permission. Active generations are not candidates.

Later runtime slices must route all generation-workspace reaping entry points
through this guard; they must not add a success-only cleanup path that bypasses
stuck or terminal generation classification.

## Admission probes

CPA/CLIProxyAPI quota probes are admission heuristics only. Stage 1 deliberately
defines no executable admission type; the execution-stage consumer must define
the smallest observation it actually uses, without credential identity.

A probe:

- does not reserve quota;
- does not pin a credential for the eventual request;
- does not prove that CPA routing will select the credential observed;
- must be refreshed according to the execution slice's admission policy; and
- fails closed when CPA is unavailable, the response is unknown, or quota is
  exhausted.

Credentials and management keys are not Kanban domain data.

## Staged migration

This historical stage sequence is superseded by the repository-first campaign
migration in the 2026-08-11 ADR. It remains here to explain how the current
local zmx and per-task Fixer boundary was reached.

1. **Stage 1 (this record):** add the durable decision, reusable contracts, and
   focused contract tests. Do not change persistence or runtime behavior.
2. **Repository stage:** add the Postgres repository and migrations behind
   these contracts. Establish one authoritative writer and verified backfill.
3. **Execution stage:** connect Absurd attempts/admission and Kanban-owned zmx
   lifecycle using stable identifiers and fenced mutation commands.
4. **Workspace stage:** move generation workspace ownership and guarded reaping
   behind the repository without changing submission provenance.
5. **Promotion stage:** dispatch isolated, parallel-capable Promoter Orbs from
   the single outbox intent, persist promotion/acceptance receipts, and consume
   the repository integration lease only at final integration/shared-E2E.
6. **Projection stage:** rebuild browser/TUI/Zellij views from authoritative
   records while keeping all mutations in the CLI/API.

A temporary read comparison or one-way backfill may be used during a stage,
with an explicit removal condition. There is no steady-state dual-write:
legacy and Postgres stores must never both accept authoritative mutations for
the same concern. Cutover requires choosing one writer, proving the target
state, switching reads, and removing the old write path.

## Deferred migration questions

The following are deliberately not answered by stage 1 and must not be
smuggled into these contracts:

- the Postgres schema, transaction boundaries, and repository implementation;
- the cutover/backfill mechanism and rollback checkpoint;
- the concrete executor zmx session-name format that incorporates generation
  inputs while coordinating existing external consumers;
- Absurd handler and checkpoint payloads;
- Promoter Orb dispatch transport and sandbox;
- workspace migration/reaping commands; and
- projection rollout and compatibility duration.
