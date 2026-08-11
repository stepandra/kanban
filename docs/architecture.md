# Architecture Overview

Kanban is a local Node runtime plus a React app for running many coding-agent tasks in parallel.

## Accepted target and migration status

The current checkout still implements local PTY/zmx workers, a special per-task
Amp Orb path, and a per-task Amp Fixer. Those paths describe the implementation
below, but they are no longer target architecture and must not be deepened.

The accepted target is recorded in
[`decisions/2026-08-11-grok-build-workers-and-qa-campaigns.md`](./decisions/2026-08-11-grok-build-workers-and-qa-campaigns.md):

- Grok Build is the primary implementation harness; model routing and Rhai
  workflows stay internal to Grok Build;
- remote workers are addressed through fenced host placement and Grok ACP
  sessions rather than a new central PTY protocol;
- Amp owns Architecture, Product, UI/UX planning, and one `a1.xxlarge` Orb per
  QA/production campaign, not per-task implementation;
- Review contains immutable task candidates; one frozen campaign integrates,
  tests, fixes, and verifies, after which Kanban requests fenced VCS publication
  and atomically accepts the batch from its receipt; and
- every non-deleted task or campaign workspace is a durable, host-qualified
  object visible in a global workspace inventory;
- Tracks is the primary cross-project delivery and operations view; QA campaigns
  are explicit frozen candidate sets that may span tracks and milestones; and
- Zellij remains a supported Focus Cockpit with Amp Architect on the left and a
  bounded identity-driven stack of task executions and QA campaigns on the
  right. It is never task or campaign authority.

There are three big ideas to hold in your head:

1. Kanban is the durable authority; Browser and Zellij are clients and projections.
2. Tracks provides the zoomed-out delivery/operations view, while Board remains a tactical project task editor.
3. Grok Build runs implementation through fenced ACP sessions; Amp Architect plans, and one Amp Orb completes each frozen QA campaign.

If you remember nothing else, remember this:

- execution is attempt-, candidate-, and workspace-oriented rather than pane-oriented
- only typed Kanban operations may mutate task, campaign, workspace, or acceptance state

## Decision record: Cline was removed as a Kanban worker

Kanban previously shipped a second execution path: Cline ran through a native
SDK-backed chat runtime (`src/cline-sdk/` on top of the published
`@clinebot/core` / `@clinebot/llms` packages), while every other agent ran as
a PTY-backed CLI process. The native runtime and the later external Cline
worker path have both been removed:

- `src/cline-sdk/` and its TRPC surface (provider settings, OAuth, MCP
  settings, task chat endpoints) are gone
- the `@clinebot/*` packages are no longer dependencies
- the Cline web-ui surfaces (chat panel, provider/model pickers, account and
  MCP settings) are gone
- Cline is not present in the agent catalog, launch adapters, task creation
  controls, or Amp task schema
- persisted cards that still reference Cline are retained as blocked legacy
  cards and must be reassigned before they can start

Tradeoff, stated plainly: removing the native runtime **diverges from upstream
`cline/kanban`**, so upstream merges will be harder — anything upstream that
touches `src/cline-sdk/`, the Cline chat UI, or the provider-settings TRPC
surface will conflict. We accepted that cost in exchange for a single agent
execution model, a much smaller dependency and cold-start surface (the SDK
host can no longer be started accidentally, e.g. on trash-restore probes), and
the removal of an entire settings/OAuth/MCP stack and an unused worker
integration.

## Current implemented dependency map

This diagram shows the current runtime dependencies and authority boundaries,
including legacy paths that the accepted target removes. Solid arrows are
commands or authoritative writes. Dashed arrows are read-only projections,
telemetry, or navigation.

```mermaid
flowchart LR
    operator["Operator"]
    architect["Amp Architect"]
    browser["Kanban browser UI"]
    ampPlugin["Amp plugin<br/>amp/kanban.ts"]

    subgraph kanban["Kanban — task and workflow authority"]
        trpc["TRPC + WebSocket API"]
        runtime["Local runtime"]
        state[("Board, generations,<br/>review and acceptance")]
        workspace["jj-native task workspaces"]
        terminal["PTY session manager"]
        hooks["Worker hooks"]
        reviewQueue["Per-task review Fixer queue"]
    end

    subgraph orchestration["Juja — execution adapter and cockpit"]
        juja["juja CLI"]
        absurd[("Absurd + Postgres<br/>attempts, admission, retries")]
        absurdWorker["Juja Absurd worker"]
        zellij["Zellij cockpit"]
    end

    subgraph execution["Execution surfaces"]
        zmx["zmx durable sessions"]
        cliWorkers["Claude / Codex / Grok / Kimi"]
        ampTaskOrb["Amp task Orb"]
        ampFixer["Amp Fixer / Integrator"]
    end

    operator --> browser
    architect --> ampPlugin
    browser --> trpc
    ampPlugin -->|"kanban_tasks / CLI"| runtime
    trpc --> runtime
    runtime --> state
    runtime --> workspace

    runtime -->|"enqueue generation + unique queue fence"| juja
    juja --> absurd
    juja -->|"attempt receipt"| runtime
    absurd --> absurdWorker
    absurdWorker -->|"internal direct-start"| runtime
    runtime --> terminal
    terminal --> zmx
    zmx --> cliWorkers
    cliWorkers -.->|"session telemetry / checkpoints"| hooks
    hooks -.-> runtime
    cliWorkers -->|"explicit task submit"| runtime

    ampPlugin -->|"allocate idle Orb,<br/>prepare / claim, then start turn"| ampTaskOrb
    ampTaskOrb -->|"submit via plugin"| runtime
    runtime -->|"post-Review handoff<br/>(not atomic with board write)"| reviewQueue
    reviewQueue --> ampFixer
    ampFixer -->|"verified accept"| runtime

    zellij -.->|"board projection"| runtime
    zellij -.->|"attach / focus"| zmx
    absurd -.->|"attempt projection"| runtime
    state -.->|"streamed projection"| trpc
    trpc -.-> browser

    classDef human fill:#3e2d16,stroke:#d4a72c,color:#e6edf3
    classDef kanbanNode fill:#063e34,stroke:#3fb950,color:#e6edf3
    classDef scheduler fill:#382462,stroke:#a371f7,color:#e6edf3
    classDef executionNode fill:#083344,stroke:#4c9aff,color:#e6edf3
    classDef data fill:#4c1d55,stroke:#d8b4fe,color:#e6edf3

    class operator,architect human
    class browser,ampPlugin,trpc,runtime,workspace,terminal,hooks,reviewQueue kanbanNode
    class juja,absurdWorker,zellij scheduler
    class state,absurd data
    class zmx,cliWorkers,ampTaskOrb,ampFixer executionNode
```

## Accepted target orchestration

This is the replacement flow. A solid arrow into Kanban is an authenticated,
typed command that is validated against the current fence. Dashed arrows are
identity-routed attachment, observation, or projection; they never infer a
lifecycle transition.

```mermaid
flowchart LR
    operator["Operator"]
    architect["Amp Architect<br/>Architecture · Product · UI/UX"]

    subgraph surfaces["Operating surfaces — clients, not workflow authority"]
        tracks["Browser: global Tracks"]
        board["Browser: project Board"]
        inventory["Browser: Workspaces"]
        cockpit["Zellij Focus Cockpit<br/>Architect left · selected work right"]
    end

    subgraph kanban["Kanban — durable workflow authority"]
        api["Typed API / kanban_tasks"]
        taskState[("Tasks · dependencies<br/>placement · generation/fence")]
        candidates[("Immutable candidates")]
        campaigns[("Frozen QA campaigns<br/>attempt fence · acceptance · release")]
        releaseIntents[("Immutable release intents<br/>+ publication receipts")]
        focus[("Desired FocusSelection")]
        workspaceRegistry[("ProjectRoots · ExecutionWorkspaces<br/>WorkspaceUse history")]
    end

    subgraph delivery["Absurd — durable delivery authority"]
        taskAttempts[("Task delivery attempts")]
        campaignAttempts[("Campaign delivery attempts")]
        releaseAttempts[("Release delivery attempts")]
    end

    subgraph adapters["Delivery executors — not lifecycle authority"]
        hostAdapter["Narrow host adapter"]
        campaignAdapter["Amp campaign adapter"]
        releaseAdapter["VCS release adapter"]
    end

    subgraph implementation["Remote implementation host"]
        grok["Grok Build harness<br/>LLM Gateway · Rhai · subagents"]
        acp["Exact fenced ACP session"]
        taskWorkspace["Task ExecutionWorkspace"]
    end

    subgraph qa["One frozen campaign = one owning Amp execution"]
        ampOrb["One a1.xxlarge Amp Orb thread"]
        campaignWorkspace["One writable campaign ExecutionWorkspace"]
        qaLanes["Read-only QA fan-out"]
        manifest["Verified revision<br/>+ evidence manifest"]
    end

    vcs[("Execution hosts + VCS<br/>physical files, refs, history")]

    operator --> tracks
    operator --> board
    operator --> inventory
    architect --> api
    tracks --> api
    board --> api
    inventory --> api

    api --> taskState
    api --> candidates
    api --> campaigns
    api --> releaseIntents
    api --> focus
    api --> workspaceRegistry

    taskState -->|"fenced task assignment"| taskAttempts
    workspaceRegistry -->|"pre-recorded workspaceId<br/>+ placement"| taskAttempts
    taskAttempts --> hostAdapter
    hostAdapter -->|"materialize exact identity"| taskWorkspace
    hostAdapter --> acp
    acp --> grok
    grok --> taskWorkspace
    taskWorkspace --> vcs
    grok -->|"candidate artifact + evidence"| hostAdapter
    hostAdapter -->|"candidate receipt + task fence"| api

    candidates -->|"atomic frozen set<br/>one project/repository"| campaigns
    campaigns -->|"fenced campaign assignment"| campaignAttempts
    workspaceRegistry -->|"pre-recorded campaign workspaceId"| campaignAttempts
    campaignAttempts --> campaignAdapter
    campaignAdapter -->|"resume exact Amp owner"| ampOrb
    campaignAdapter -->|"materialize exact identity"| campaignWorkspace
    ampOrb --> campaignWorkspace
    campaignWorkspace --> vcs
    ampOrb -->|"immutable checkpoint"| qaLanes
    qaLanes -->|"findings only"| ampOrb
    ampOrb -->|"fix + retest"| campaignWorkspace
    ampOrb --> manifest
    manifest -->|"verification receipt + campaign fence"| api

    releaseIntents --> releaseAttempts
    releaseAttempts --> releaseAdapter
    releaseAdapter -->|"idempotent compare-and-set<br/>publish exact SHA"| vcs
    vcs -->|"publication receipt"| releaseAdapter
    releaseAdapter -->|"durable delivery result"| releaseAttempts
    releaseAttempts -->|"VCS receipt + release fence<br/>atomic Kanban batch accept"| api

    vcs -.->|"present / missing / revision"| workspaceRegistry
    focus -.-> cockpit
    cockpit -.->|"exact ACP attach/input"| acp
    cockpit -.->|"exact Amp thread attach<br/>or read-only deep link"| ampOrb
    taskState -.-> tracks
    candidates -.-> tracks
    campaigns -.-> tracks
    workspaceRegistry -.-> inventory
```

The target deliberately has no Amp task worker, per-task Fixer, fixed
agent-named pane, newest-session discovery, or terminal-to-lifecycle arrow.
`ProjectRoot` means a registered host-qualified repository checkout;
`ExecutionWorkspace` means a physical task or campaign directory derived from
one selected `ProjectRoot`. Absurd retry records, ACP events, Rhai progress, Amp
thread state, and Zellij panes are operational evidence around the relevant
Kanban identity, never substitutes for it. Campaign acceptance is one atomic
Kanban transaction after a fenced, idempotent VCS publication receipt; no claim
is made that Kanban storage and Git participate in one cross-system transaction.

The most important non-obvious split is that `juja` is the adapter into
Absurd, while Absurd owns durable execution attempts. `zmx` keeps an admitted
worker process alive, and Zellij only observes or focuses it. The Amp plugin is
the Architect/task-tool boundary. Its special task-Orb and per-task Fixer paths
are legacy migration code, not future extension points. A worker report,
terminal process, pane, Orb thread, ACP stream, Rhai workflow, or Absurd attempt
can never accept a card by itself.

The target cockpit replaces the current harness-shaped zmx lookup. It keeps the
Amp Architect thread on the left and projects an explicit bounded working set of
exact task execution/ACP and campaign/Amp-thread identities on the right. The
browser selects or opens that working set from Tracks, Task, and Campaign
views; closing a pane does not change lifecycle.

## Request and Stream Diagram

```text
User action in UI
    |
    v
component
    |
    v
hook or runtime query helper
    |
    v
TRPC client
    |
    v
app-router.ts
    |
    v
runtime-api.ts
    |
    +--> terminal/session-manager.ts for all agents


Live runtime output
    |
    +--> terminal session summaries
    |
    v
runtime-state-hub.ts
    |
    v
websocket stream
    |
    v
browser runtime state hooks
    |
    v
board, detail view, and terminal panels
```

## Current implementation mental model

Kanban is easiest to understand if you separate it into three layers of responsibility.

The browser layer is the presentation and orchestration layer. It renders the board, detail view, settings, and terminal surfaces. It also owns short-lived UI state such as panel visibility, form drafts, and optimistic rendering.

The runtime layer is the control layer. It decides what session to start, where it should run, what worktree or workspace it belongs to, what command should be used, and what state should be streamed back to the browser.

The execution layer is the actual agent implementation: a CLI process attached
to a durable zmx session. Absurd owns the queued/running execution attempt and
admission; Kanban owns the task, generation, workspace, and deterministic zmx
identity. A terminal attachment is only a local projection of that execution.

That split explains a lot of the architecture:

- the browser should not be the source of truth for session or execution-attempt lifecycle
- the runtime should coordinate work, not render UI
- agent differences belong in the agent catalog and per-agent launch adapters, not in parallel runtime stacks

## Current runtime modes

Kanban currently supports two runtime modes.

| Runtime mode | Used for | Scope | Backing implementation | Why it exists |
| --- | --- | --- | --- | --- |
| CLI-backed task terminal | Claude Code, Codex, Grok, and Kimi | task-scoped | PTY-backed process runtime | these are the current launch-supported local workers; Grok Build over ACP is the accepted remote target |
| Workspace shell terminal | the bottom shell panel | workspace-scoped | PTY-backed shell process | this is for manual commands in the repo, not task execution |

Older Droid, Kiro, Gemini, and OpenCode values remain parseable migration input
but are not launch-supported worker choices.

## Core Concepts

These terms come up everywhere in the codebase.

| Concept | Meaning | Why it matters |
| --- | --- | --- |
| Workspace (current API) | an indexed git repository that Kanban has opened | this overloaded local name migrates to the explicit Project and ProjectRoot concepts |
| Project (target) | the logical Kanban scope for one repository | Tracks and campaigns use this boundary independent of checkout location |
| ProjectRoot (target) | one registered host-qualified checkout for a Project | placement selects it before creating an ExecutionWorkspace |
| ExecutionWorkspace (target) | one host-qualified task or campaign directory derived from a ProjectRoot | its durable lifecycle and usage history are not inferred from path presence |
| Task card | a board item with a prompt, base ref, and review settings | a task is the unit of work the board cares about |
| Worktree | a per-task git worktree | most task agents run inside one |
| Task session | the local runtime attachment associated with a task card | it is not proof that an Absurd attempt is queued or running |
| Runtime summary | the small state object the board uses to know whether a local session is idle, running, awaiting review, interrupted, or failed | this is a bounded runtime projection, not scheduler truth |

## Who Owns What

One of the biggest cleanup themes was making ownership clearer. The system is much easier to work on if every concern has one obvious owner.

| Concern | Primary owner | Notes |
| --- | --- | --- |
| board state, workspace state, review state | Kanban | this is product state |
| worktree lifecycle | Kanban | task worktrees are a Kanban concept |
| execution attempts, admission, waits, retries, and results | Absurd | Kanban may retain an attempt reference and bounded read-only status projection |
| deterministic zmx identity and process attachment | Kanban | retries within a task generation reuse the same identity |
| agent authentication and provider settings | each agent CLI | CLIs own their own login and config; Kanban only launches them |
| UI rendering state for detail view | browser hooks and components | local UI state belongs in the frontend |
| live state fanout to the browser | `runtime-state-hub.ts` | the browser should react to streamed state, not poll |

If a change feels awkward, it is often because ownership is being blurred.

## Backend Architecture

The backend has a few important subsystems, each with a different job.

### TRPC layer

`app-router.ts` defines the typed contract between the browser and the runtime.

`runtime-api.ts` is the coordinator behind that contract. It should be the front door for runtime procedures, but not the place where deep session logic accumulates. A good rule of thumb is that `runtime-api.ts` should route and validate, then hand off to the terminal runtime, workspace logic, config helpers, or git helpers.

### Terminal runtime

The `src/terminal/` area owns everything process-oriented:

- choosing what binary to run (via the agent catalog in `src/core/agent-catalog.ts`)
- per-agent launch preparation (hooks, env, args) in `agent-session-adapters.ts`
- launching PTY sessions
- resizing and streaming terminal output
- translating process lifecycle into Kanban runtime summaries
- handling the workspace shell terminal

This is the single execution path for every supported task agent.

### Workspace and config

`src/workspace/` owns worktree creation, lookup, cleanup, and turn checkpoints.

`src/config/runtime-config.ts` owns Kanban preferences such as selected agents, shortcuts, and prompt templates.

### State streaming

`runtime-state-hub.ts` is the central fanout point for live updates. It listens to terminal summaries, workspace metadata, and workspace state changes, then broadcasts websocket messages that keep the browser in sync.

This is important because Kanban is not designed around browser polling. The runtime is long-lived and streams state outward.

## Frontend Architecture

The frontend is also easier to navigate if you think in responsibilities instead of folders.

`App.tsx` is the composition root. It wires together the major hooks, determines which high-level surfaces are visible, and hands state down into the board, detail view, dialogs, and terminal areas. It should not become a second runtime orchestrator.

Hooks in `web-ui/src/hooks/` are where most domain logic lives. This includes project navigation, workspace synchronization, task-session actions, and review behavior. If you are looking for "how does this behavior actually work?", the answer is usually in a hook, not a component.

Components in `web-ui/src/components/` are mostly rendering and composition. Good frontend changes often mean moving runtime-aware logic into hooks and leaving the component to render a view model.

`web-ui/src/runtime/` holds client-side query helpers and persistence glue. One of the guardrails we now enforce is that raw workspace TRPC client creation should stay concentrated in the runtime query helpers rather than spread through arbitrary components.

## Configuration and Persistence

Different state lives in different places on purpose.

| State | Where it lives | Why |
| --- | --- | --- |
| selected agent, shortcuts, Kanban prompt templates | Kanban runtime config | these are Kanban preferences |
| per-project UI or workflow state | workspace state or project config | this is workspace-scoped product state |
| agent credentials and provider settings | each agent CLI's own config | the CLIs already own auth and provider persistence |
| task runtime summaries | Kanban runtime memory and state stream | the board needs a lightweight product-shaped summary of current work |
| Amp Architect task origin | immutable task metadata in workspace board state | operators can return to the planning context without making Amp a lifecycle authority |

## Amp Task Planning

Task decomposition lives in Amp through the self-contained `amp/kanban.ts`
plugin. The plugin exposes typed Kanban task operations to the active Amp thread
and a command-palette action that opens a native `medium` thread for focused
decomposition. Kanban does not embed a separate planning agent in the project
sidebar. The plugin currently also starts per-task Amp Orbs and watches them for
submission; that behavior is superseded. Amp's execution role moves to one
`a1.xxlarge` integration/QA/production Orb per frozen campaign.

When that plugin creates a task, it captures the active Architect thread as
immutable `origin.kind = "amp_architect"` metadata. Worker/Orb threads remain
separate execution context. The board renders a compact human label and the
detail view exposes the supported `amp threads continue <thread-id>` command;
neither surface can update task lifecycle from Amp thread state.

The current completion path moves in-progress work to Review and hands the task
to a per-task Fixer. That is a temporary safety boundary, not the target.
Candidate-backed submit will atomically publish immutable task evidence without
starting a Fixer. Only the owning QA campaign will accept its exact frozen
member set after publishing one verified campaign revision. Generic
`done`/`trash` and UI movement remain unable to bypass acceptance.

## Main Flows

### Starting a task session

The authoritative CLI/Amp start path enqueues a generation-fenced execution
reference through Absurd. Each enqueue also carries a monotonic queue fence, so
restarting an unchanged task generation creates a distinct Absurd job instead
of returning a completed idempotency record. After admission, the bounded
Absurd worker invokes the hidden direct-start entrypoint with its Absurd attempt
ID. If that worker wins the race with receipt persistence, direct-start waits
boundedly for its exact queue fence while still rejecting source-column,
generation, and newer-attempt changes immediately. Only then does Kanban
resolve the task workspace, effective worker, and deterministic zmx session. As
the process runs, the terminal runtime emits attachment summaries and terminal
output. The runtime state hub streams those projections back to the browser.

The browser Start action uses the same enqueue boundary and receives a queued
receipt rather than manufacturing a running session summary. Its compact
execution reference also carries resume intent; after admission, direct-start
reconstructs task images and plan mode from the authoritative card. The direct
session endpoint rejects browser callers and accepts only the runtime's internal
bearer context used by the Absurd worker.

### Turn checkpoints

When a session starts (and when a hook moves a task to review), the runtime captures a best effort git checkpoint of the task worktree through the shared helper in `src/workspace/turn-checkpoints.ts`. Checkpoints power the "last turn" diff mode. Failures are swallowed on purpose: checkpointing must never block session startup or review transitions.

## Design Rules

These are the architectural rules that are most important to preserve.

- one concern should have one clear source of truth
- do not add another central remote PTY stack; the target remote worker boundary
  is Grok ACP, while local PTY/zmx support is migration code and an optional
  host-local implementation detail
- keep `runtime-api.ts` as a coordinator, not a god file
- treat the browser as a client of streamed runtime state, not the source of truth for long-running sessions
- assign harness profiles and capabilities, not model-provider identities
- treat Grok workflows, ACP streams, terminals, hooks, and Zellij as telemetry
- use Tracks for cross-project delivery and operations; do not add a parallel
  generic dashboard or mix physical workspaces into the task Board
- because this feature area currently has zero users to migrate, prefer clean replacement over backward-compatibility scaffolding

## Enforced Boundaries

Some of the highest-value rules are enforced automatically by lint.

- in the browser app, `createWorkspaceTrpcClient` is reserved for the runtime query helpers

These rules are intentionally narrow. They exist to protect the seams that are easiest to accidentally erode.

## Deliberate Tradeoffs

Not everything is perfectly generalized, and that is okay. Some current tradeoffs are intentional.

- removing Cline as a native runtime and external worker diverges from upstream
  `cline/kanban`, making upstream merges harder (see the decision record above)
- legacy Cline task records are migration input only; they are never launchable

The important thing is that these tradeoffs are now explicit. They are not random accidents spread through the codebase.

## Common Change Guide

When you are making a change, this table is often more useful than a file list.

| If you are changing... | Think about this first | Common mistake to avoid |
| --- | --- | --- |
| task startup during migration | the generation/attempt fence and selected harness boundary | extending model-specific local launch code instead of moving toward Grok ACP |
| Amp Orb execution | the frozen QA campaign and its one writable workspace | starting Amp as a task worker or recreating per-task Fixers |
| Tracks or campaign UI | Track is planning/rollup; Campaign is an explicit frozen candidate set that may cross Tracks | creating a second Operations object or nesting every Campaign under one Track |
| Zellij cockpit | exact execution/campaign focus identities from Kanban | fixed per-harness panes, newest-session discovery, or lifecycle inferred from panes |
| workspace visibility | durable workspace identity plus host observation | deriving history from task IDs or treating `missing` as deletion |
| live board updates | the runtime state hub and browser stream consumers | falling back to polling or duplicating summary logic |
| new architectural boundaries | the existing lint rules and ownership model | adding a rule that is too broad and becomes a nuisance |

## What A New Engineer Should Expect

A new engineer opening this repo will probably notice a few things quickly:

- the backend is long-lived and stateful, not a thin stateless API server
- the browser is closer to a local control client than a traditional web app
- the task system, review system, and runtime system are tightly connected
- every currently supported local task agent runs through the PTY-backed
  terminal runtime, but the accepted remote target is Grok Build over ACP
- the architecture now favors clean ownership over compatibility glue because this area did not have legacy users to preserve

If you approach the code with those assumptions, the rest of the system starts to make sense much faster.
