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
| [c4-code.md](./c4-code.md) | C4 | Code-level types for the load-bearing 20%: attempt aggregate, event store, host protocol, session host/ACP adapter |

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
| VCS | **stock jj (Git backend)** per-attempt workspaces | Stable change IDs, conflicts-as-data, `evolog` time travel, hidden-ref teleportation — all without forking jj |
| Host agent | **hostd** (single Rust binary per execution host) | Owns agent processes, jj CLI, workspace inventory, signed receipts |
| Agent control | **ACP first** (JSON-RPC over child stdio), PTY fallback | One adapter covers every ACP harness; structured tool calls, plans, diffs, and permission requests instead of scrollback scraping — see [c2-containers.md](./c2-containers.md#agent-control-acp-first-pty-fallback) |
| Terminal sessions | **hostd owns PTYs natively** (portable-pty + swappable VT model, `vt100` first) | See decision record in [c2-containers.md](./c2-containers.md#session-substrate-decision); no external mux survives its own daemon death anyway, so durability must come from the event log, not the mux |
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

## Size posture

Rough production-code estimate for v2.0 including the mandatory workspace
inventory: **18–29k LoC** (Gleam control plane + Lustre UI ≈ 11–17k, Rust
hostd ≈ 6–10k, glue/migrations ≈ 1–2k), with tests in the 30–45k range.
The deferred fabric items above are what kept the earlier 40–66k estimate
out of scope.
