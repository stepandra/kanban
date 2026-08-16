# Implementation slices

Dependency-ordered, vertical where possible. Each slice ends in a runnable
demo or a falsifiable test artifact — never "framework done, nothing to
show". Sizing is production LoC / test LoC; the totals land at ~26k
production, inside the ~17–29k envelope in the [README](./README.md).

The first **execution loop** (operator creates a task → agent runs on a
remote host → outcome recorded) lands at the end of Slice 7. The first
**full product loop** — the same run ending in a reviewable candidate —
lands at S10. Everything before S7 is the minimum spine; everything after
deepens review, terminals, UI, and operations.

```text
S0 conventions (frozen protocol types + spikes)
 └─ S1 event kernel ─┬─ S2 aggregates ──────────────────────────┐
                     │                                          │
                     └─ S3 netgw ── S4 enrollment+delivery ─┬───┤
                                                            │   │
                                    S5 hostd+workers ◀──────┤   │
                                    S6 jj+inventory  ◀──────┘   │
                                          │                     │
                                          └── S7 execution loop ┘
                                                   │
             ┌──────────────┬──────────────────────┤
             ▼              ▼                      ▼
        S8 PTY/rescue   S9 UI (board+cockpit)  S13 recovery
             │              │
             │         S10 candidates+review ── S11 heatmap
             │              │                   (parallel)
             │         S12 trunk CAS
             ▼              ▼
              S14 ops/backup/observability/chaos
```

Parallelism: S3 needs only S1 (outbox rows), not S2. S5/S6 develop against
a fake transport from S0's frozen protocol types and integrate when S4
lands. S10 depends on S7 + the S9 board/cockpit shell, **not** on the S8
terminal panel. S11 and S12 are parallel — the heatmap is advisory and
never gates trunk movement.

---

## Slice 0 — Repo, build, protocol conventions, test harness

**Goal.** A monorepo where `make check` builds Gleam + Rust, runs both test
suites, and verifies cross-language protocol fixtures. No product behavior.

**Scope.** Workspace layout (`cp/` Gleam app, `netgw/`, `hostd/`, `worker/`
Rust crates, `proto/` shared fixtures); CI; CBOR golden-fixture round-trip
harness (Rust encodes → fixture file → Gleam decodes, and reverse);
canonical-encoding rule for anything that will ever be signed; **frozen
first-draft protocol types** (netgw frames, HostCommand, CommandOutcome,
HostClaim, worker handshake) so S3–S6 can build against fakes in parallel;
the N/N−1 compatibility convention (every protocol must interoperate with
its previous version; old fixtures are immutable); the integer-range
contract (epochs/seqs are nonnegative, ≤ `i64::MAX`, rejected above).

**Scope (de-risk spikes, timeboxed).** Canonical CBOR library viability in
Gleam; Postgres driver transaction + LISTEN behavior from Gleam; iroh/irpc
hello-world across two machines; detached-process adoption on macOS/Linux;
ACP `initialize` against two real harnesses; `git push` create-only and
`--force-with-lease=<ref>:<oid>` against a real GitHub repo (rulesets on).
Spike results re-baseline the per-slice estimates below.

**Non-goals.** No product behavior.

**Dependencies.** None.

**Introduces.** Protocol fixture format; version-negotiation test pattern;
`canonical_cbor` helpers both sides; fake-transport test doubles.

**Notes.** Canonical encoding is load-bearing: receipts sign "canonical
encoding of the above" ([C4 §4](./c4-code.md)). Decide map-key ordering and
integer width rules here, in one place, with fixtures both languages must
pass — retrofitting canonicalization after signatures exist is a rewrite.

**Tasks.**
1. Monorepo layout + `make check` (gleam test, cargo test, fixture check).
2. Canonical CBOR encode/decode in Rust and Gleam with shared fixtures.
3. Golden-fixture harness: adding a fixture fails CI until both sides pass.
4. Frozen protocol types + fake transport doubles.
5. All six spikes, each with a one-page written result.
6. CI matrix (Linux + macOS).

**Acceptance.** CI green; a deliberately corrupted fixture fails both
suites; every spike has a written outcome and a go/adjust decision.

**Crash/failure tests.** N/A (no runtime yet).

**Sizing.** ~1,200 / ~700 LoC (+ throwaway spike code, not counted).

**Exit artifact.** `make check` demo; fixture README; spike reports.

---

## Slice 1 — Event kernel (Postgres)

**Goal.** The only write path: commit-ordered append, snapshots, outbox,
command inbox, projection checkpoints — the schema and contract from
[C4 §2](./c4-code.md#2-event-store-postgres).

**Scope.** Migrations; `event_store.append` (counter-row lock, events +
outbox + inbox in one transaction); snapshot read/write with schema_ver +
checksum; checkpointed projection runner; shadow-projection rebuild with
atomic swap; LISTEN/NOTIFY bridge with catch-up-from-checkpoint.

**Non-goals.** No real aggregates (a toy `counter` aggregate is the test
vehicle); no netgw.

**Dependencies.** S0.

**Introduces.** `events`, `event_seq`, `command_inbox`, `snapshots`,
`outbox`, `checkpoints` tables; the append contract; upcasting decoder
convention (`.v1` suffix).

**Notes.** The commit-order counter is the subtle part — test it with two
deliberately interleaved transactions where allocation order ≠ commit order
and assert no projection ever skips an event. Snapshot mismatch must fall
back to full replay silently-correctly, loudly-logged.

**Tasks.**
1. Migrations + append function with expected-version guard.
2. Commit-order interleaving test (two sessions, artificial delay).
3. Command-inbox replay: same command_id returns recorded outcome —
   for **rejections too** (rejections are recorded transactionally).
4. Multi-event commands: contiguous global_seq range allocation test.
5. Projection runner: write + checkpoint in one tx; kill -9 mid-batch test.
6. Shadow rebuild: build v2 projection alongside v1, atomic swap.
7. Snapshot versioning: bump schema_ver, assert discard + replay.
8. Event upcasting: frozen `.v1` byte fixtures decode through a `.v2`
   upcaster; old fixtures are immutable and stay in CI forever.

**Acceptance.** 10k-event replay produces identical projection twice;
kill -9 during projection never skips or double-applies an event; a
recorded `.v1` event stream replays correctly under `.v2` decoders.

**Crash/failure tests.** Postgres restart mid-append (client sees error,
no partial write); duplicate command_id under concurrency (exactly **one
committed outcome** — both may run pure `decide`; only one commits).

**Sizing.** ~1,800 / ~1,500 LoC.

**Exit artifact.** `demo_kernel.sh`: appends, kills the runner mid-stream,
restarts, proves convergence.

---

## Slice 2 — Aggregates: task, attempt, workspace, host

**Goal.** The full decision core from [C4 §1](./c4-code.md#1-attempt-aggregate-gleam):
pure `decide`/`evolve` for all four aggregates, lease epochs, the generic
actor shell, lease manager timers.

**Scope.** Attempt state machine incl. `Cancelling`/`Unresponsive`; epoch
minting on retry with the `(recovery_generation, epoch)` fencing token;
epoch-fenced receipt rejection in `decide`; workspace aggregate (leases,
presence as typed events); host aggregate (enrollment events from
[C4 §3](./c4-code.md#3-host-enrollment-keys-trust-profiles), key rotation,
revocation, **lease-renewal/HostStatus claims as durable events**); task
aggregate; lease-manager timers rebuilt from replay; **placement policy**
(capacity/labels/stickiness over host projections — the pure decision
function; its live host-status inputs integrate in S4); minimal HTTP
gateway **with operator authentication** (single operator identity,
session issuance) — auth exists before the first browser ever connects.

**Non-goals.** No network to real hosts, no UI — commands arrive via test
harness and the authenticated HTTP gateway (curl-able).

**Dependencies.** S1.

**Introduces.** All aggregate event types (`.v1`); `LeaseEpoch`;
`TrustProfile`; anomaly-quarantine convention in `evolve`.

**Notes.** This is the highest-value property-test target in the system:
model-check the attempt machine (random command sequences never reach an
impossible state; every state is either terminal or has a liveness edge).
Stale-epoch rejection lives in `decide` and nowhere else — resist the
urge to also filter in the gateway, which would hide late work.

**Tasks.**
1. Attempt `decide`/`evolve` + state machine property tests.
2. Epoch fencing: recorded stale receipt → explicit rejection event.
3. Workspace/host/task aggregates.
4. Generic actor shell (snapshot + tail replay, inbox short-circuit,
   rejection recording).
5. Lease manager: TTL timers from replay; renewal via HostStatus claims;
   expiry emits repair commands.
6. Placement policy as a pure function + property tests (stale capacity,
   missed renewal, epoch rollover).
7. HTTP command gateway with operator auth (curl-able).

**Acceptance.** Property suite green (≥10k random sequences); full-replay
determinism; lease expiry after simulated silence emits exactly one repair
command; unauthenticated requests are rejected.

**Crash/failure tests.** Actor kill mid-command (client retry with same
command_id gets recorded outcome); node restart rebuilds timers correctly.

**Sizing.** ~2,900 / ~2,400 LoC.

**Exit artifact.** curl-driven demo: request attempt → watch state via a
projection query; kill the node mid-flow, restart, state intact.

---

## Slice 3 — netgw sidecar + local protocol

**Goal.** The BEAM↔Rust boundary from [C4 §5](./c4-code.md#5-netgw-local-protocol-beam--rust-sidecar):
versioned CBOR over a Unix socket, netgw supervised beside the release,
loopback iroh proven.

**Scope.** `NetgwHello`/`BeamHello` negotiation; `Dispatch`/`Delivered`/
`OutcomeIn`/`ClaimIn`/`TrustUpdate`/`Telemetry`/`HostDown` frames; Gleam
client with reconnect; outbox dispatcher draining through netgw —
`Delivered` sets `dispatched_at` only; `acked_at` requires a durably
consumed `CommandOutcome`; netgw iroh endpoint with a loopback echo peer
for tests; systemd units.

**Non-goals.** No enrollment, no real hostd — the peer is a test echo.

**Dependencies.** S1 (outbox rows exist to drain) + S0 frozen types.
Parallel with S2 and S5/S6.

**Introduces.** The local protocol (versioned independently); netgw crash
= redelivery semantics; the `TrustUpdate` snapshot channel.

**Tasks.**
1. Frame codec (shared fixtures from S0) + version negotiation.
2. netgw: socket server, iroh endpoint, irpc client pool skeleton,
   TrustUpdate snapshot store (re-sent by BEAM on reconnect).
3. Gleam: netgw client, reconnect/backoff, outbox dispatcher with the
   dispatched/acked distinction.
4. Loopback echo peer; end-to-end Dispatch→Outcome over real iroh.
5. N/N−1 compatibility test: current BEAM against previous-version netgw
   frames and vice versa (immutable old fixtures).
6. systemd units + socket permissions.

**Acceptance.** Outbox row dispatched over loopback iroh and acked only
after outcome consumption; protocol version mismatch refuses cleanly with
a logged reason; N/N−1 matrix green.

**Crash/failure tests.** kill netgw after `Delivered` but before
`OutcomeIn` → outbox redelivers, host-side dedupe replays the outcome,
nothing lost or double-applied; kill BEAM → netgw drops cleanly, no
zombie sockets.

**Sizing.** ~1,500 / ~900 LoC.

**Exit artifact.** Demo: watch an outbox row survive a netgw kill.

---

## Slice 4 — Enrollment, pinning, command delivery, receipts

**Goal.** Real host identity: one-time-token enrollment with mutual NodeId
pinning, signed receipts verified in netgw, epoch-carrying delivery —
[C4 §3–4](./c4-code.md#3-host-enrollment-keys-trust-profiles).

**Scope.** Enrollment token issue/redeem flow; `HostEnrolled` with
`TrustProfile`; hostd skeleton (iroh endpoint, irpc server, **durable
command journal** with `received/in_progress/completed` states, claim
signer — no workers yet); `CommandOutcome`/`HostClaim` canonical signing +
netgw verification against the `TrustUpdate` snapshot; `HostKeyRotated`,
`HostRevoked` enforcement at the verification boundary; `FenceEpoch`;
**HostStatus heartbeat/lease-renewal claims** feeding the S2 lease manager
and placement projections.

**Non-goals.** No agent execution; commands are inert probes
(`ScanWorkspaces` returning a stub).

**Dependencies.** S3 + S2 (aggregates consume outcomes/claims).

**Introduces.** hostd binary (skeleton); the full claim lifecycle:
outbox → netgw → hostd → signed outcome/claim → netgw verify → typed
command → event; host liveness as durable renewals (gossip/`HostDown`
stay advisory).

**Notes.** Test the *rejection* paths as hard as the happy path: claim
signed by revoked key, outcome with wrong idempotency key, claim with
fenced epoch — each must produce a recorded rejection event, not silence.
`in_progress` journal entries found after a hostd restart must reconcile
(re-check the effect) before answering.

**Tasks.**
1. Token issue/redeem; mutual pinning handshake; `HostEnrolled`.
2. hostd skeleton: endpoint, durable command journal, signer, config.
3. Canonical outcome/claim signing + netgw-side verification with
   TrustUpdate snapshots.
4. Rotation + revocation; revoked-key claim rejection test.
5. Epoch in every command; stale-epoch claim → recorded rejection.
6. HostStatus renewal claims → lease manager + placement projection.

**Acceptance.** Enroll a real second machine (or container) with one
command line on each side; probe command round-trips with verified
outcome; all three rejection paths produce recorded events; placement
sees the new host's capacity within one renewal interval.

**Crash/failure tests.** hostd offline for an hour → outbox retains,
redelivers on reconnect, exactly-once effect via the command journal;
netgw restart mid-outcome → outcome redelivered, inbox dedupes; hostd
kill -9 with an `in_progress` journal entry → reconciles before answering.

**Sizing.** ~2,400 / ~1,500 LoC.

**Exit artifact.** Two-machine enrollment demo script.

---

## Slice 5 — hostd worker supervision: spawn, re-adopt, fence

**Goal.** Detached execution workers that survive hostd restarts —
[C3 hostd table](./c3-components.md#hostd-rust), [C4 §6](./c4-code.md#6-execution-worker-rust-detached).

**Scope.** Worker binary skeleton (runs an inert long-lived child, no ACP
yet); own process group + detach; per-worker Unix socket +
`WorkerIdentity` handshake with **offers/chosen proto negotiation (N/N−1)**;
hostd worker supervisor: spawn, socket scan, re-adopt by (attempt, epoch)
with `resume_from` ACK cursor, `AdoptOutcome` handling; **claim spool**
(monotone `worker_seq`, never dropped, replayed from the cursor on
re-adoption, blocks the inert child when full); kill ladder for stale
epochs; SQLite manifest (advisory); quarantine-and-report for handshake
failures.

**Non-goals.** No ACP, no PTY, no telemetry journal beyond a heartbeat line.

**Dependencies.** S4 (commands arrive over the real channel); developable
against the S0 fake transport before that.

**Introduces.** worker binary; versioned hostd↔worker local protocol;
re-adoption semantics; the claim spool + ACK cursor.

**Notes.** The adoption matrix is the test surface: {worker alive, dead,
stale-epoch, socket-corrupt} × {hostd fresh start, restart, **upgrade
(N−1 worker under N hostd)**}. `HandshakeFailed → quarantine + report,
never silent kill` is the rule that keeps operator trust.

**Tasks.**
1. Worker: detach, socket, identity file, heartbeat, claim spool.
2. hostd: spawn worker per StartAgent-shaped probe command; ACK cursors.
3. Restart hostd → scan → re-adopt → replay unacked spool; full adoption
   matrix tests including proto-version skew.
4. FenceEpoch → kill ladder on stale workers; outcome reports it.
5. Manifest rebuild from scan (delete SQLite, rescan, converge).
6. Spool-full behavior: worker blocks rather than drops.

**Acceptance.** `systemctl restart hostd` with 5 live workers: all
re-adopted, zero child deaths, unacked claims replayed exactly once
(inbox-deduped upstream), control plane sees continuity.

**Crash/failure tests.** kill -9 hostd (same); kill a worker (hostd
reports `AgentExited` claim, CP replans); corrupt a worker socket
(quarantine event, other workers unaffected); stale-epoch worker after
CP-side retry (killed via ladder, outcome recorded); kill hostd between
spool read and CP ACK (claim redelivered, deduped).

**Sizing.** ~2,200 / ~1,500 LoC.

**Exit artifact.** Screencast-able demo: restart hostd under load.

---

## Slice 6 — jj workspaces + mandatory inventory

**Goal.** Per-attempt jj workspaces created/leased via typed commands, and
the cross-host workspace inventory as first-class truth.

**Scope.** jj driver (stock CLI, `--no-pager`, templates only);
`CreateWorkspace` → workspace + `WorkspaceLeased` outcome with change_id
**and pinned commit OID**; workspace reconciler scan → `InventoryObservation`
telemetry → typed presence events via reconciler; inventory projection
(host, path, attempt, epoch, change_id, **current commit OID vs expected**,
presence); typed retire flow (observation never deletes).

**Non-goals.** No candidate publication (S10); no conflict analysis (S11).

**Dependencies.** S4 (receipts), S2 (workspace aggregate). Parallel with S5.

**Introduces.** jj driver crate; inventory projection; presence semantics
(`present` / `missing` / `drifted { expected_oid, observed_oid }`).

**Notes.** Honor the repo rule that a host reporting `missing` is an
observation, not a deletion. Scan on a repo with uncommitted operator edits
must classify as `drifted`, not error. Drift compares the current commit
OID/tree to the expected pinned OID — a jj change id survives rewrites and
cannot detect drift alone; the acceptance test must include an edit that
preserves the change id.

**Tasks.**
1. jj driver with template-based machine output; error → verbatim refusal.
2. CreateWorkspace end-to-end with signed receipt.
3. Reconciler scan loop + on-demand `ScanWorkspaces`.
4. Inventory projection + retire command/event.
5. Drift detection test (out-of-band edit that keeps the same change id
   but moves the commit OID/tree).

**Acceptance.** Two hosts, six workspaces; inventory query shows all with
correct presence; deleting a directory out-of-band flips presence to
`missing` on next scan without deleting the inventory row.

**Crash/failure tests.** hostd restart mid-scan (next scan corrects);
jj CLI failure mid-create (refusal recorded, no phantom lease).

**Sizing.** ~1,500 / ~900 LoC.

**Exit artifact.** Inventory demo across two hosts.

---

## Slice 7 — ACP execution loop

**Goal.** Operator creates a task → attempt placed → workspace leased →
ACP harness runs in a detached worker → permission gate answered → final
outcome recorded. The **execution loop** exists after this slice; the full
product loop (reviewable candidate) lands at S10.

**Scope.** ACP adapter in the worker per [C4 §6](./c4-code.md#6-execution-worker-rust-detached):
piped stdio, ACP v1 pinned, strict stdout JSON-RPC validation, stderr →
telemetry journal; `session/update` → lossy telemetry through a **minimal
cockpit ingestion path** (per-attempt rooms, no UI yet — an SSE/log tap is
enough); permission requests / terminal exit results / final outcomes →
**claim spool** → hostd-signed claims → typed commands; `fs/*`
lease-scoped; `terminal/*` via process executor; capability gating for
optional ACP features (no-load, no-fs, no-terminal harnesses all work);
cancellation ladder ending in `AgentUnresponsive` when unproven;
best-effort `session/load` transcript comparison on respawn (no
cryptographic continuity claim); telemetry journal (hash-chained segments,
range fetch with explicit `RetentionGap`).

**Non-goals.** No PTY/rescue (S8); no candidate publication (S10) — the
demo ends at "agent finished, outcome recorded, files changed in
workspace".

**Dependencies.** S5 + S6.

**Introduces.** ACP adapter; claim/telemetry split in code; journal fetch;
cockpit room skeleton.

**Notes.** Use a scripted fake ACP harness for tests (deterministic
JSON-RPC transcript player) plus **two real harnesses** for acceptance
(the README requires de-risking against two). The fake must cover:
malformed stdout, deadline miss, permission flood, exit without result,
and every capability-absence combination — each maps to a specific
recorded event.

**Tasks.**
1. Fake harness transcript player + transcript corpus (incl. capability
   matrix).
2. ACP connection: init, session/new, prompt, update streaming.
3. Permission gate: block on oneshot, typed answer round-trip.
4. Claims (via spool) vs telemetry routing; journal appends + range fetch.
5. Minimal cockpit ingestion (rooms + tap).
6. Cancellation ladder + `AgentUnresponsive` path.
7. Protocol-fault handling (malformed stdout kills via ladder).
8. Two real-harness demo configs.

**Acceptance.** End-to-end demo on a remote host with two different real
harnesses; killing the worker, hostd, or netgw during the run yields a
truthful recorded state — `Failed`, `Unresponsive`, or continuity via
re-adoption — never a lie. (BEAM/Postgres outage recovery is S13 scope;
here the requirement is only that redelivered claims dedupe.)

**Crash/failure tests.** All fake-harness fault transcripts; hostd restart
mid-prompt (worker survives, telemetry gap tolerated, spooled claims
replayed and deduped).

**Sizing.** ~2,600 / ~1,900 LoC.

**Exit artifact.** The headline demo: task → remote agent → gate → outcome,
with a mid-run `systemctl restart hostd`.

---

## Slice 8 — PTY rescue shell, replay, multi-viewer

**Goal.** The separate interactive rescue shell per attempt: PTY custody in
the worker, VT snapshots, seq-numbered replay, N viewers, single input
grant.

**Scope.** `PtyHost` per [C4 §6](./c4-code.md#6-execution-worker-rust-detached);
`vt100`-based `TerminalModel` behind the trait; replay buffer; viewer
attach = snapshot + tail; input grants (one owner or none); size
authority; PTY bytes into the same journal; `OpenViewerStream` end-to-end
through netgw to a terminal in the web UI (minimal xterm.js panel is
acceptable here even though full UI is S9).

**Non-goals.** No ACP-over-PTY (piped ACP children never get a PTY — the
rescue shell is always a sibling).

**Dependencies.** S7.

**Tasks.**
1. PtyHost + TerminalModel trait + vt100 impl.
2. Replay buffer + snapshot/attach protocol.
3. Viewer fan-out with backpressure; input grant enforcement.
4. Rescue-shell spawn command (same workspace, same worker).
5. Minimal browser terminal panel.

**Acceptance.** Two browsers attached to one rescue shell see identical
screens; only the grant holder can type; detach/reattach after worker
outlives a hostd restart shows a correct repaint.

**Crash/failure tests.** Viewer disconnect storm (agent unaffected —
zero viewers never pauses the PTY); worker kill (terminal dies, journal
retains bytes, attempt state truthful).

**Sizing.** ~1,800 / ~1,000 LoC.

**Exit artifact.** Two-browser shared-terminal demo.

---

## Slice 9 — Web UI: board, cockpit, inventory

**Goal.** The three operational surfaces as Lustre server components over
projections: Board (tasks/attempts), Cockpit (semantic ACP timeline +
permission gates + terminal panel), Inventory (workspace browser with
retire).

**Scope.** Projections for board/cockpit/inventory; cockpit hub rooms
grown from the S7 skeleton (ACP updates + PTY frames fan-out);
permission-gate UI (the options the agent proposed, nothing invented);
attempt detail with journal tail; inventory table with presence badges
and typed retire. This slice deepens surfaces only — it introduces no
infrastructure S7/S8 did not already provide.

**Non-goals.** Review UI ships in S10 with candidates; no auth beyond the
single operator identity.

**Dependencies.** S7 (cockpit content), S8 (terminal panel), S6 (inventory).

**Tasks.**
1. Board projection + view.
2. Cockpit: ACP timeline, gates, live terminal.
3. Inventory view + retire flow.
4. Reconnect behavior (WS drop → resubscribe from checkpoint/seq).

**Acceptance.** Operator can run the whole S7 demo without curl; browser
refresh mid-run loses nothing.

**Crash/failure tests.** BEAM restart with open browsers (views recover
from projections; cockpit resumes from journal/replay seq).

**Sizing.** ~2,500 / ~800 LoC.

**Exit artifact.** Clickable product walkthrough.

---

## Slice 10 — Candidate publication + review: the first full product loop

**Goal.** `PublishCandidate` → immutable create-only ref pushed to the
ordinary Git remote; immutable review artifacts; accept/reject commands;
typed GC. Task → remote ACP agent → immutable candidate → in-UI review is
complete after this slice.

**Scope.** [C4 §7](./c4-code.md#7-git-integration-candidate-refs-trunk-cas-heatmap-keys)
`CandidateRef` protocol
(`refs/kanban/candidates/<attempt_id>/<epoch>/<candidate_id>`,
create-only, never force-pushed); CP mints a fresh `CandidateId` for
*every* publication — including rework within the same epoch; signed
publish outcome pins the exact commit **Git OID** + tree OID + journal
hash (jj change_id recorded as provenance only, never as review
authority); review projection (diff stat, `evolog` timeline);
`CandidateAccepted`/`CandidateRejected`/`ReworkRequested` verdicts bind
the exact pinned OID; GC command deletes refs only after a durable
terminal verdict; Review UI.

**Non-goals.** No trunk movement (S12); no heatmap (S11).

**Dependencies.** S7 (something to publish), S9 (UI shell).

**Notes.** Test ref-name collisions hard: rework in the same epoch mints a
new candidate ID and thus a new ref; the old ref remains until GC'd. A
create-only push that finds the ref already present at the *same* OID is
idempotent success (redelivery); present at a *different* OID is a
recorded collision refusal, never a force.

**Tasks.**
1. Publish path: jj snapshot → CandidateId mint → ref push → signed
   outcome with pinned Git OIDs.
2. Review projection + UI (diff, evolog, verdict buttons bound to OID).
3. Rework loop (`ReworkRequested` → back to Running; republish mints a
   new candidate ID in the same epoch).
4. Typed GC after terminal verdict.

**Acceptance.** Candidate visible on GitHub as an ordinary ref; review and
accept in UI against the pinned OID; rework after reject creates a new
candidate ref alongside the old, whether or not the epoch changed.

**Crash/failure tests.** Push interrupted (redelivery is idempotent —
create-only + same OID = same recorded outcome; different OID = recorded
collision); GC command against already-deleted ref (recorded no-op, not
error).

**Sizing.** ~1,200 / ~800 LoC.

**Exit artifact.** GitHub-visible candidate + in-UI review demo.

---

## Slice 11 — Conflict heatmap

**Goal.** For each open candidate: does it still apply cleanly to current
trunk, and where does it collide with other candidates?

**Scope.** `HeatmapKey` (pinned base Git OID + candidate Git OID +
algorithm version — never jj change IDs, which survive rewrites and would
poison the cache); host-side merge-check via jj on ephemeral workspaces;
content-addressed cache (immutable entries, never invalidated; a new
algorithm version is a new key); heatmap projection + Review UI overlay.

**Dependencies.** S10.

**Tasks.**
1. Merge-check command + receipt (`Clean` / `Conflicts(files)`).
2. Cache keyed by `HeatmapKey`; recompute only on new (base, candidate).
3. Pairwise candidate collision matrix (bounded: open candidates only).
4. UI overlay.

**Acceptance.** Trunk advance flips exactly the affected candidates'
status; cache hit rate observable; identical keys never recompute.

**Crash/failure tests.** Host restart mid-check (redelivered, idempotent);
cache wipe (recompute converges to identical results — pinned inputs).

**Sizing.** ~700 / ~400 LoC.

**Exit artifact.** Heatmap demo with three overlapping candidates.

---

## Slice 12 — Trunk compare-and-swap saga

**Goal.** Accepting a candidate moves trunk atomically-enough against a
remote Kanban does not own, with external pushes treated as normal.

**Scope.** `MoveTrunk { expect, to }` saga per [C4 §7](./c4-code.md#7-git-integration-candidate-refs-trunk-cas-heatmap-keys):
`ObserveRemoteRefs` (fetch, read actual remote trunk OID) → assert
`expect` matches the exact observed Git OID → CAS push
(`--force-with-lease=<trunk>:<expect>` semantics) → signed outcome with
old/new OIDs; `TrunkDiverged` on failed CAS → reconciler replans (rebase
candidate, re-review); saga state in the attempt/repo aggregate, resumable
after CP restart.

**Dependencies.** S10 (verdicts), S11 recommended (rebase decisions).

**Notes.** External pushes to trunk are *expected, normal behavior* on a
remote Kanban does not own — divergence is a fact to record and replan
from, never an error to hammer or a corruption to alarm on. A push whose
outcome is unknown (connection died mid-push) resolves by re-observing the
remote ref: trunk at `to` = success; at `expect` = retry; anything else =
diverged.

**Tasks.**
1. Saga steps as events (started/observed/pushed/diverged/completed).
2. `ObserveRemoteRefs` + CAS push implementation + signed outcome.
3. Divergence path: external push mid-saga test.
4. Push-uncertainty test (kill connection mid-push; re-observation
   resolves to exactly one recorded outcome).
5. Resume-after-restart test (saga picks up from its own events).

**Acceptance.** Accept → trunk moves on GitHub; concurrent external push →
`TrunkDiverged` recorded, candidate flagged for rebase, no forced write
ever.

**Crash/failure tests.** BEAM restart between observe and push (saga
resumes, re-observes — stale `expect` diverges safely); connection loss
mid-push (uncertainty resolved by observation, never blind retry);
duplicate saga commands (inbox dedupes).

**Sizing.** ~900 / ~700 LoC.

**Exit artifact.** Race demo: external `git push` during accept.

---

## Slice 13 — Teleport, recovery, outage reconciliation

**Goal.** Attempts move between hosts, and every outage class in the
[failure envelope](./README.md#failure-envelope-stated-not-implied) has a
tested reconciliation path.

**Scope.** Teleport = fence old epoch → GC-eligible old workspace → new
lease on target host → reconstruct from candidate ref (pinned Git OID);
CP-outage host behavior (agents run, results quarantine in the durable
claim spool, re-fence + claim redelivery on return) — distinct from host
outage (lease expiry → replan, S5 fencing already covers the truth side);
full reconciliation pass (manifest + command journal vs intents → typed
repairs) on host reconnect; **PITR restore runbook**: restore Postgres →
increment `recovery_generation` *before* accepting any traffic → all
claims/outcomes fenced under the old generation are quarantined loudly
for operator review, never silently applied.

Baseline reconnect/claim replay already exists from S3/S5/S7; this slice
adds the *deep* recovery paths, not the everyday ones.

**Dependencies.** S10 (refs to reconstruct from), S5 (fencing), S6
(inventory).

**Tasks.**
1. Teleport command sequence + signed outcomes.
2. CP-outage soak test (stop BEAM 10 min under live agents; verify
   spool quarantine + convergent redelivery).
3. Host-loss replan (kill a host VM; lease expiry replans to another).
4. PITR restore drill: restore to an earlier point, rotate recovery
   generation, verify old-generation claims quarantine.
5. Reconciler full-diff pass + repair-command idempotency tests.

**Acceptance.** Teleport a mid-flight attempt's *candidate* to another
host and resume work there under epoch+1; 10-minute CP outage converges
with zero lost claims and zero double-applied effects; post-PITR, no
pre-restore worker can mutate state under the new generation.

**Crash/failure tests.** Everything above *is* the crash suite; plus
combined failure (hostd restart during CP outage).

**Sizing.** ~1,200 / ~900 LoC.

**Exit artifact.** Outage-soak report checked into `docs/v2/`.

---

## Slice 14 — Security profiles, backup, observability, packaging, chaos

**Goal.** Operable by someone who is not the author.

**Scope.** Security-profile *plumbing*: `HostEnrolled` records the
declared profile and claim strength; the trusted-host profile is fully
specified and the enrollment/claim model is ready to accept a
`sandboxed` profile later (the sandbox implementation itself is v2.1 per
the [README](./README.md)). Key lifecycle ops: host key rotation and
revocation (re-enrollment, old-key claims rejected with a recorded
reason). Postgres PITR: off-host WAL archiving config + scripted restore
drill with **restore validation** (event-hash spot checks, projection
rebuild parity). Durability hardening: hostd command-journal corruption
handling (detect torn/invalid entries, quarantine journal, refuse
unsafe replay), worker claim-spool exhaustion policy (block new
state-bearing work, never drop claims). Journal retention quotas
(oldest-first, never block the agent); metrics/log conventions (outbox
lag, claim rejections, adoption outcomes, projection lag); packaging
(single CP release + netgw, hostd installer, worker shipped inside hostd
package); chaos suite that runs the S13 scenarios continuously in
CI-nightly.

**Non-goals.** Sandbox *implementation* (v2.1); multi-node BEAM, hot
standby (v2.1+); multi-operator auth.

**Dependencies.** Everything prior.

**Tasks.**
1. Profile field plumbing + claim-strength gating (trusted-host only).
2. Host key rotation/revocation flow + rejected-claim tests.
3. PITR configs + scripted restore drill (fresh VM → restored CP →
   validation checks pass).
4. Command-journal corruption + spool-exhaustion handling and tests.
5. Retention enforcement + disk-pressure test.
6. Metrics + dashboards for the four lag/rejection signals.
7. Packaging + install docs for CP and hosts.
8. Nightly chaos pipeline.

**Acceptance.** Restore drill: yesterday's WAL → working CP passing
validation, hosts reconnecting and reconciling, agents' quarantined
claims accepted or rejected per generation/epoch rules. A stranger
installs a host from docs alone. A revoked host key cannot land a single
claim.

**Crash/failure tests.** Disk-full on journal (agent unaffected, retention
event recorded); claim-spool full (state-bearing work blocks, nothing
dropped); corrupted command journal (quarantined, no unsafe replay);
restore-to-point-before-an-attempt (host claims for unknown epochs
quarantined loudly).

**Sizing.** ~1,700 / ~1,200 LoC (+ config/scripts).

**Exit artifact.** Runbook + drill report + dashboard screenshot.

---

## Totals

| | Production | Tests |
|---|---|---|
| S0–S2 (kernel + domain) | ~5,900 | ~4,600 |
| S3–S6 (network + host runtime) | ~7,600 | ~4,800 |
| S7–S9 (execution + surfaces) | ~6,900 | ~3,700 |
| S10–S14 (review, trunk, ops) | ~5,700 | ~4,000 |
| **Total** | **~26,100** | **~17,100** |

Consistent with the README's ~17–29k envelope. The spine (S0–S7) is
~16,100 production LoC before the execution loop demos end-to-end — that
is the irreducible cost of the honesty guarantees (epochs, fencing,
signed claims, detached workers); everything after S7 is optional-order
deepening, and the first full reviewable product loop closes at S10.
