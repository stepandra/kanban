# Kanban v2 — Greenfield Architecture (C4)

This folder documents a **greenfield redesign** of Kanban as a 24/7,
failure-resilient control plane for coding agents, written in Gleam on the
BEAM. It deliberately ignores the current TypeScript implementation and prior
ADRs; nothing here is bound by `docs/decisions/`. Treat it as the v2 proposal,
not a description of the current checkout.

## Documents

| Doc | C4 level | Content |
|---|---|---|
| [c1-system-context.md](./c1-system-context.md) | C1 | Who uses the system, what it talks to, trust boundaries |
| [c2-containers.md](./c2-containers.md) | C2 | Deployable containers, protocols, key runtime flows, ACP + session-substrate decisions |
| [c3-components.md](./c3-components.md) | C3 | Components inside the Control Plane and hostd, with per-component failure stories |
| [c4-code.md](./c4-code.md) | C4 | Code-level types for the load-bearing 20%: attempt aggregate, event store, enrollment, host protocol, netgw protocol, execution worker, Git integration |
| [implementation-slices.md](./implementation-slices.md) | — | Dependency-ordered implementation slices with scope, tasks, acceptance criteria, crash tests, and sizing |

## Goals

- Runs 24/7 on a server; operators connect and disconnect at will.
- Drives coding agents on the server itself **and** on remote execution
  hosts (laptops, devboxes) with no VPN or port forwarding.
- Survives failure at every magnitude: viewer disconnect, agent crash,
  session crash, host daemon crash, host reboot, control-plane restart —
  each recovers to a defined state by replay/reconciliation, never by
  operator archaeology.
- Much higher load than v1: hundreds of concurrent attempts across many
  hosts and projects.
- Workspace inventory across all hosts is a **first-iteration** feature.

## Non-goals for the first iteration (v2.0)

Deliberately deferred to keep effect-per-line high (~17–29k LoC production
code target, see below):

- Custom jj `Backend`/`OpStore` on iroh-blobs (the "repo fabric"). v2.0 uses
  **stock jj with its Git backend**, driven via CLI + templates.
- A deterministic fabric→Git gateway. GitHub stays a first-class, ordinary
  Git remote.
- Campaign sagas / cross-project Tracks rollups. The event model leaves room
  for them; the first iteration ships tasks, attempts, workspaces, sessions,
  review.
- Multi-operator auth/tenancy beyond a single trusted operator identity.

## Load-bearing technology decisions

| Decision | Choice | Why |
|---|---|---|
| Control-plane language/runtime | **Gleam on BEAM (OTP)** | Type-safe actors, supervision trees, cheap concurrency, restart-by-design |
| State model | **Event sourcing** (single append-only log per aggregate, Postgres) | Truth is replayable; projections are disposable; crash recovery = replay |
| Persistence | **Postgres** | Boring, durable, one backup story; event log + projections + snapshots |
| Network/identity | **iroh** (NodeId per host, irpc for RPC, gossip for lossy telemetry only) | NAT traversal without VPN; cryptographic host identity; QUIC streams |
| BEAM↔iroh bridge | **netgw** — a supervised Rust sidecar next to the BEAM release | irpc is Rust-to-Rust (Tokio, no cross-language bindings); netgw owns the control-plane iroh endpoint and all irpc clients, and speaks a small versioned protocol to Gleam over a local socket |
| VCS | **stock jj (Git backend)** per-attempt workspaces | Stable change IDs as metadata, **Git commit OIDs as the immutable review/reconstruction authority**, conflicts-as-data, `evolog` time travel, candidate-ref reconstruction on any host — all without forking jj |
| Host agent | **hostd** (Rust binary per execution host) + **detached per-attempt execution workers** | hostd supervises and re-adopts workers; a worker owns the agent child, stdio/PTY, and journal, and **survives hostd restart/upgrade** |
| Agent control | **ACP first** (JSON-RPC over child stdio), PTY fallback | One adapter covers every ACP harness; structured tool calls, plans, diffs, and permission requests instead of scrollback scraping — see [c2-containers.md](./c2-containers.md#agent-control-acp-first-pty-fallback) |
| Terminal sessions | **detached execution workers own PTYs natively** (portable-pty + swappable VT model, `vt100` first) | See decision record in [c2-containers.md](./c2-containers.md#session-substrate-decision); no external mux survives its own daemon death anyway, so durability comes from the event log + journal, and workers survive hostd restarts |
| Web UI | **Lustre server components** served by the control plane | One language end to end; UI is a projection, holds no truth |

## Truth hierarchy

1. **Event log (Postgres)** — workflow truth: tasks, attempts, leases,
   workspaces, sessions, review verdicts.
2. **jj/Git object store** — code truth: commits, change IDs, conflicts,
   bookmarks, hidden attempt refs.
3. **Everything else is telemetry** — terminal output, gossip presence,
   session metadata, host self-reports. Telemetry may inform reconciliation;
   it never mutates workflow state directly.

A host reporting a workspace `missing` is an *observation* to reconcile, not
an authoritative deletion — inventory rows die only via typed events.

## Failure envelope (stated, not implied)

v2.0 targets: any **process** failure (viewer, agent, worker, hostd, netgw,
BEAM node) recovers automatically by replay/re-adoption/reconciliation.
**Server or Postgres loss** is accepted unavailability: RPO = last archived
WAL segment (Postgres PITR + off-host WAL archiving required), RTO = manual
restore, single control-plane node. Hot standby and multi-node BEAM are
explicitly v2.1+. Execution hosts keep agents running through control-plane
outages; results quarantine until leases re-fence. Because a PITR restore
can rewind epoch counters, the fencing token is `(recovery_generation,
epoch)`: the restore runbook rotates the recovery generation **before**
accepting host traffic, so pre-restore workers and claims are quarantined
for explicit reconciliation instead of colliding with re-minted epochs.

## Trust posture

Two host security profiles, declared per host at enrollment:

- **`trusted-host` (v2.0 default):** harnesses run with the host user's
  authority. Receipts then prove *host* provenance, not agent innocence —
  the docs say so honestly. NodeId keys and hostd state are file-permission
  separated, best effort.
- **`sandboxed` (v2.1):** per-attempt UID/container isolation, workspace-only
  mounts, no inherited credentials; the profile every security-relevant
  claim in C1 assumes. Interfaces are designed for it now (workers already
  isolate per attempt) so it lands without protocol changes.

Secrets never appear in events, receipts, manifests, or journals — only
references; hostd brokers host-scoped Git credentials and attempt-scoped
harness credentials.

## Size posture

Component budget for v2.0 (production code, tests excluded), with the
mandatory workspace inventory included:

| Component | Budget |
|---|---|
| Gleam control plane + Lustre UI | 11–16k |
| Rust hostd + execution workers | 7–11k |
| Rust netgw sidecar | 1.5–3k |
| Enrollment, secrets brokering, migrations, glue | 2–4k |
| **Total** | **21.5–34k** (+ ~20% contingency) |

Tests in the 35–50k range. Scope gates if the budget slips: the conflict
heatmap and cross-host `evolog` are deferrable; durability, fencing, and
security mechanisms are not. Early de-risk spikes required for: netgw
protocol, worker re-adoption, Git candidate-ref CAS publication, and ACP
adapter against two real harnesses.
